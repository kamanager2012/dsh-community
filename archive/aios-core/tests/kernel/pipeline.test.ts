// AIOS Core — End-to-end pipeline test.
// Validates the full chain: run → audit → replay → consistency.
// This is the closed-loop verification that replay matches live execution.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runTask, type RuntimeDeps, type RuntimeState } from "../../kernel/runtime.js";
import { ScopeValidator } from "../../governor/scope.js";
import { Rollback } from "../../governor/rollback.js";
import { AuditLog } from "../../governor/audit.js";
import { MemoryStore } from "../../memory/index.js";
import { replayTask, replayAll } from "../../kernel/replay.js";
import type { Plan, ProjectState, ExecutionTier } from "../../kernel/schema/index.js";
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

function makeTier0Deps(): RuntimeDeps {
  const rollback = new Rollback({ runCommand: async () => ({ ok: true, stdout: "", stderr: "" }), memory, now: NOW });
  const audit = new AuditLog({ memory, now: NOW, newId });
  return {
    planner: async () => ({
      task: "dry-run task", scope: ["src/**"], risk: "low", files: ["src/a.ts"],
      steps: [{ order: 1, action: "edit", target: "src/a.ts" }],
      tests: ["test_a.ts"], rollback: "git revert", approval: "AUTO",
      createdAt: NOW(), frozen: true,
    }),
    executor: async () => ({
      planId: newId(), diff: "dry diff", stagingPath: "/staging",
      status: "succeeded", startedAt: NOW(), attempt: 1,
    }),
    verifier: async () => ({
      planId: "p", status: "pass", testsRun: 5, testsPassed: 5, testsFailed: 0,
      logSummary: "dry-run ok", autoFixAttempts: 0,
    }),
    scope: new ScopeValidator(), memory, rollback, audit,
    tier: 0 as ExecutionTier, now: NOW, newId,
    readProjectState: async () => fakeProjectState,
  };
}

function makeTier1Deps(failExec?: boolean, failVerify?: boolean): RuntimeDeps {
  const rollback = new Rollback({ runCommand: async () => ({ ok: true, stdout: "", stderr: "" }), memory, now: NOW });
  const audit = new AuditLog({ memory, now: NOW, newId });
  return {
    planner: async () => ({
      task: "shadow task", scope: ["src/**"], risk: "low", files: ["src/b.ts"],
      steps: [{ order: 1, action: "edit", target: "src/b.ts" }],
      tests: ["test_b.ts"], rollback: "git revert", approval: "AUTO",
      createdAt: NOW(), frozen: true,
    }),
    executor: async () => ({
      planId: newId(), diff: failExec ? "" : "shadow diff", stagingPath: "/staging",
      status: failExec ? "failed" : "succeeded", startedAt: NOW(), attempt: 1,
      ...(failExec ? { error: "shadow exec crash" } : {}),
    }),
    verifier: async () => ({
      planId: "p", status: failVerify ? "fail" : "pass",
      testsRun: 5, testsPassed: failVerify ? 0 : 5, testsFailed: failVerify ? 5 : 0,
      logSummary: failVerify ? "shadow verify failed" : "shadow ok", autoFixAttempts: 0,
    }),
    scope: new ScopeValidator(), memory, rollback, audit,
    tier: 1 as ExecutionTier, now: NOW, newId,
    readProjectState: async () => fakeProjectState,
  };
}

// ── Consistency check ──────────────────────────────────────────────────────

