import { describe, it, expect } from "vitest";
import { reconcile } from "../../kernel/reconciler.js";
import type { ReconciliationInput } from "../../kernel/reconciler.js";
import type { Plan, ProjectState } from "../../kernel/schema/index.js";

const now = () => "2026-06-14T00:00:00Z";
const basePlan: Plan = {
  task: "fix bug", scope: ["src/**"], risk: "low", files: ["src/fix.ts"],
  steps: [{ order: 1, action: "edit", target: "src/fix.ts" }],
  tests: ["test_fix.ts"], rollback: "git revert", approval: "AUTO",
  createdAt: now(), frozen: true,
};
const baseState: ProjectState = {
  goal: "fix bug", active_task: "task-1", branch: "main", phase: "PLAN", last_change: now(),
};

function makeInput(overrides?: Partial<ReconciliationInput>): ReconciliationInput {
  return {
    plan: basePlan,
    executeResult: { planId: "p", diff: "fix", stagingPath: "/staging", status: "succeeded", startedAt: now(), attempt: 1 },
    verifyReport: { planId: "p", status: "pass", testsRun: 5, testsPassed: 5, testsFailed: 0, logSummary: "ok", autoFixAttempts: 0 },
    projectState: baseState,
    now: now(),
    ...overrides,
  };
}

describe("reconcile", () => {
  it("verify pass → COMMIT", () => {
    const out = reconcile(makeInput());
    expect(out.decision).toBe("COMMIT");
    expect(out.memoryUpdate.current?.phase).toBe("DONE");
    expect(out.memoryUpdate.appendTask).toBeDefined();
    expect(out.memoryUpdate.appendDecision).toBeDefined();
  });

  it("executor failed → ROLLBACK", () => {
    const out = reconcile(makeInput({
      executeResult: { planId: "p", diff: "", stagingPath: "/staging", status: "failed", startedAt: now(), error: "crash", attempt: 1 },
    }));
    expect(out.decision).toBe("ROLLBACK");
    expect(out.memoryUpdate.appendIncident).toBeDefined();
  });

  it("verify fail → ROLLBACK", () => {
    const out = reconcile(makeInput({
      verifyReport: { planId: "p", status: "fail", testsRun: 5, testsPassed: 0, testsFailed: 5, logSummary: "failed", autoFixAttempts: 0 },
    }));
    expect(out.decision).toBe("ROLLBACK");
    expect(out.memoryUpdate.appendIncident).toBeDefined();
  });

  it("COMMIT sets current to DONE", () => {
    const out = reconcile(makeInput());
    expect(out.memoryUpdate.current?.phase).toBe("DONE");
    expect(out.memoryUpdate.current?.active_task).toBeNull();
  });

  it("ROLLBACK does not update current", () => {
    const out = reconcile(makeInput({
      executeResult: { planId: "p", diff: "", stagingPath: "/staging", status: "failed", startedAt: now(), error: "err", attempt: 1 },
    }));
    expect(out.memoryUpdate.current).toBeUndefined();
  });

  it("does not generate IDs — runtime assigns them", () => {
    const out = reconcile(makeInput());
    expect(out.memoryUpdate.appendTask?.taskId).toBe("task-1"); // from projectState, not generated
    expect(out.memoryUpdate.appendDecision?.id).toBeUndefined(); // no ID generated
    expect(out.memoryUpdate.appendIncident?.id).toBeUndefined(); // no ID generated
  });
});
