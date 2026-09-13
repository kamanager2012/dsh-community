// AIOS Core — 50-task shadow run.
// Validates runtime stability under continuous execution.
// All task types that Core's 6-state machine supports.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runTask, type RuntimeDeps } from "../../kernel/runtime.js";
import { ScopeValidator } from "../../governor/scope.js";
import { Rollback } from "../../governor/rollback.js";
import { AuditLog } from "../../governor/audit.js";
import { MemoryStore } from "../../memory/index.js";
import type { Plan, ProjectState, ExecutionResult, VerificationReport, TaskRequest } from "../../kernel/schema/index.js";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Task type definitions ─────────────────────────────────────────────────

interface ShadowTask {
  id: string;
  goal: string;
  plan: Plan;
  execResult: ExecutionResult;
  verifyReport: VerificationReport;
  expectDecision: "COMMIT" | "ROLLBACK";
}

const NOW = () => "2026-06-14T00:00:00Z";
let seq = 0;
const newId = () => `id-${++seq}`;

const baseState: ProjectState = {
  goal: "shadow test", active_task: null, branch: "main", phase: "IDLE", last_change: NOW(),
};

function plan(overrides: Partial<Plan> & { approval?: "AUTO" | "MANUAL" }): Plan {
  return {
    task: "shadow", scope: ["src/**"], risk: "low", files: ["src/x.ts"],
    steps: [{ order: 1, action: "edit", target: "src/x.ts" }],
    tests: ["test_x.ts"], rollback: "git revert", approval: "AUTO",
    createdAt: NOW(), frozen: true,
    ...overrides,
  };
}

function okExec(): ExecutionResult {
  return { planId: "p", diff: "fix", stagingPath: "/staging", status: "succeeded", startedAt: NOW(), attempt: 1 };
}

function failExec(error: string): ExecutionResult {
  return { planId: "p", diff: "", stagingPath: "/staging", status: "failed", startedAt: NOW(), error, attempt: 1 };
}

function passVerify(): VerificationReport {
  return { planId: "p", status: "pass", testsRun: 5, testsPassed: 5, testsFailed: 0, logSummary: "ok", autoFixAttempts: 0 };
}

function failVerify(): VerificationReport {
  return { planId: "p", status: "fail", testsRun: 5, testsPassed: 0, testsFailed: 5, logSummary: "failed", autoFixAttempts: 0 };
}

// ── 50 tasks ──────────────────────────────────────────────────────────────

const TASKS: ShadowTask[] = [
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `A-small-${i + 1}`, goal: `SmallPatch #${i + 1}`,
    plan: plan({ task: `small patch ${i + 1}` }), execResult: okExec(), verifyReport: passVerify(), expectDecision: "COMMIT" as const,
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `A-config-${i + 1}`, goal: `Config change #${i + 1}`,
    plan: plan({ task: `config ${i + 1}`, risk: "medium", approval: "MANUAL" as const, files: ["package.json"] }),
    execResult: okExec(), verifyReport: passVerify(), expectDecision: "COMMIT" as const,
  })),
  ...Array.from({ length: 3 }, (_, i) => ({
    id: `A-migrate-${i + 1}`, goal: `Migration #${i + 1}`,
    plan: plan({ task: `migrate ${i + 1}`, risk: "high", approval: "MANUAL" as const, files: ["src/schema.ts"] }),
    execResult: okExec(), verifyReport: passVerify(), expectDecision: "COMMIT" as const,
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `A-multifile-${i + 1}`, goal: `MultiFile #${i + 1}`,
    plan: plan({ task: `multi ${i + 1}`, files: ["src/a.ts", "src/b.ts", "src/c.ts"] }),
    execResult: okExec(), verifyReport: passVerify(), expectDecision: "COMMIT" as const,
  })),
  ...Array.from({ length: 7 }, (_, i) => ({
    id: `A-dep-${i + 1}`, goal: `Dependency update #${i + 1}`,
    plan: plan({ task: `dep ${i + 1}`, risk: "medium", approval: "MANUAL" as const }),
    execResult: okExec(), verifyReport: passVerify(), expectDecision: "COMMIT" as const,
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `B-execfail-${i + 1}`, goal: `Executor crash #${i + 1}`,
    plan: plan({ task: `crash ${i + 1}` }), execResult: failExec(`crash ${i + 1}`), verifyReport: passVerify(), expectDecision: "ROLLBACK" as const,
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `B-verifyfail-${i + 1}`, goal: `Verify fail #${i + 1}`,
    plan: plan({ task: `vfail ${i + 1}` }), execResult: okExec(), verifyReport: failVerify(), expectDecision: "ROLLBACK" as const,
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `B-scope-${i + 1}`, goal: `Scope attack #${i + 1}`,
    plan: plan({ task: `scope ${i + 1}`, files: ["/etc/passwd"] }),
    execResult: okExec(), verifyReport: passVerify(), expectDecision: "ROLLBACK" as const,
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `B-manual-deny-${i + 1}`, goal: `Manual denied #${i + 1}`,
    plan: plan({ task: `deny ${i + 1}`, risk: "high", approval: "MANUAL" as const }),
    execResult: okExec(), verifyReport: passVerify(), expectDecision: "ROLLBACK" as const,
  })),
];

