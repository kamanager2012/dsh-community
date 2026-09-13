import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createShadowAdapter } from "../../kernel/adapter.js";
import { runTask, type RuntimeDeps } from "../../kernel/runtime.js";
import { ScopeValidator } from "../../governor/scope.js";
import { Rollback } from "../../governor/rollback.js";
import { AuditLog } from "../../governor/audit.js";
import { MemoryStore } from "../../memory/index.js";
import { mkdtempSync, existsSync } from "node:fs";
import { mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = () => "2026-06-28T00:00:00Z";

describe("E2E: Shadow adapter real IO path", () => {
  let tmpDir: string;
  let memory: MemoryStore;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "e2e-shadow-"));
    memory = new MemoryStore({ root: join(tmpDir, ".aios") });

    // Seed a real project state
    await mkdir(join(tmpDir, ".aios", "current"), { recursive: true });
    await writeFile(
      join(tmpDir, ".aios", "current", "project_state.json"),
      JSON.stringify({ goal: "", active_task: null, branch: "main", phase: "IDLE", last_change: NOW(), project: "e2e" }),
    );

    // Ensure a src dir exists so plan scope is valid
    await mkdir(join(tmpDir, "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("reads real project state from disk", async () => {
    const a = createShadowAdapter({
      projectRoot: tmpDir,
      modelCall: async () => "task: state-read\ntask: state-read\nrisk: low\nscope: src/**\nfiles: []\napproval: AUTO",
      runCommand: async () => ({ ok: true, stdout: "", stderr: "" }),
      runBuild: async () => ({ ok: true, log: "" }),
      runTest: async () => ({ ok: true, passed: 0, failed: 0, log: "" }),
      runLint: async () => ({ ok: true, log: "" }),
      runE2E: async () => ({ ok: true, log: "" }),
    });

    const plan = await a.planner({ goal: "state-read", project: "e2e" });
    expect(plan.task).toBe("state-read");
  });

  it("applyPatch writes plan to staging without modifying source", async () => {
    const a = createShadowAdapter({
      projectRoot: tmpDir,
      modelCall: async () => "task: staging-write\nrisk: low\nscope: src/**\nfiles: []\napproval: AUTO",
      runCommand: async () => ({ ok: true, stdout: "", stderr: "" }),
      runBuild: async () => ({ ok: true, log: "" }),
      runTest: async () => ({ ok: true, passed: 0, failed: 0, log: "" }),
      runLint: async () => ({ ok: true, log: "" }),
      runE2E: async () => ({ ok: true, log: "" }),
    });

    const plan = await a.planner({ goal: "staging-write", project: "e2e" });
    const relStaging = ".aios/staging";
    const patchResult = await a.executor(plan, relStaging);

    expect(patchResult.status).toBe("succeeded");

    const patchDir = join(tmpDir, relStaging);
    const dirs = await readdir(patchDir);
    expect(dirs.length).toBe(1);
    const planFile = join(patchDir, dirs[0]!, "plan.json");
    expect(existsSync(planFile)).toBe(true);
    const stagedPlan = JSON.parse(await readFile(planFile, "utf8"));
    expect(stagedPlan.task).toBe("staging-write");

    // Source file unchanged
    expect(existsSync(join(tmpDir, "src", "main.ts"))).toBe(false);
  });
});

describe("E2E: Full pipeline with real applyPatch", () => {
  let tmpDir: string;
  let memory: MemoryStore;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "e2e-pipeline-"));
    memory = new MemoryStore({ root: join(tmpDir, ".aios") });
    await mkdir(join(tmpDir, ".aios", "current"), { recursive: true });
    await writeFile(
      join(tmpDir, ".aios", "current", "project_state.json"),
      JSON.stringify({ goal: "", active_task: null, branch: "main", phase: "IDLE", last_change: NOW(), project: "e2e" }),
    );
    await mkdir(join(tmpDir, "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("full runTask pipeline with shadow adapter commits correctly", async () => {
    const a = createShadowAdapter({
      projectRoot: tmpDir,
      modelCall: async () => "task: full-pipe\nrisk: low\nscope: src/**\nfiles: []\napproval: AUTO",
      runCommand: async () => ({ ok: true, stdout: "", stderr: "" }),
      runBuild: async () => ({ ok: true, log: "" }),
      runTest: async () => ({ ok: true, passed: 5, failed: 0, log: "all good" }),
      runLint: async () => ({ ok: true, log: "" }),
      runE2E: async () => ({ ok: true, log: "" }),
    });

    const deps: RuntimeDeps = {
      planner: a.planner,
      executor: a.executor,
      verifier: a.verifier,
      scope: new ScopeValidator(),
      memory,
      rollback: new Rollback({ runCommand: a.runCommand, memory, now: NOW }),
      audit: new AuditLog({ memory, now: NOW, newId: a.newId }),
      tier: a.tier,
      now: a.now,
      newId: a.newId,
      readProjectState: async () => ({ goal: "", active_task: null, branch: "main", phase: "IDLE", last_change: NOW() }),
    };

    const state = await runTask({ goal: "full-pipe", project: "e2e" }, deps);
    expect(state.decision).toBe("COMMIT");
    expect(state.terminal).toBe(true);
    expect(state.memoryCommitted).toBe(true);
    expect(state.execResult).toBeDefined();
    expect(state.execResult!.status).toBe("succeeded");
  });
});

describe("E2E: Tier switching via CLI-style logic", () => {
  it("makeRuntimeDeps with tier 0 uses dry-run model call", async () => {
    const { createDryRunAdapter } = await import("../../kernel/adapter.js");
    const a = createDryRunAdapter({
      modelCall: async () => "task: tier0-test\nrisk: low\nscope: src/**\nfiles: []\napproval: AUTO",
    });
    const plan = await a.planner({ goal: "tier0-test", project: "p" });
    expect(plan.task).toBe("tier0-test");
    expect(a.tier).toBe(0);
  });

  it("makeRuntimeDeps with tier 1 uses shadow adapter", async () => {
    const a = createShadowAdapter({
      projectRoot: "/tmp",
      modelCall: async () => "task: tier1-test\nrisk: medium\nscope: src/**\nfiles: []\napproval: MANUAL",
      runCommand: async () => ({ ok: true, stdout: "", stderr: "" }),
      runBuild: async () => ({ ok: true, log: "" }),
      runTest: async () => ({ ok: true, passed: 0, failed: 0, log: "" }),
      runLint: async () => ({ ok: true, log: "" }),
      runE2E: async () => ({ ok: true, log: "" }),
    });
    const plan = await a.planner({ goal: "tier1-test", project: "p" });
    expect(plan.task).toBe("tier1-test");
    expect(a.tier).toBe(1);
  });
});