function verifyConsistency(liveState: RuntimeState, audit: AuditLog): void {
  const entries = audit.filterByTask(liveState.taskId);
  const trajectory = replayTask(entries);

  // Decision must match
  expect(trajectory.finalDecision).toBe(liveState.decision);

  // Terminal status must match
  expect(trajectory.terminal).toBe(liveState.terminal);

  // Commit/rollback must match
  expect(trajectory.committed).toBe(liveState.memoryCommitted);
  expect(trajectory.rolledBack).toBe(liveState.memoryRolledBack);

  // Replay transitions must be a subset of live transitions
  // (audit captures fromPhase→toPhase for key transitions only)
  const liveTransitions = liveState.transitions.map((t) => `${t.from}->${t.to}`);
  const replayTransitions = trajectory.transitions.map((t) => `${t.from}->${t.to}`);
  for (const rt of replayTransitions) {
    expect(liveTransitions).toContain(rt);
  }

  // Plan must be captured in replay
  const planPoint = trajectory.points.find((p) => p.plan);
  expect(planPoint).toBeDefined();
  expect(planPoint!.plan!.task).toBe(liveState.plan!.task);

  // ExecResult must be captured
  if (liveState.execResult) {
    const execPoint = trajectory.points.find((p) => p.execResult);
    expect(execPoint).toBeDefined();
    expect(execPoint!.execResult!.status).toBe(liveState.execResult.status);
  }

  // VerifyReport must be captured
  if (liveState.verifyReport) {
    const verifyPoint = trajectory.points.find((p) => p.verifyReport);
    expect(verifyPoint).toBeDefined();
    expect(verifyPoint!.verifyReport!.status).toBe(liveState.verifyReport.status);
  }

  // Snapshot must be captured on COMMIT
  if (liveState.memoryCommitted) {
    const commitPoint = trajectory.points.find((p) => p.snapshotId);
    expect(commitPoint).toBeDefined();
    expect(commitPoint!.snapshotId).toBeTruthy();
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pipeline-test-"));
  memory = new MemoryStore({ root: tmpDir });
  seq = 0;
});

afterEach(async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} });

describe("Pipeline: Tier 0 dry-run", () => {
  it("runs dry-run pipeline and replay matches live", async () => {
    const deps = makeTier0Deps();
    const state = await runTask({ goal: "dry-run test", project: "aios" }, deps);
    expect(state.decision).toBe("COMMIT");
    verifyConsistency(state, deps.audit);
  });
});

describe("Pipeline: Tier 1 shadow", () => {
  it("runs shadow pipeline (COMMIT) and replay matches live", async () => {
    const deps = makeTier1Deps();
    const state = await runTask({ goal: "shadow test", project: "aios" }, deps);
    expect(state.decision).toBe("COMMIT");
    verifyConsistency(state, deps.audit);
  });

  it("runs shadow pipeline (exec fail → ROLLBACK) and replay matches live", async () => {
    const deps = makeTier1Deps(true);
    const state = await runTask({ goal: "shadow fail test", project: "aios" }, deps);
    expect(state.decision).toBe("ROLLBACK");
    verifyConsistency(state, deps.audit);
  });

  it("runs shadow pipeline (verify fail → ROLLBACK) and replay matches live", async () => {
    const deps = makeTier1Deps(false, true);
    const state = await runTask({ goal: "shadow verify fail", project: "aios" }, deps);
    expect(state.decision).toBe("ROLLBACK");
    verifyConsistency(state, deps.audit);
  });
});

