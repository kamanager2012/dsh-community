// AIOS Core — Failure classification integration with runtime.
// Tests that runtime retry loop is driven by failure taxonomy,
// not blind maxRetries count.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runTask, type RuntimeDeps } from "../../kernel/runtime.js";
import { ScopeValidator } from "../../governor/scope.js";
import { Rollback } from "../../governor/rollback.js";
import { AuditLog } from "../../governor/audit.js";
import { MemoryStore } from "../../memory/index.js";
import type { Plan, ProjectState } from "../../kernel/schema/index.js";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let memory: MemoryStore;
let seq = 0;
const NOW = () => "2026-06-14T00:00:00Z";
const newId = () => `id-${++seq}`;

const fakeProjectState: ProjectState = {
  goal: "test", active_task: null, branch: "main", phase: "IDLE", last_change: NOW(),
};

const defaultPlan: Plan = {
  task: "fix bug", scope: ["src/**"], risk: "low", files: ["src/a.ts"],
  steps: [{ order: 1, action: "edit", target: "src/a.ts" }],
  tests: ["test.ts"], rollback: "git revert", approval: "AUTO",
  createdAt: NOW(), frozen: true,
};

function makeDeps(overrides?: {
  plan?: Plan;
  execError?: string;
  execStatus?: "succeeded" | "failed";
  verifyPass?: boolean;
  maxRetries?: number;
}): RuntimeDeps {
  let execCallCount = 0;
  const rollback = new Rollback({ runCommand: async () => ({ ok: true, stdout: "", stderr: "" }), memory, now: NOW });
  const audit = new AuditLog({ memory, now: NOW, newId });
  return {
    planner: async () => ({ ...(overrides?.plan ?? defaultPlan), createdAt: NOW(), frozen: true }),
    executor: async () => {
      execCallCount++;
      // First N calls fail, then succeed (for transient retry test)
      if (overrides?.execError === "ETIMEDOUT" && execCallCount < 3) {
        return {
          planId: newId(), diff: "", stagingPath: "/staging",
          status: "failed", startedAt: NOW(), attempt: execCallCount,
          error: "ETIMEDOUT connection reset",
        };
      }
      return {
        planId: newId(), diff: overrides?.execStatus === "failed" ? "" : "fix",
        stagingPath: "/staging", status: overrides?.execStatus ?? "succeeded",
        startedAt: NOW(), attempt: execCallCount,
        ...(overrides?.execStatus === "failed" ? { error: overrides.execError ?? "crash" } : {}),
      };
    },
    verifier: async () => ({
      planId: "p", status: overrides?.verifyPass === false ? "fail" : "pass",
      testsRun: 5, testsPassed: overrides?.verifyPass === false ? 0 : 5,
      testsFailed: overrides?.verifyPass === false ? 5 : 0,
      logSummary: overrides?.verifyPass === false ? "failed" : "ok", autoFixAttempts: 0,
    }),
    scope: new ScopeValidator(), memory, rollback, audit,
    now: NOW, newId,
    readProjectState: async () => fakeProjectState,
    ...(overrides?.maxRetries !== undefined ? { maxRetries: overrides.maxRetries } : {}),
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fail-int-"));
  memory = new MemoryStore({ root: tmpDir });
  seq = 0;
});

afterEach(async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} });

describe("Failure classification in runtime", () => {
  it("scope rejection produces permission failure", async () => {
    const attackPlan: Plan = {
      task: "attack", scope: ["src/**"], risk: "low", files: ["/etc/passwd"],
      steps: [{ order: 1, action: "edit", target: "/etc/passwd" }],
      tests: [], rollback: "git revert", approval: "AUTO",
      createdAt: NOW(), frozen: true,
    };
    const deps = makeDeps({ plan: attackPlan });
    const state = await runTask({ goal: "attack", project: "aios" }, deps);
    expect(state.decision).toBe("ROLLBACK");
    expect(state.failureRecord).not.toBeNull();
    expect(state.failureRecord!.category).toBe("permission");
    expect(state.failureRecord!.recoverable).toBe(false);
  });

  it("exec failure (deterministic) produces deterministic failure record", async () => {
    const deps = makeDeps({ execStatus: "failed", execError: "build failed: type error" });
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);
    expect(state.decision).toBe("ROLLBACK");
    expect(state.failureRecord).not.toBeNull();
    expect(state.failureRecord!.category).toBe("deterministic");
    expect(state.failureRecord!.recoverable).toBe(false);
  });

  it("verify failure (deterministic) produces failure record on ROLLBACK", async () => {
    const deps = makeDeps({ verifyPass: false });
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);
    expect(state.decision).toBe("ROLLBACK");
    expect(state.failureRecord).not.toBeNull();
    expect(state.failureRecord!.category).toBe("deterministic");
  });

  it("transient error is retried (not immediately aborted)", async () => {
    const deps = makeDeps({ execError: "ETIMEDOUT", maxRetries: 5 });
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);
    // After transient failures, executor should eventually succeed
    expect(state.decision).toBe("COMMIT");
    expect(state.totalRetries).toBeGreaterThan(0);
  });

  it("non-recoverable exec failure does not retry", async () => {
    const deps = makeDeps({ execStatus: "failed", execError: "build failed: type error", maxRetries: 5 });
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);
    expect(state.decision).toBe("ROLLBACK");
    // Should not have retried — deterministic failures are not recoverable
    expect(state.totalRetries).toBe(0);
  });

  it("normal COMMIT has no failure record", async () => {
    const deps = makeDeps();
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);
    expect(state.decision).toBe("COMMIT");
    expect(state.failureRecord).toBeNull();
  });

  it("approval denial produces permission failure", async () => {
    const plan: Plan = { ...defaultPlan, approval: "MANUAL", risk: "high" };
    const deps = makeDeps({ plan });
    deps.askHuman = async () => false;
    const state = await runTask({ goal: "migrate db", project: "aios" }, deps);
    expect(state.decision).toBe("ROLLBACK");
    expect(state.failureRecord!.category).toBe("permission");
  });

  it("state fingerprint is computed on task completion", async () => {
    const deps = makeDeps();
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);
    expect(state.lastFingerprint).toBeDefined();
    expect(state.lastFingerprint).toBeTruthy();
  });
});
