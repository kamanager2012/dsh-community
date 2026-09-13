import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildContext, DEFAULT_CONTEXT_CONFIG } from "../../memory/context.js";
import { MemoryStore } from "../../memory/index.js";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = () => "2026-06-14T00:00:00Z";

describe("buildContext", () => {
  let tmpDir: string;
  let memory: MemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ctx-test-"));
    memory = new MemoryStore({ root: tmpDir });
  });

  afterEach(async () => {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("returns default current state when no project_state.json", async () => {
    const ctx = await buildContext(memory, null);
    expect(ctx.current.phase).toBe("IDLE");
    expect(ctx.current.active_task).toBeNull();
  });

  it("reads current state from project_state.json", async () => {
    await memory.writeToCurrent("project_state.json", JSON.stringify({
      goal: "build auth", active_task: "T-1", branch: "feature/auth",
      phase: "EXECUTE", last_change: NOW(),
    }));
    const ctx = await buildContext(memory, null);
    expect(ctx.current.goal).toBe("build auth");
    expect(ctx.current.phase).toBe("EXECUTE");
  });

  it("includes recent tasks", async () => {
    await memory.appendTask({ taskId: "T-1", status: "completed", decision: "COMMIT", at: NOW() });
    await memory.appendTask({ taskId: "T-2", status: "completed", decision: "COMMIT", at: NOW() });
    const ctx = await buildContext(memory, null, { recentTasksCount: 2, recentDecisionsCount: 5 });
    expect(ctx.recentTasks.length).toBe(2);
  });

  it("includes recent decisions", async () => {
    await memory.appendDecision({ id: "d-1", decision: "COMMIT", reason: "verified", at: NOW() });
    await memory.appendDecision({ id: "d-2", decision: "ROLLBACK", reason: "scope", at: NOW() });
    const ctx = await buildContext(memory, null, { recentTasksCount: 3, recentDecisionsCount: 5 });
    expect(ctx.recentDecisions.length).toBe(2);
  });

  it("reads architecture from architecture.json", async () => {
    await memory.writeToCurrent("architecture.json", JSON.stringify({
      backend: "node", frontend: "react",
    }));
    const ctx = await buildContext(memory, null);
    expect(ctx.architecture.backend).toBe("node");
  });

  it("activeTask falls back to current.active_task", async () => {
    await memory.writeToCurrent("project_state.json", JSON.stringify({
      goal: "", active_task: "T-99", branch: "main", phase: "PLAN", last_change: NOW(),
    }));
    const ctx = await buildContext(memory, null);
    expect(ctx.activeTask).toBe("T-99");
  });

  it("activeTask uses explicit taskId when provided", async () => {
    await memory.writeToCurrent("project_state.json", JSON.stringify({
      goal: "", active_task: "T-99", branch: "main", phase: "PLAN", last_change: NOW(),
    }));
    const ctx = await buildContext(memory, "T-EXPLICIT");
    expect(ctx.activeTask).toBe("T-EXPLICIT");
  });

  it("respects custom context config", async () => {
    for (let i = 0; i < 10; i++) {
      await memory.appendTask({ taskId: `T-${i}`, status: "completed", decision: "COMMIT", at: NOW() });
    }
    const ctx = await buildContext(memory, null, { recentTasksCount: 3, recentDecisionsCount: 5 });
    expect(ctx.recentTasks.length).toBe(3);
  });
});
