import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runTask, type RuntimeDeps } from "../../kernel/runtime.js";
import { createPlanner } from "../../kernel/planner.js";
import { createExecutor } from "../../kernel/executor.js";
import { createVerifier } from "../../kernel/verifier.js";
import { ScopeValidator } from "../../governor/scope.js";
import { Rollback } from "../../governor/rollback.js";
import { AuditLog } from "../../governor/audit.js";
import { MemoryStore } from "../../memory/index.js";
import type { Plan, ProjectState, ExecutionResult, VerificationReport } from "../../kernel/schema/index.js";
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
  goal: "build AIOS", active_task: null, branch: "main", phase: "IDLE", last_change: NOW(),
};

const defaultPlan: Plan = {
  task: "fix bug", scope: ["src/**"], risk: "low", files: ["src/fix.ts"],
  steps: [{ order: 1, action: "edit", target: "src/fix.ts" }],
  tests: ["test.ts"], rollback: "git revert", approval: "AUTO",
  createdAt: NOW(), frozen: true,
};

function makeDeps(overrides?: { plan?: Plan; execStatus?: "succeeded" | "failed"; verifyPass?: boolean; askHuman?: (plan: Plan) => Promise<boolean> }): RuntimeDeps {
  const planner = createPlanner({
    readProjectState: async () => fakeProjectState,
    modelCall: async () => "",
    now: NOW,
  });

  // Override planner to return fixed plan
  const fixedPlanner = async (_req: import("../../kernel/schema/index.js").TaskRequest): Promise<Plan> => {
    return { ...(overrides?.plan ?? defaultPlan), createdAt: NOW(), frozen: true };
  };

  const executor = createExecutor({
    applyPatch: async () => overrides?.execStatus === "failed" ? "" : "diff",
    runCommand: async () => ({ ok: overrides?.execStatus !== "failed", stdout: "", stderr: "" }),
 now: NOW,
    newId,
  });

  const verifier = createVerifier({
    runBuild: async () => ({ ok: overrides?.verifyPass ?? true, log: "" }),
    runTest: async () => ({ ok: overrides?.verifyPass ?? true, passed: overrides?.verifyPass ? 5 : 0, failed: overrides?.verifyPass ? 0 : 5, log: "" }),
    runLint: async () => ({ ok: overrides?.verifyPass ?? true, log: "" }),
    runE2E: async () => ({ ok: overrides?.verifyPass ?? true, log: "" }),
    now: NOW,
    newId,
  });

  const rollback = new Rollback({
    runCommand: async () => ({ ok: true, stdout: "", stderr: "" }),
    memory,
    now: NOW,
  });

  const audit = new AuditLog({ memory, now: NOW, newId });

  return {
    planner: fixedPlanner,
    executor,
    verifier,
    scope: new ScopeValidator(),
    memory,
    rollback,
    audit,
    now: NOW,
    newId,
    ...(overrides?.askHuman !== undefined ? { askHuman: overrides.askHuman } : {}),
    readProjectState: async () => fakeProjectState,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "core-test-"));
  memory = new MemoryStore({ root: tmpDir });
  seq = 0;
});

afterEach(async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} });

describe("Runtime", () => {
  it("IDLE→PLAN→EXECUTE→VERIFY→COMMIT→DONE", async () => {
    const state = await runTask({ goal: "fix bug", project: "aios" }, makeDeps());
    expect(state.terminal).toBe(true);
    expect(state.decision).toBe("COMMIT");
    expect(state.memoryCommitted).toBe(true);
    const phases = state.transitions.map((t) => t.to);
    expect(phases).toEqual(["PLAN", "EXECUTE", "VERIFY", "COMMIT", "DONE"]);
  });

  it("exec fail → ROLLBACK → DONE (runtime owns retry)", async () => {
    const state = await runTask({ goal: "fix bug", project: "aios" }, makeDeps({ execStatus: "failed" }));
    expect(state.terminal).toBe(true);
    expect(state.decision).toBe("ROLLBACK");
    expect(state.memoryRolledBack).toBe(true);
    const phases = state.transitions.map((t) => t.to);
    expect(phases).toContain("ROLLBACK");
    expect(phases).toContain("DONE");
  });

  it("verify fail → ROLLBACK → DONE", async () => {
    const state = await runTask({ goal: "fix bug", project: "aios" }, makeDeps({ verifyPass: false }));
    expect(state.terminal).toBe(true);
    expect(state.decision).toBe("ROLLBACK");
  });

  it("MANUAL approval denied → stops at PLAN", async () => {
    const plan: Plan = { ...defaultPlan, approval: "MANUAL", risk: "high" };
    const state = await runTask({ goal: "migrate db", project: "aios" }, makeDeps({
      plan,
      askHuman: async () => false,
    }));
    expect(state.terminal).toBe(true);
    expect(state.reason).toContain("denied");
    const phases = state.transitions.map((t) => t.to);
    expect(phases).not.toContain("EXECUTE");
  });

  it("MANUAL approval accepted → proceeds", async () => {
    const plan: Plan = { ...defaultPlan, approval: "MANUAL", risk: "high" };
    const state = await runTask({ goal: "migrate db", project: "aios" }, makeDeps({
      plan,
      askHuman: async () => true,
    }));
    expect(state.decision).toBe("COMMIT");
    const phases = state.transitions.map((t) => t.to);
    expect(phases).toContain("EXECUTE");
  });

  it("persists task and decision on COMMIT", async () => {
    await runTask({ goal: "fix bug", project: "aios" }, makeDeps());
    const c = memory.count();
    expect(c.tasks).toBe(1);
    expect(c.decisions).toBe(1);
    expect(c.snapshots).toBe(1);
  });

  it("persists incident on ROLLBACK", async () => {
    await runTask({ goal: "fix bug", project: "aios" }, makeDeps({ execStatus: "failed" }));
    expect(memory.count().incidents).toBe(1);
  });
});
