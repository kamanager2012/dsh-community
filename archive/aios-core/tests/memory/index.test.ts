import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../../memory/index.js";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";

const NOW = () => "2026-06-14T00:00:00Z";

describe("MemoryStore", () => {
  let tmpDir: string;
  let memory: MemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-test-"));
    memory = new MemoryStore({ root: tmpDir });
  });

  afterEach(async () => {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("writes and reads current state", async () => {
    await memory.writeToCurrent("project_state.json", '{"goal":"test"}');
    const data = await memory.readCurrent("project_state.json");
    expect(data).toBe('{"goal":"test"}');
  });

  it("returns undefined for missing current file", async () => {
    const data = await memory.readCurrent("nonexistent.json");
    expect(data).toBeUndefined();
  });

  it("writes to staging and commits to current", async () => {
    await memory.writeToStaging("diff.txt", "patch content");
    const { promoted, snapshotId } = await memory.commitStaging("task-1", NOW);
    expect(promoted).toContain("diff.txt");
    expect(snapshotId).toBeTruthy();
    const current = await memory.readCurrent("diff.txt");
    expect(current).toBe("patch content");
  });

  it("clears staging on commit", async () => {
    await memory.writeToStaging("a.txt", "aaa");
    await memory.commitStaging("task-1", NOW);
    const stagingFiles = await readdir(join(tmpDir, "staging")).catch(() => []);
    expect(stagingFiles.length).toBe(0);
  });

  it("clears staging on rollback", async () => {
    await memory.writeToStaging("b.txt", "bbb");
    await memory.clearStaging();
    const stagingFiles = await readdir(join(tmpDir, "staging")).catch(() => []);
    expect(stagingFiles.length).toBe(0);
  });

  it("appends task records", async () => {
    await memory.appendTask({ taskId: "T-1", status: "completed", decision: "COMMIT", at: NOW() });
    await memory.appendTask({ taskId: "T-2", status: "completed", decision: "COMMIT", at: NOW() });
    const c = memory.count();
    expect(c.tasks).toBe(2);
  });

  it("appends decision records", async () => {
    await memory.appendDecision({ id: "d-1", decision: "COMMIT", reason: "ok", at: NOW() });
    const c = memory.count();
    expect(c.decisions).toBe(1);
  });

  it("appends incident records", async () => {
    await memory.appendIncident({ id: "inc-1", taskId: "T-1", reason: "scope denied", at: NOW() });
    const c = memory.count();
    expect(c.incidents).toBe(1);
  });

  it("creates snapshot before commit", async () => {
    await memory.writeToCurrent("project_state.json", '{"goal":"v1"}');
    await memory.writeToStaging("diff.txt", "change");
    const { snapshotId } = await memory.commitStaging("task-1", NOW);
    expect(snapshotId).toMatch(/^snap_/);
    const c = memory.count();
    expect(c.snapshots).toBe(1);
  });

  it("recentTasks returns last N tasks", async () => {
    for (let i = 0; i < 5; i++) {
      await memory.appendTask({ taskId: `T-${i}`, status: "completed", decision: "COMMIT", at: NOW() });
    }
    const recent = memory.recentTasks(3);
    expect(recent.length).toBe(3);
  });

  it("recentDecisions returns last N decisions", async () => {
    for (let i = 0; i < 5; i++) {
      await memory.appendDecision({ id: `d-${i}`, decision: "COMMIT", reason: "ok", at: NOW() });
    }
    const recent = memory.recentDecisions(3);
    expect(recent.length).toBe(3);
  });

  it("persists records to disk", async () => {
    await memory.appendTask({ taskId: "T-1", status: "completed", decision: "COMMIT", at: NOW() });
    const files = await readdir(join(tmpDir, "tasks"));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^task_/);
  });

  it("recovers counters from disk on startup", async () => {
    // First instance: create records
    await memory.appendTask({ taskId: "T-1", status: "completed", decision: "COMMIT", at: NOW() });
    await memory.appendTask({ taskId: "T-2", status: "completed", decision: "COMMIT", at: NOW() });
    await memory.appendDecision({ id: "d-1", decision: "COMMIT", reason: "ok", at: NOW() });
    await memory.appendIncident({ id: "inc-1", taskId: "T-1", reason: "test", at: NOW() });
    await memory.writeToCurrent("project_state.json", '{"goal":"v1"}');
    await memory.writeToStaging("diff.txt", "change");
    await memory.commitStaging("task-1", NOW);

    expect(memory.count()).toEqual({
      tasks: 2, decisions: 1, incidents: 1, snapshots: 1,
    });

    // Second instance on same directory: counters should recover
    const memory2 = new MemoryStore({ root: tmpDir });
    // Wait for async _initFromDisk to complete
    await new Promise((r) => setTimeout(r, 100));
    const c = memory2.count();
    expect(c.tasks).toBe(2);
    expect(c.decisions).toBe(1);
    expect(c.incidents).toBe(1);
    expect(c.snapshots).toBeGreaterThanOrEqual(1);

    // Verify index is also recovered
    const recentTasks = memory2.recentTasks(5);
    expect(recentTasks.length).toBe(2);
  });

  it("does not overwrite existing files after restart", async () => {
    // Create some records
    await memory.appendTask({ taskId: "T-1", status: "done", decision: "COMMIT", at: NOW() });
    const taskFiles = await readdir(join(tmpDir, "tasks"));
    expect(taskFiles.length).toBe(1);

    // New instance on same directory should NOT overwrite existing task_0001.json
    const memory2 = new MemoryStore({ root: tmpDir });
    await new Promise((r) => setTimeout(r, 100));

    // Append new task — should be task_0002, not task_0001
    await memory2.appendTask({ taskId: "T-2", status: "done", decision: "COMMIT", at: NOW() });
    const taskFiles2 = await readdir(join(tmpDir, "tasks"));
    expect(taskFiles2.length).toBe(2);
    expect(taskFiles2).toContain("task_0001.json");
    expect(taskFiles2).toContain("task_0002.json");
  });

  it("rejects writes larger than maxFileBytes", async () => {
    const tight = new MemoryStore({ root: tmpDir, maxFileBytes: 32 });
    await expect(tight.writeToCurrent("too-big.json", "x".repeat(80))).rejects.toThrow(/maxFileBytes/);
    await expect(tight.writeToStaging("too-big.txt", "y".repeat(80))).rejects.toThrow(/maxFileBytes/);
    const missing = await tight.readCurrent("too-big.json");
    expect(missing).toBeUndefined();
  });
});