// ── Test infrastructure ───────────────────────────────────────────────────

let tmpDir: string;
let memory: MemoryStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "shadow50-"));
  memory = new MemoryStore({ root: tmpDir });
  seq = 0;
});

afterEach(async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} });

async function runShadow(t: ShadowTask): Promise<{ decision: string | null; terminal: boolean; reason: string }> {
  const manualDeny = t.id.includes("manual-deny");

  const rollback = new Rollback({
    runCommand: async () => ({ ok: true, stdout: "", stderr: "" }),
    memory,
    now: NOW,
  });
  const audit = new AuditLog({ memory, now: NOW, newId });

  const deps: RuntimeDeps = {
    planner: async () => ({ ...t.plan, createdAt: NOW(), frozen: true }),
    executor: async () => ({ ...t.execResult }),
    verifier: async () => ({ ...t.verifyReport }),
    scope: new ScopeValidator(),
    memory,
    rollback,
    audit,
    now: NOW,
    newId,
    askHuman: manualDeny ? async () => false : async () => true,
    readProjectState: async () => baseState,
  };

  const state = await runTask({ goal: t.goal, project: "shadow" }, deps);
  return { decision: state.decision, terminal: state.terminal, reason: state.reason };
}

describe("50-task shadow run", () => {
  it("runs all 50 tasks and produces correct decisions", async () => {
    const results: { id: string; decision: string | null; expected: string; pass: boolean }[] = [];

    for (const t of TASKS) {
      const r = await runShadow(t);
      const pass = r.decision === t.expectDecision || (t.id.includes("scope") && r.terminal && r.reason.includes("scope"));
      results.push({ id: t.id, decision: r.decision, expected: t.expectDecision, pass });
    }

    const passed = results.filter((r) => r.pass).length;
    const failed = results.filter((r) => !r.pass);

    expect(failed.length).toBe(0);
    expect(passed).toBe(50);
  });

  it("decision distribution matches expectations", async () => {
    let commits = 0;
    let rollbacks = 0;

    for (const t of TASKS) {
      const r = await runShadow(t);
      if (r.decision === "COMMIT") commits++;
      else if (r.decision === "ROLLBACK" || r.terminal) rollbacks++;
    }

    expect(commits).toBe(30);
    expect(rollbacks).toBe(20);
  });

  it("memory records are consistent", async () => {
    for (const t of TASKS) {
      await runShadow(t);
    }

    const c = memory.count();
    expect(c.tasks).toBe(30);
    expect(c.decisions).toBe(30);
    expect(c.incidents).toBe(20);
    expect(c.snapshots).toBe(30);
  });

  it("runtime is deterministic — second run produces same results", async () => {
    const run1: string[] = [];
    for (const t of TASKS) {
      const r = await runShadow(t);
      run1.push(`${t.id}:${r.decision}`);
    }

    const tmpDir2 = mkdtempSync(join(tmpdir(), "shadow50-r2-"));
    memory = new MemoryStore({ root: tmpDir2 });
    seq = 0;

    const run2: string[] = [];
    for (const t of TASKS) {
      const r = await runShadow(t);
      run2.push(`${t.id}:${r.decision}`);
    }

    expect(run2).toEqual(run1);

    try { await rm(tmpDir2, { recursive: true, force: true }); } catch {}
  });
});
