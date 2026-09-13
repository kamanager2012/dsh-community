// AIOS Core — Hash Chain and Chain Verification tests.
// Tests incremental fingerprint chain, tamper detection, and runtime integration.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HashChain, verifyChain, type ChainedFingerprint } from "../../kernel/statehash.js";
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

function makeEntry(seq: number, taskId: string, phase: string) {
  return { seq, at: NOW(), taskId, phase, _v: 1 };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "chain-"));
  memory = new MemoryStore({ root: tmpDir });
  seq = 0;
});

afterEach(async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} });

describe("HashChain", () => {
  it("builds a chain from sequential entries", async () => {
    const chain = new HashChain();
    const fp1 = await chain.append(makeEntry(1, "t1", "PLAN"));
    const fp2 = await chain.append(makeEntry(2, "t1", "EXECUTE"));
    const fp3 = await chain.append(makeEntry(3, "t1", "VERIFY"));

    expect(fp1.prevHash).toBeNull(); // genesis
    expect(fp2.prevHash).toBe(fp1.hash);
    expect(fp3.prevHash).toBe(fp2.hash);
    expect(chain.count()).toBe(3);
  });

  it("produces deterministic hashes for same input sequence", async () => {
    const chain1 = new HashChain();
    await chain1.append(makeEntry(1, "t1", "PLAN"));
    await chain1.append(makeEntry(2, "t1", "EXECUTE"));
    const fp1 = chain1.latest()!;

    const chain2 = new HashChain();
    await chain2.append(makeEntry(1, "t1", "PLAN"));
    await chain2.append(makeEntry(2, "t1", "EXECUTE"));
    const fp2 = chain2.latest()!;

    expect(fp1.hash).toBe(fp2.hash);
  });

  it("produces different hashes for different entries", async () => {
    const chain1 = new HashChain();
    await chain1.append(makeEntry(1, "t1", "PLAN"));
    const fp1 = chain1.latest()!;

    const chain2 = new HashChain();
    await chain2.append(makeEntry(1, "t1", "EXECUTE"));
    const fp2 = chain2.latest()!;

    expect(fp1.hash).not.toBe(fp2.hash);
  });

  it("tracks entry count", async () => {
    const chain = new HashChain();
    expect(chain.count()).toBe(0);
    await chain.append(makeEntry(1, "t1", "PLAN"));
    expect(chain.count()).toBe(1);
    await chain.append(makeEntry(2, "t1", "EXECUTE"));
    expect(chain.count()).toBe(2);
  });

  it("returns null for latest on empty chain", () => {
    const chain = new HashChain();
    expect(chain.latest()).toBeNull();
    expect(chain.latestHash()).toBeNull();
  });

  it("reset clears the chain", async () => {
    const chain = new HashChain();
    await chain.append(makeEntry(1, "t1", "PLAN"));
    expect(chain.count()).toBe(1);
    chain.reset();
    expect(chain.count()).toBe(0);
    expect(chain.latest()).toBeNull();
  });
});

describe("verifyChain", () => {
  it("validates an intact chain", async () => {
    const chain = new HashChain();
    const entries = [
      makeEntry(1, "t1", "PLAN"),
      makeEntry(2, "t1", "EXECUTE"),
      makeEntry(3, "t1", "VERIFY"),
    ];
    for (const e of entries) await chain.append(e);

    const result = await verifyChain(chain.getChain(), entries);
    expect(result.valid).toBe(true);
    expect(result.length).toBe(3);
    expect(result.breakAt).toBeNull();
  });

  it("detects a tampered entry", async () => {
    const chain = new HashChain();
    const entries = [
      makeEntry(1, "t1", "PLAN"),
      makeEntry(2, "t1", "EXECUTE"),
    ];
    for (const e of entries) await chain.append(e);

    // Tamper: modify the second entry
    const tampered = [entries[0]!, { ...entries[1]!, phase: "ROLLBACK" }];
    const result = await verifyChain(chain.getChain(), tampered);
    expect(result.valid).toBe(false);
    expect(result.breakAt).toBeDefined();
  });

  it("detects a broken prevHash link", async () => {
    const chain = new HashChain();
    const entries = [
      makeEntry(1, "t1", "PLAN"),
      makeEntry(2, "t1", "EXECUTE"),
    ];
    for (const e of entries) await chain.append(e);

    // Tamper: break the chain by modifying a fingerprint's prevHash
    const tamperedChain = chain.getChain();
    tamperedChain[1] = { ...tamperedChain[1]!, prevHash: "tampered" };

    const result = await verifyChain(tamperedChain, entries);
    expect(result.valid).toBe(false);
  });

  it("validates empty chain", async () => {
    const result = await verifyChain([], []);
    expect(result.valid).toBe(true);
  });

  it("detects missing entries", async () => {
    const chain = new HashChain();
    const entries = [
      makeEntry(1, "t1", "PLAN"),
      makeEntry(2, "t1", "EXECUTE"),
    ];
    for (const e of entries) await chain.append(e);

    // Provide only one entry for a chain of two
    const result = await verifyChain(chain.getChain(), [entries[0]!]);
    expect(result.valid).toBe(false);
  });
});

