import { describe, it, expect } from "vitest";
import { createDryRunAdapter, createShadowAdapter } from "../../kernel/adapter.js";
import { runTask, type RuntimeDeps } from "../../kernel/runtime.js";
import { ScopeValidator } from "../../governor/scope.js";
import { Rollback } from "../../governor/rollback.js";
import { AuditLog } from "../../governor/audit.js";
import { MemoryStore } from "../../memory/index.js";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan, ProjectState } from "../../kernel/schema/index.js";

const NOW = () => "2026-06-28T00:00:00Z";
const fakeState: ProjectState = { goal: "adapter test", active_task: null, branch: "main", phase: "IDLE", last_change: NOW() };

describe("Adapter: createDryRunAdapter", () => {
  it("sets tier = 0", () => {
    const a = createDryRunAdapter();
    expect(a.tier).toBe(0);
  });

  it("produces a planner that returns a well-formed plan", async () => {
    const a = createDryRunAdapter({ modelCall: async () => "task: test\nrisk: low\nscope: src/**\nfiles: []\napproval: AUTO" });
    const plan = await a.planner({ goal: "test", project: "p" });
    expect(plan.task).toBe("test");
    expect(plan.risk).toBe("low");
    expect(plan.approval).toBe("AUTO");
  });

  it("executor applyPatch returns empty string", async () => {
    let captured: Plan | undefined;
    const a = createDryRunAdapter({ applyPatch: async (plan) => { captured = plan; return ""; } });
    const plan: Plan = { task: "t", scope: [], risk: "low", files: [], steps: [], tests: [], rollback: "", approval: "AUTO", createdAt: NOW(), frozen: true };
    const result = await a.executor(plan, "/staging");
    expect(captured!.task).toBe("t");
    expect(result.status).toBe("succeeded");
  });

  it("overrides modelCall via config", async () => {
    const modelCall = async () => "task: override-test\nrisk: high\nscope: src/**\nfiles: []\napproval: MANUAL";
    const a = createDryRunAdapter({ modelCall });
    const plan = await a.planner({ goal: "anything", project: "p" });
    expect(plan.task).toBe("override-test");
    expect(plan.risk).toBe("high");
    expect(plan.approval).toBe("MANUAL");
  });

  it("pipeline runs to COMMIT", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adapter0-"));
    const memory = new MemoryStore({ root: tmpDir });
    const a = createDryRunAdapter();

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
      readProjectState: async () => fakeState,
    };

    const state = await runTask({ goal: "adapter0 pipeline", project: "p" }, deps);
    expect(state.decision).toBe("COMMIT");
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });
});

describe("Adapter: createShadowAdapter", () => {
  it("sets tier = 1", () => {
    const a = createShadowAdapter({ projectRoot: "/tmp" });
    expect(a.tier).toBe(1);
  });

  it("overrides modelCall", async () => {
    const a = createShadowAdapter({
      projectRoot: "/tmp",
      modelCall: async () => "task: shadow-override\nrisk: medium\nscope: src/**\nfiles: []\napproval: MANUAL",
      runCommand: async () => ({ ok: true, stdout: "", stderr: "" }),
      runBuild: async () => ({ ok: true, log: "" }),
      runTest: async () => ({ ok: true, passed: 0, failed: 0, log: "" }),
      runLint: async () => ({ ok: true, log: "" }),
      runE2E: async () => ({ ok: true, log: "" }),
    });
    const plan = await a.planner({ goal: "shadow test", project: "p" });
    expect(plan.task).toBe("shadow-override");
    expect(plan.risk).toBe("medium");
    expect(plan.approval).toBe("MANUAL");
  });

  it("pipeline runs with overridden IO", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adapter1-"));
    const memory = new MemoryStore({ root: tmpDir });

    const a = createShadowAdapter({
      projectRoot: tmpDir,
      modelCall: async () => "task: shadow-pipeline\nrisk: low\nscope: src/**\nfiles: []\napproval: AUTO",
      runCommand: async () => ({ ok: true, stdout: "", stderr: "" }),
      runBuild: async () => ({ ok: true, log: "" }),
      runTest: async () => ({ ok: true, passed: 0, failed: 0, log: "" }),
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
      readProjectState: async () => fakeState,
    };

    const state = await runTask({ goal: "shadow pipeline", project: "p" }, deps);
    expect(state.decision).toBe("COMMIT");
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("applyPatch writes to staging without modifying source", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "adapter-staging-"));
    const memory = new MemoryStore({ root: tmpDir });

    const plan: Plan = {
      task: "staging-test", scope: ["src/**"], risk: "low",
      files: ["src/a.ts"], steps: [{ order: 1, action: "edit", target: "src/a.ts" }],
      tests: [], rollback: "git revert", approval: "AUTO",
      createdAt: NOW(), frozen: true,
    };

    const a = createShadowAdapter({
      projectRoot: tmpDir,
      modelCall: async () => "task: staging\nrisk: low\nscope: src/**\nfiles: []\napproval: AUTO",
      runCommand: async () => ({ ok: true, stdout: "", stderr: "" }),
      runBuild: async () => ({ ok: true, log: "" }),
      runTest: async () => ({ ok: true, passed: 0, failed: 0, log: "" }),
      runLint: async () => ({ ok: true, log: "" }),
      runE2E: async () => ({ ok: true, log: "" }),
      applyPatch: async (p, stagingPath) => {
        const { writeFile, mkdir } = await import("node:fs/promises");
        const { join } = await import("node:path");
        await mkdir(join(tmpDir, stagingPath, "staging-test"), { recursive: true });
        await writeFile(join(tmpDir, stagingPath, "staging-test", "plan.json"), JSON.stringify(p));
        return `wrote ${p.files.length} file(s)`;
      },
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
      readProjectState: async () => fakeState,
    };

    const state = await runTask({ goal: "staging-test", project: "p" }, deps);
    expect(state.decision).toBe("COMMIT");
    expect(state.execResult).toBeDefined();
    expect(state.execResult!.stagingPath).toBeTruthy();

    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });
});
