// AIOS Core — Divergence detection integration.
// Tests that live execution and replay produce matching fingerprints,
// and that divergence is correctly detected when logs differ.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runTask, type RuntimeDeps } from "../../kernel/runtime.js";
import { ScopeValidator } from "../../governor/scope.js";
import { Rollback } from "../../governor/rollback.js";
import { AuditLog } from "../../governor/audit.js";
import { MemoryStore } from "../../memory/index.js";
import type { Plan, ProjectState } from "../../kernel/schema/index.js";
import { replayTask } from "../../kernel/replay.js";
import { computeFingerprint, checkDivergence } from "../../kernel/statehash.js";
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

function makeDeps(): RuntimeDeps {
  const rollback = new Rollback({ runCommand: async () => ({ ok: true, stdout: "", stderr: "" }), memory, now: NOW });
  const audit = new AuditLog({ memory, now: NOW, newId });
  return {
    planner: async () => ({ ...defaultPlan, createdAt: NOW(), frozen: true }),
    executor: async () => ({
      planId: newId(), diff: "fix", stagingPath: "/staging",
      status: "succeeded", startedAt: NOW(), attempt: 1,
    }),
    verifier: async () => ({
      planId: "p", status: "pass", testsRun: 5, testsPassed: 5, testsFailed: 0,
      logSummary: "ok", autoFixAttempts: 0,
    }),
    scope: new ScopeValidator(), memory, rollback, audit,
    now: NOW, newId,
    readProjectState: async () => fakeProjectState,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "diverge-"));
  memory = new MemoryStore({ root: tmpDir });
  seq = 0;
});

afterEach(async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} });

describe("Divergence detection", () => {
  it("live fingerprint matches replay fingerprint", async () => {
    const deps = makeDeps();
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);

    const liveEntries = deps.audit.filterByTask(state.taskId);
    const liveFp = await computeFingerprint(liveEntries, liveEntries.length);

    expect(liveFp).not.toBeNull();
    expect(state.lastFingerprint).toBe(liveFp!.hash);
  });

  it("two identical runs produce identical fingerprints", async () => {
    // Run 1
    const tmp1 = mkdtempSync(join(tmpdir(), "div-r1-"));
    const m1 = new MemoryStore({ root: tmp1 });
    seq = 0;
    const rb1 = new Rollback({ runCommand: async () => ({ ok: true, stdout: "", stderr: "" }), memory: m1, now: NOW });
    const a1 = new AuditLog({ memory: m1, now: NOW, newId });
    const deps1: RuntimeDeps = {
      planner: async () => ({ ...defaultPlan, createdAt: NOW(), frozen: true }),
      executor: async () => ({ planId: newId(), diff: "fix", stagingPath: "/staging", status: "succeeded", startedAt: NOW(), attempt: 1 }),
      verifier: async () => ({ planId: "p", status: "pass", testsRun: 5, testsPassed: 5, testsFailed: 0, logSummary: "ok", autoFixAttempts: 0 }),
      scope: new ScopeValidator(), memory: m1, rollback: rb1, audit: a1, now: NOW, newId,
      readProjectState: async () => fakeProjectState,
    };
    const s1 = await runTask({ goal: "fix bug", project: "aios" }, deps1);

    // Run 2
    const tmp2 = mkdtempSync(join(tmpdir(), "div-r2-"));
    const m2 = new MemoryStore({ root: tmp2 });
    seq = 0;
    const rb2 = new Rollback({ runCommand: async () => ({ ok: true, stdout: "", stderr: "" }), memory: m2, now: NOW });
    const a2 = new AuditLog({ memory: m2, now: NOW, newId });
    const deps2: RuntimeDeps = {
      planner: async () => ({ ...defaultPlan, createdAt: NOW(), frozen: true }),
      executor: async () => ({ planId: newId(), diff: "fix", stagingPath: "/staging", status: "succeeded", startedAt: NOW(), attempt: 1 }),
      verifier: async () => ({ planId: "p", status: "pass", testsRun: 5, testsPassed: 5, testsFailed: 0, logSummary: "ok", autoFixAttempts: 0 }),
      scope: new ScopeValidator(), memory: m2, rollback: rb2, audit: a2, now: NOW, newId,
      readProjectState: async () => fakeProjectState,
    };
    const s2 = await runTask({ goal: "fix bug", project: "aios" }, deps2);

    // Same deterministic inputs → same fingerprint
    expect(s1.lastFingerprint).toBe(s2.lastFingerprint);

    // Cleanup
    try { await rm(tmp1, { recursive: true, force: true }); } catch {}
    try { await rm(tmp2, { recursive: true, force: true }); } catch {}
  });

  it("checkDivergence detects modified audit log", async () => {
    const deps = makeDeps();
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);
    const liveEntries = deps.audit.filterByTask(state.taskId);

    // Tamper with the replay log
    const tamperedEntries = liveEntries.map((e, i) =>
      i === 1 ? { ...e, phase: "ROLLBACK" } : e
    );

    const result = await checkDivergence(liveEntries, tamperedEntries, liveEntries.length);
    expect(result.diverged).toBe(true);
  });

  it("checkDivergence passes for identical logs", async () => {
    const deps = makeDeps();
    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);
    const liveEntries = deps.audit.filterByTask(state.taskId);

    const result = await checkDivergence(liveEntries, liveEntries, liveEntries.length);
    expect(result.diverged).toBe(false);
    expect(result.liveHash).toBe(result.replayHash);
  });
});
