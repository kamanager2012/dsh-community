import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkInvariants } from "../../kernel/invariant.js";
import { runTask, type RuntimeDeps, type RuntimeState } from "../../kernel/runtime.js";
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

function makeDeps(overrides?: { plan?: Plan; execStatus?: "succeeded" | "failed"; verifyPass?: boolean; strictInvariants?: boolean }): RuntimeDeps {
  const rollback = new Rollback({ runCommand: async () => ({ ok: true, stdout: "", stderr: "" }), memory, now: NOW });
  const audit = new AuditLog({ memory, now: NOW, newId });
  return {
    planner: async () => ({ ...(overrides?.plan ?? defaultPlan), createdAt: NOW(), frozen: true }),
    executor: async () => ({
      planId: newId(), diff: overrides?.execStatus === "failed" ? "" : "fix",
      stagingPath: "/staging", status: overrides?.execStatus ?? "succeeded",
      startedAt: NOW(), attempt: 1,
      ...(overrides?.execStatus === "failed" ? { error: "crash" } : {}),
    }),
    verifier: async () => ({
      planId: "p", status: overrides?.verifyPass === false ? "fail" : "pass",
      testsRun: 5, testsPassed: overrides?.verifyPass === false ? 0 : 5,
      testsFailed: overrides?.verifyPass === false ? 5 : 0,
      logSummary: overrides?.verifyPass === false ? "failed" : "ok", autoFixAttempts: 0,
    }),
    scope: new ScopeValidator(), memory, rollback, audit,
    now: NOW, newId,
    readProjectState: async () => fakeProjectState,
    ...(overrides?.strictInvariants !== undefined ? { strictInvariants: overrides.strictInvariants } : {}),
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "inv-test-"));
  memory = new MemoryStore({ root: tmpDir });
  seq = 0;
});

afterEach(async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} });

describe("Invariant checks (unit)", () => {
  it("passes for a healthy COMMIT state", () => {
    const state: RuntimeState = {
      taskId: "t1", request: { goal: "test", project: "aios" },
      transitions: [
        { from: "IDLE", to: "PLAN", taskId: "t1" },
        { from: "PLAN", to: "EXECUTE", taskId: "t1" },
        { from: "EXECUTE", to: "VERIFY", taskId: "t1" },
        { from: "VERIFY", to: "COMMIT", taskId: "t1" },
      ],
      plan: { ...defaultPlan, frozen: true },
      execResult: { planId: "p", diff: "fix", stagingPath: "/staging", status: "succeeded", startedAt: NOW(), attempt: 1 },
      verifyReport: { planId: "p", status: "pass", testsRun: 5, testsPassed: 5, testsFailed: 0, logSummary: "ok", autoFixAttempts: 0 },
      decision: "COMMIT", memoryUpdate: {}, memoryCommitted: true, memoryRolledBack: false,
      terminal: true, reason: "committed",
      limitsUsed: { turns: 3, context: 0, retries: 0 },
      totalRetries: 0, totalAutoFixAttempts: 0, invariantViolations: [],
      failureRecord: null,
      hashChainLength: 0,
    };
    const result = checkInvariants(state, { from: "VERIFY", to: "COMMIT", taskId: "t1" });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("catches COMMIT without VERIFY=PASS", () => {
    const state: RuntimeState = {
      taskId: "t1", request: { goal: "test", project: "aios" },
      transitions: [{ from: "VERIFY", to: "COMMIT", taskId: "t1" }],
      plan: { ...defaultPlan, frozen: true },
      execResult: { planId: "p", diff: "fix", stagingPath: "/staging", status: "succeeded", startedAt: NOW(), attempt: 1 },
      verifyReport: { planId: "p", status: "fail", testsRun: 5, testsPassed: 0, testsFailed: 5, logSummary: "fail", autoFixAttempts: 0 },
      decision: "COMMIT", memoryUpdate: {}, memoryCommitted: false, memoryRolledBack: false,
      terminal: false, reason: "",
      limitsUsed: { turns: 0, context: 0, retries: 0 },
      totalRetries: 0, totalAutoFixAttempts: 0, invariantViolations: [],
      failureRecord: null,
      hashChainLength: 0,
    };
    const result = checkInvariants(state, { from: "VERIFY", to: "COMMIT", taskId: "t1" });
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.invariant).toBe("COMMIT_AFTER_VERIFY_PASS");
  });

  it("catches EXECUTE without plan", () => {
    const state: RuntimeState = {
      taskId: "t1", request: { goal: "test", project: "aios" },
      transitions: [{ from: "PLAN", to: "EXECUTE", taskId: "t1" }],
      plan: null, execResult: null, verifyReport: null,
      decision: null, memoryUpdate: null, memoryCommitted: false, memoryRolledBack: false,
      terminal: false, reason: "",
      limitsUsed: { turns: 0, context: 0, retries: 0 },
      totalRetries: 0, totalAutoFixAttempts: 0, invariantViolations: [],
      failureRecord: null,
      hashChainLength: 0,
    };
    const result = checkInvariants(state, { from: "PLAN", to: "EXECUTE", taskId: "t1" });
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.invariant).toBe("EXECUTE_REQUIRES_PLAN");
  });

  it("catches unfrozen plan before EXECUTE", () => {
    const state: RuntimeState = {
      taskId: "t1", request: { goal: "test", project: "aios" },
      transitions: [
        { from: "IDLE", to: "PLAN", taskId: "t1" },
        { from: "PLAN", to: "EXECUTE", taskId: "t1" },
      ],
      plan: { ...defaultPlan, frozen: false },
      execResult: null, verifyReport: null,
      decision: null, memoryUpdate: null, memoryCommitted: false, memoryRolledBack: false,
      terminal: false, reason: "",
      limitsUsed: { turns: 0, context: 0, retries: 0 },
      totalRetries: 0, totalAutoFixAttempts: 0, invariantViolations: [],
      failureRecord: null,
      hashChainLength: 0,
    };
    const result = checkInvariants(state, { from: "PLAN", to: "EXECUTE", taskId: "t1" });
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.invariant).toBe("PLAN_FROZEN_AFTER_PLAN");
  });
});

describe("Invariant checks (runtime integration)", () => {
  it("normal COMMIT passes all invariants", async () => {
    const deps = makeDeps();
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);
    expect(state.decision).toBe("COMMIT");
    expect(state.invariantViolations).toEqual([]);
  });

  it("ROLLBACK from exec failure passes all invariants", async () => {
    const deps = makeDeps({ execStatus: "failed" });
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);
    expect(state.decision).toBe("ROLLBACK");
    expect(state.invariantViolations).toEqual([]);
  });

  it("ROLLBACK from scope rejection passes all invariants", async () => {
    const attackPlan: Plan = {
      task: "attack", scope: ["src/**"], risk: "low", files: ["/etc/passwd"],
      steps: [{ order: 1, action: "edit", target: "/etc/passwd" }],
      tests: [], rollback: "git revert", approval: "AUTO",
      createdAt: NOW(), frozen: true,
    };
    const deps = makeDeps({ plan: attackPlan });
    const state = await runTask({ goal: "attack", project: "aios" }, deps);
    expect(state.decision).toBe("ROLLBACK");
    expect(state.invariantViolations).toEqual([]);
  });
});
