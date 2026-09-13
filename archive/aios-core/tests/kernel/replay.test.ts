import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runTask, type RuntimeDeps } from "../../kernel/runtime.js";
import { ScopeValidator } from "../../governor/scope.js";
import { Rollback } from "../../governor/rollback.js";
import { AuditLog } from "../../governor/audit.js";
import { MemoryStore } from "../../memory/index.js";
import type { Plan, ProjectState } from "../../kernel/schema/index.js";
import { replayTask, replayAll, findNearestSnapshot, stateAtPoint } from "../../kernel/replay.js";
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

function makeDeps(overrides?: { plan?: Plan; execStatus?: "succeeded" | "failed"; verifyPass?: boolean }): RuntimeDeps {
  const rollback = new Rollback({
    runCommand: async () => ({ ok: true, stdout: "", stderr: "" }),
    memory,
    now: NOW,
  });
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
      planId: "p", status: overrides?.verifyPass ? "pass" : (overrides?.verifyPass === false ? "fail" : "pass"),
      testsRun: 5, testsPassed: overrides?.verifyPass === false ? 0 : 5,
      testsFailed: overrides?.verifyPass === false ? 5 : 0,
      logSummary: overrides?.verifyPass === false ? "failed" : "ok", autoFixAttempts: 0,
    }),
    scope: new ScopeValidator(),
    memory,
    rollback,
    audit,
    now: NOW,
    newId,
    readProjectState: async () => fakeProjectState,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "replay-test-"));
  memory = new MemoryStore({ root: tmpDir });
  seq = 0;
});

afterEach(async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} });

describe("Audit Replay", () => {
  it("reconstructs COMMIT trajectory from audit log", async () => {
    const deps = makeDeps();
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);

    const entries = deps.audit.filterByTask(state.taskId);
    const trajectory = replayTask(entries);

    expect(trajectory.taskId).toBe(state.taskId);
    expect(trajectory.finalDecision).toBe("COMMIT");
    expect(trajectory.committed).toBe(true);
    expect(trajectory.rolledBack).toBe(false);
    expect(trajectory.terminal).toBe(true);
    expect(trajectory.points.length).toBeGreaterThan(0);

    // Verify transitions match
    const phases = trajectory.transitions.map((t) => t.to);
    expect(phases).toContain("PLAN");
    expect(phases).toContain("EXECUTE");
    expect(phases).toContain("VERIFY");
    expect(phases).toContain("COMMIT");
  });

  it("reconstructs ROLLBACK trajectory from audit log", async () => {
    const deps = makeDeps({ execStatus: "failed" });
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);

    const entries = deps.audit.filterByTask(state.taskId);
    const trajectory = replayTask(entries);

    expect(trajectory.finalDecision).toBe("ROLLBACK");
    expect(trajectory.committed).toBe(false);
    expect(trajectory.rolledBack).toBe(true);
    expect(trajectory.terminal).toBe(true);
  });

  it("preserves plan in replay points", async () => {
    const deps = makeDeps();
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);

    const entries = deps.audit.filterByTask(state.taskId);
    const trajectory = replayTask(entries);

    const planPoint = trajectory.points.find((p) => p.plan);
    expect(planPoint).toBeDefined();
    expect(planPoint!.plan!.task).toBe("fix bug");
  });

  it("preserves execResult in replay points", async () => {
    const deps = makeDeps();
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);

    const entries = deps.audit.filterByTask(state.taskId);
    const trajectory = replayTask(entries);

    const execPoint = trajectory.points.find((p) => p.execResult);
    expect(execPoint).toBeDefined();
    expect(execPoint!.execResult!.status).toBe("succeeded");
  });

  it("preserves verifyReport in replay points", async () => {
    const deps = makeDeps();
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);

    const entries = deps.audit.filterByTask(state.taskId);
    const trajectory = replayTask(entries);

    const verifyPoint = trajectory.points.find((p) => p.verifyReport);
    expect(verifyPoint).toBeDefined();
    expect(verifyPoint!.verifyReport!.status).toBe("pass");
  });

  it("preserves snapshotId on COMMIT points", async () => {
    const deps = makeDeps();
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);

    const entries = deps.audit.filterByTask(state.taskId);
    const trajectory = replayTask(entries);

    const commitPoint = trajectory.points.find((p) => p.phase === "COMMIT");
    expect(commitPoint).toBeDefined();
    expect(commitPoint!.snapshotId).toBeTruthy();
  });

  it("replayAll separates multiple tasks", async () => {
    const deps = makeDeps();
    await runTask({ goal: "fix bug 1", project: "aios" }, deps);
    await runTask({ goal: "fix bug 2", project: "aios" }, deps);

    const allEntries = deps.audit.all();
    const trajectories = replayAll(allEntries);

    expect(trajectories.length).toBe(2);
    expect(trajectories.every((t) => t.committed)).toBe(true);
  });

  it("findNearestSnapshot returns closest snapshot before seq", async () => {
    const deps = makeDeps();
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);

    const entries = deps.audit.all();
    const commitEntry = entries.find((e) => e.snapshotId);
    expect(commitEntry).toBeDefined();

    const snapshotId = findNearestSnapshot(entries, (commitEntry!.seq ?? 0) + 10);
    expect(snapshotId).toBe(commitEntry!.snapshotId);
  });

  it("stateAtPoint reconstructs state at a given seq", async () => {
    const deps = makeDeps();
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);

    const entries = deps.audit.filterByTask(state.taskId);
    const firstEntry = entries[0]!;
    const point = stateAtPoint(entries, firstEntry.seq ?? 0);

    expect(point).toBeDefined();
    expect(point!.taskId).toBe(state.taskId);
    expect(point!.phase).toBe("PLAN");
  });

  it("empty entries produce empty trajectory", () => {
    const trajectory = replayTask([]);
    expect(trajectory.points).toEqual([]);
    expect(trajectory.terminal).toBe(false);
  });
});
