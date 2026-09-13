import { describe, expect, it } from "vitest";
import { replayTask, stateAtPoint } from "../../kernel/replay.js";
import type { AuditEntry } from "../../governor/audit.js";
import type { EvidenceItem, Plan, TaskContract, VerificationReport } from "../../kernel/schema/index.js";

const NOW = "2026-08-21T00:00:00Z";

const contract: TaskContract = {
  version: 1,
  requiredEvidence: ["test", "build", "diff"],
  acceptance: { minTestsPassed: 2 },
};

const passingEvidence: EvidenceItem[] = [
  { kind: "test", status: "pass", summary: "2 passed", metrics: { passed: 2, failed: 0, total: 2 } },
  { kind: "build", status: "pass", summary: "build ok" },
  { kind: "diff", status: "pass", summary: "diff present" },
];

function makePlan(withContract = true): Plan {
  return {
    task: "replay reliability",
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

function makeVerify(evidence?: EvidenceItem[]): VerificationReport {
  return {
    planId: "p",
    status: "pass",
    testsRun: 2,
    testsPassed: 2,
    testsFailed: 0,
    logSummary: "ok",
    autoFixAttempts: 0,
    ...(evidence ? { evidence } : {}),
  };
}

function auditFor(
  plan: Plan,
  verifyReport: VerificationReport,
  decision: "COMMIT" | "ROLLBACK",
): AuditEntry[] {
  return [
    {
      _v: 1,
      seq: 1,
      at: NOW,
      taskId: "task-1",
      phase: "PLAN",
      fromPhase: "IDLE",
      toPhase: "PLAN",
      plan,
    },
    {
      _v: 1,
      seq: 2,
      at: NOW,
      taskId: "task-1",
      phase: "VERIFY",
      fromPhase: "EXECUTE",
      toPhase: "VERIFY",
      verifyReport,
    },
    {
      _v: 1,
      seq: 3,
      at: NOW,
      taskId: "task-1",
      phase: decision,
      fromPhase: "VERIFY",
      toPhase: decision,
      decision,
      result: decision === "COMMIT" ? "committed" : "reliability gate incomplete",
    },
  ];
}

describe("reliability replay", () => {
  it("reconstructs PASS from the recorded contract and evidence", () => {
    const trajectory = replayTask(auditFor(makePlan(), makeVerify(passingEvidence), "COMMIT"));

    expect(trajectory.finalDecision).toBe("COMMIT");
    expect(trajectory.finalReliabilityVerdict?.status).toBe("PASS");
    expect(trajectory.points[1]?.reliabilityVerdict?.status).toBe("PASS");
    expect(trajectory.points[2]?.reliabilityVerdict?.status).toBe("PASS");
  });

  it("reconstructs cumulative contract/evidence/verdict at a later audit point", () => {
    const entries = auditFor(makePlan(), makeVerify(passingEvidence), "COMMIT");
    const point = stateAtPoint(entries, 3);

    expect(point?.phase).toBe("COMMIT");
    expect(point?.plan?.contract).toEqual(contract);
    expect(point?.verifyReport?.evidence).toEqual(passingEvidence);
    expect(point?.reliabilityVerdict?.status).toBe("PASS");
    expect(point?.decision).toBe("COMMIT");
  });

  it("reconstructs INCOMPLETE when required evidence was missing", () => {
    const missingDiff = passingEvidence.filter((item) => item.kind !== "diff");
    const trajectory = replayTask(auditFor(makePlan(), makeVerify(missingDiff), "ROLLBACK"));

    expect(trajectory.finalDecision).toBe("ROLLBACK");
    expect(trajectory.finalReliabilityVerdict?.status).toBe("INCOMPLETE");
    expect(trajectory.finalReliabilityVerdict?.missingEvidence).toContain("diff");
  });

  it("does not invent a reliability verdict for legacy tasks", () => {
    const trajectory = replayTask(auditFor(makePlan(false), makeVerify(), "COMMIT"));

    expect(trajectory.finalDecision).toBe("COMMIT");
    expect(trajectory.finalReliabilityVerdict).toBeUndefined();
    expect(trajectory.points.some((point) => point.reliabilityVerdict !== undefined)).toBe(false);
  });

  it("does not run the reliability gate when legacy verification itself failed", () => {
    const failedVerify: VerificationReport = {
      ...makeVerify(passingEvidence),
      status: "fail",
      testsPassed: 1,
      testsFailed: 1,
      logSummary: "verify failed",
    };
    const trajectory = replayTask(auditFor(makePlan(), failedVerify, "ROLLBACK"));

    expect(trajectory.finalReliabilityVerdict).toBeUndefined();
  });
});
