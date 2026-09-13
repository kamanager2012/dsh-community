import { describe, it, expect } from "vitest";
import { reconcile } from "../../kernel/reconciler.js";
import { createVerifier } from "../../kernel/verifier.js";
import {
  compareReliabilityRuns,
  evaluateReliability,
  type ReliabilityRun,
} from "../../kernel/reliability.js";
import type {
  EvidenceItem,
  Plan,
  ProjectState,
  TaskContract,
  VerificationReport,
} from "../../kernel/schema/index.js";

const NOW = "2026-08-21T00:00:00Z";

const contract: TaskContract = {
  version: 1,
  requiredEvidence: ["test", "build", "diff"],
  acceptance: { minTestsPassed: 2 },
};

const evidence: EvidenceItem[] = [
  { kind: "test", status: "pass", summary: "2 passed", metrics: { passed: 2, failed: 0, total: 2 } },
  { kind: "build", status: "pass", summary: "build ok" },
  { kind: "diff", status: "pass", summary: "diff present" },
];

const state: ProjectState = {
  goal: "reliability",
  active_task: "task-1",
  branch: "main",
  phase: "PLAN",
  last_change: NOW,
};

function plan(withContract = true): Plan {
  return {
    task: "reliability task",
    scope: ["src/**"],
    risk: "low",
    files: ["src/a.ts"],
    steps: [{ order: 1, action: "edit", target: "src/a.ts" }],
    tests: ["a.test.ts"],
    rollback: "git revert",
    approval: "AUTO",
    createdAt: NOW,
    frozen: true,
    ...(withContract ? { contract } : {}),
  };
}

function verify(items?: EvidenceItem[]): VerificationReport {
  return {
    planId: "p",
    status: "pass",
    testsRun: 2,
    testsPassed: 2,
    testsFailed: 0,
    logSummary: "ok",
    autoFixAttempts: 0,
    ...(items ? { evidence: items } : {}),
  };
}

describe("evaluateReliability", () => {
  it("passes when all required evidence is present and passing", () => {
    expect(evaluateReliability(contract, evidence).status).toBe("PASS");
  });

  it("is incomplete when required evidence is missing", () => {
    const result = evaluateReliability(contract, evidence.filter((item) => item.kind !== "diff"));
    expect(result.status).toBe("INCOMPLETE");
    expect(result.missingEvidence).toContain("diff");
  });

  it("fails when required evidence fails", () => {
    const result = evaluateReliability(contract, evidence.map((item) =>
      item.kind === "build" ? { ...item, status: "fail" as const } : item,
    ));
    expect(result.status).toBe("FAIL");
    expect(result.failedEvidence).toContain("build");
  });

  it("enforces minimum passed tests", () => {
    const result = evaluateReliability(contract, evidence.map((item) =>
      item.kind === "test"
        ? { ...item, metrics: { passed: 1, failed: 0, total: 1 } }
        : item,
    ));
    expect(result.status).toBe("FAIL");
    expect(result.reasons.some((reason) => reason.includes("tests passed 1 < required 2"))).toBe(true);
  });
});

describe("reconciler reliability gate", () => {
  const executeResult = {
    planId: "p",
    diff: "diff",
    stagingPath: "/staging",
    status: "succeeded" as const,
    startedAt: NOW,
    attempt: 1,
  };

  it("keeps legacy verify-pass behavior when no contract exists", () => {
    const result = reconcile({
      plan: plan(false),
      executeResult,
      verifyReport: verify(),
      projectState: state,
      now: NOW,
    });
    expect(result.decision).toBe("COMMIT");
    expect(result.reliabilityVerdict).toBeUndefined();
  });

  it("rolls back a contracted task when evidence is absent", () => {
    const result = reconcile({
      plan: plan(true),
      executeResult,
      verifyReport: verify(),
      projectState: state,
      now: NOW,
    });
    expect(result.decision).toBe("ROLLBACK");
    expect(result.reliabilityVerdict?.status).toBe("INCOMPLETE");
  });

  it("commits a contracted task only after evidence passes", () => {
    const result = reconcile({
      plan: plan(true),
      executeResult,
      verifyReport: verify(evidence),
      projectState: state,
      now: NOW,
    });
    expect(result.decision).toBe("COMMIT");
    expect(result.reliabilityVerdict?.status).toBe("PASS");
  });
});

describe("verifier evidence", () => {
  it("emits structured build/test/lint/e2e/diff evidence", async () => {
    const verifier = createVerifier({
      runBuild: async () => ({ ok: true, log: "build ok" }),
      runTest: async () => ({ ok: true, passed: 3, failed: 0, log: "tests ok" }),
      runLint: async () => ({ ok: true, log: "lint ok" }),
      runE2E: async () => ({ ok: true, log: "e2e ok" }),
      now: () => NOW,
      newId: () => "id",
    });

    const report = await verifier({
      planId: "p",
      diff: "diff --git a/a b/a",
      stagingPath: "/staging",
      status: "succeeded",
      startedAt: NOW,
      attempt: 1,
    });

    expect(report.status).toBe("pass");
    expect(report.evidence?.map((item) => item.kind)).toEqual([
      "test",
      "build",
      "lint",
      "e2e",
      "diff",
    ]);
  });
});

describe("compareReliabilityRuns", () => {
  function run(taskId: string, status: "PASS" | "FAIL" | "INCOMPLETE"): ReliabilityRun {
    return {
      taskId,
      project: "p",
      agent: "agent",
      model: "model",
      version: "v",
      verdict: { status, reasons: [], missingEvidence: [], failedEvidence: [] },
    };
  }

  it("separates regressions, improvements, missing and added tasks", () => {
    const baseline = [run("t1", "PASS"), run("t2", "FAIL"), run("t3", "PASS")];
    const candidate = [run("t1", "FAIL"), run("t2", "PASS"), run("t4", "PASS")];
    const report = compareReliabilityRuns(baseline, candidate);

    expect(report.regressions).toEqual([{ taskId: "t1", from: "PASS", to: "FAIL" }]);
    expect(report.improvements).toEqual([{ taskId: "t2", from: "FAIL", to: "PASS" }]);
    expect(report.missingFromCandidate).toEqual(["t3"]);
    expect(report.addedInCandidate).toEqual(["t4"]);
  });
});