describe("Pipeline: multi-task closed loop", () => {
  it("runs 3 tasks, replays all, each trajectory matches live", async () => {
    const states: RuntimeState[] = [];
    const audits: AuditLog[] = [];

    // Task 1: COMMIT
    const deps1 = makeTier0Deps();
    const state1 = await runTask({ goal: "task 1", project: "aios" }, deps1);
    expect(state1.decision).toBe("COMMIT");
    states.push(state1);
    audits.push(deps1.audit);
    verifyConsistency(state1, deps1.audit);

    // Task 2: ROLLBACK (scope)
    const scopeRejectPlan: Plan = {
      task: "attack", scope: ["src/**"], risk: "low", files: ["/etc/passwd"],
      steps: [{ order: 1, action: "edit", target: "/etc/passwd" }],
      tests: [], rollback: "git revert", approval: "AUTO",
      createdAt: NOW(), frozen: true,
    };
    const deps2: RuntimeDeps = {
      planner: async () => scopeRejectPlan,
      executor: async () => ({ planId: newId(), diff: "", stagingPath: "/staging", status: "succeeded", startedAt: NOW(), attempt: 1 }),
      verifier: async () => ({ planId: "p", status: "pass", testsRun: 0, testsPassed: 0, testsFailed: 0, logSummary: "", autoFixAttempts: 0 }),
      scope: new ScopeValidator(), memory,
      rollback: new Rollback({ runCommand: async () => ({ ok: true, stdout: "", stderr: "" }), memory, now: NOW }),
      audit: new AuditLog({ memory, now: NOW, newId }),
      tier: 0 as ExecutionTier, now: NOW, newId,
      readProjectState: async () => fakeProjectState,
    };
    const state2 = await runTask({ goal: "attack /etc/passwd", project: "aios" }, deps2);
    expect(state2.decision).toBe("ROLLBACK");
    states.push(state2);
    audits.push(deps2.audit);
    verifyConsistency(state2, deps2.audit);

    // Task 3: COMMIT
    const deps3 = makeTier1Deps();
    const state3 = await runTask({ goal: "shadow task 3", project: "aios" }, deps3);
    expect(state3.decision).toBe("COMMIT");
    states.push(state3);
    audits.push(deps3.audit);
    verifyConsistency(state3, deps3.audit);

    // Replay all from combined audit log
    const allEntries = audits.flatMap((a) => a.all());
    const trajectories = replayAll(allEntries);
    expect(trajectories.length).toBe(3);

    for (const state of states) {
      const match = trajectories.find((t) => t.taskId === state.taskId);
      expect(match).toBeDefined();
      expect(match!.finalDecision).toBe(state.decision);
      expect(match!.committed).toBe(state.memoryCommitted);
      expect(match!.rolledBack).toBe(state.memoryRolledBack);
      expect(match!.terminal).toBe(state.terminal);
    }
  });
});

describe("Pipeline: state fingerprint", () => {
  it("replay trajectory has deterministic fingerprint across two runs", async () => {
    const runOnce = (label: string) => {
      const t = mkdtempSync(join(tmpdir(), `finger-${label}-`));
      const m = new MemoryStore({ root: t });
      seq = 0;
      const a = new AuditLog({ memory: m, now: NOW, newId });
      return {
        deps: {
          planner: async () => ({
            task: "fingerprint test", scope: ["src/**"], risk: "low", files: ["src/f.ts"],
            steps: [{ order: 1, action: "edit", target: "src/f.ts" }],
            tests: ["test_f.ts"], rollback: "git revert", approval: "AUTO",
            createdAt: NOW(), frozen: true,
          }),
          executor: async () => ({ planId: newId(), diff: "fp", stagingPath: "/staging", status: "succeeded", startedAt: NOW(), attempt: 1 }),
          verifier: async () => ({ planId: "p", status: "pass", testsRun: 5, testsPassed: 5, testsFailed: 0, logSummary: "ok", autoFixAttempts: 0 }),
          scope: new ScopeValidator(), memory: m,
          rollback: new Rollback({ runCommand: async () => ({ ok: true, stdout: "", stderr: "" }), memory: m, now: NOW }),
          audit: a, now: NOW, newId,
          readProjectState: async () => fakeProjectState,
        } as RuntimeDeps,
        audit: a,
        cleanup: () => rm(t, { recursive: true, force: true }).catch(() => {}),
      };
    };

    const r1 = runOnce("1");
    const s1 = await runTask({ goal: "fp test", project: "aios" }, r1.deps);
    const t1 = replayTask(r1.audit.filterByTask(s1.taskId));

    const r2 = runOnce("2");
    const s2 = await runTask({ goal: "fp test", project: "aios" }, r2.deps);
    const t2 = replayTask(r2.audit.filterByTask(s2.taskId));

    const fp1 = t1.transitions.map((t) => `${t.from}->${t.to}`).join(",");
    const fp2 = t2.transitions.map((t) => `${t.from}->${t.to}`).join(",");
    expect(fp1).toBe(fp2);
    expect(t1.finalDecision).toBe(t2.finalDecision);
    expect(t1.committed).toBe(t2.committed);

    await r1.cleanup();
    await r2.cleanup();
  });
});