describe("HashChain runtime integration", () => {
  it("runtime produces hash chain when hashChain is provided", async () => {
    const hashChain = new HashChain();
    const rollback = new Rollback({ runCommand: async () => ({ ok: true, stdout: "", stderr: "" }), memory, now: NOW });
    const audit = new AuditLog({ memory, now: NOW, newId });
    const deps: RuntimeDeps = {
      planner: async () => ({ ...defaultPlan, createdAt: NOW(), frozen: true }),
      executor: async () => ({ planId: newId(), diff: "fix", stagingPath: "/staging", status: "succeeded", startedAt: NOW(), attempt: 1 }),
      verifier: async () => ({ planId: "p", status: "pass", testsRun: 5, testsPassed: 5, testsFailed: 0, logSummary: "ok", autoFixAttempts: 0 }),
      scope: new ScopeValidator(), memory, rollback, audit,
      now: NOW, newId, hashChain,
      readProjectState: async () => fakeProjectState,
    };

    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);
    expect(state.decision).toBe("COMMIT");
    expect(state.lastFingerprint).toBeTruthy();
    expect(state.hashChainLength).toBeGreaterThan(0);

    // Verify the chain is intact
    const chainResult = await verifyChain(hashChain.getChain(), audit.all());
    expect(chainResult.valid).toBe(true);
  });

  it("runtime works without hashChain (backward compatible)", async () => {
    const rollback = new Rollback({ runCommand: async () => ({ ok: true, stdout: "", stderr: "" }), memory, now: NOW });
    const audit = new AuditLog({ memory, now: NOW, newId });
    const deps: RuntimeDeps = {
      planner: async () => ({ ...defaultPlan, createdAt: NOW(), frozen: true }),
      executor: async () => ({ planId: newId(), diff: "fix", stagingPath: "/staging", status: "succeeded", startedAt: NOW(), attempt: 1 }),
      verifier: async () => ({ planId: "p", status: "pass", testsRun: 5, testsPassed: 5, testsFailed: 0, logSummary: "ok", autoFixAttempts: 0 }),
      scope: new ScopeValidator(), memory, rollback, audit,
      now: NOW, newId,
      readProjectState: async () => fakeProjectState,
    };

    const state = await runTask({ goal: "fix bug", project: "aios" }, deps);
    expect(state.decision).toBe("COMMIT");
    expect(state.lastFingerprint).toBeTruthy();
    expect(state.hashChainLength).toBe(0);
  });

  it("two identical runs with hashChain produce same final hash", async () => {
    const runOnce = (label: string) => {
      const t = mkdtempSync(join(tmpdir(), `chain-${label}-`));
      const m = new MemoryStore({ root: t });
      seq = 0;
      const hc = new HashChain();
      const a = new AuditLog({ memory: m, now: NOW, newId });
      const rb = new Rollback({ runCommand: async () => ({ ok: true, stdout: "", stderr: "" }), memory: m, now: NOW });
      return {
        deps: {
          planner: async () => ({ ...defaultPlan, createdAt: NOW(), frozen: true }),
          executor: async () => ({ planId: newId(), diff: "fix", stagingPath: "/staging", status: "succeeded", startedAt: NOW(), attempt: 1 }),
          verifier: async () => ({ planId: "p", status: "pass", testsRun: 5, testsPassed: 5, testsFailed: 0, logSummary: "ok", autoFixAttempts: 0 }),
          scope: new ScopeValidator(), memory: m, rollback: rb, audit: a, hashChain: hc,
          now: NOW, newId, readProjectState: async () => fakeProjectState,
        } as RuntimeDeps,
        hashChain: hc,
        cleanup: () => rm(t, { recursive: true, force: true }).catch(() => {}),
      };
    };

    const r1 = runOnce("1");
    const s1 = await runTask({ goal: "fix bug", project: "aios" }, r1.deps);

    const r2 = runOnce("2");
    const s2 = await runTask({ goal: "fix bug", project: "aios" }, r2.deps);

    expect(s1.lastFingerprint).toBe(s2.lastFingerprint);
    expect(s1.hashChainLength).toBe(s2.hashChainLength);

    await r1.cleanup();
    await r2.cleanup();
  });
});
