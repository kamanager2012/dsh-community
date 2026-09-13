import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AuditLog } from "../../governor/audit.js";
import { MemoryStore } from "../../memory/index.js";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let memory: MemoryStore;
let seq = 0;
const NOW = () => "2026-06-14T00:00:00Z";
const newId = () => `id-${++seq}`;

describe("AuditLog", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-test-"));
    memory = new MemoryStore({ root: tmpDir });
    seq = 0;
  });

  afterEach(async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} });

  it("appends entries with auto-incrementing seq", async () => {
    const log = new AuditLog({ memory, now: NOW, newId });
    await log.append({ seq: 0, at: "t1", taskId: "task-1", phase: "PLAN" });
    await log.append({ seq: 0, at: "t2", taskId: "task-1", phase: "EXECUTE" });
    const all = log.all();
    expect(all.length).toBe(2);
    expect(all[0]!.seq).toBe(1);
    expect(all[1]!.seq).toBe(2);
  });

  it("returns all entries", async () => {
    const log = new AuditLog({ memory, now: NOW, newId });
    await log.append({ seq: 0, at: "t1", taskId: "task-1", phase: "PLAN" });
    const all = log.all();
    expect(all.length).toBe(1);
    expect(all[0]!.phase).toBe("PLAN");
  });

  it("filters by task", async () => {
    const log = new AuditLog({ memory, now: NOW, newId });
    await log.append({ seq: 0, at: "t1", taskId: "task-1", phase: "PLAN" });
    await log.append({ seq: 0, at: "t2", taskId: "task-2", phase: "EXECUTE" });
    await log.append({ seq: 0, at: "t3", taskId: "task-1", phase: "VERIFY" });
    const filtered = log.filterByTask("task-1");
    expect(filtered.length).toBe(2);
  });

  it("returns empty for unknown task", async () => {
    const log = new AuditLog({ memory, now: NOW, newId });
    await log.append({ seq: 0, at: "t1", taskId: "task-1", phase: "PLAN" });
    expect(log.filterByTask("task-999").length).toBe(0);
  });

  it("persists entries to memory with structured data", async () => {
    const log = new AuditLog({ memory, now: NOW, newId });
    await log.append({
      seq: 0, at: "t1", taskId: "task-1", phase: "PLAN",
      fromPhase: "IDLE", toPhase: "PLAN",
      input: "fix bug",
    });
    const raw = await memory.readCurrent("audit/entry_000001.json");
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    expect(parsed.fromPhase).toBe("IDLE");
    expect(parsed.toPhase).toBe("PLAN");
    expect(parsed.input).toBe("fix bug");
    expect(parsed.seq).toBe(1);
  });

  it("recovers seq from disk before the first append after restart", async () => {
    const log1 = new AuditLog({ memory, now: NOW, newId });
    await log1.append({ at: "t1", taskId: "task-1", phase: "PLAN" });
    await log1.append({ at: "t2", taskId: "task-1", phase: "EXECUTE" });
    const first = await memory.readCurrent("audit/entry_000001.json");
    expect(first).toBeDefined();

    const log2 = new AuditLog({ memory, now: NOW, newId });
    await log2.append({ at: "t3", taskId: "task-1", phase: "VERIFY" });
    expect(log2.seq()).toBe(3);
    const stillFirst = JSON.parse((await memory.readCurrent("audit/entry_000001.json"))!);
    expect(stillFirst.phase).toBe("PLAN");
    const third = JSON.parse((await memory.readCurrent("audit/entry_000003.json"))!);
    expect(third.phase).toBe("VERIFY");
    expect(third.seq).toBe(3);
  });

  it("does not assign the same seq to concurrent appends", async () => {
    const log = new AuditLog({ memory, now: NOW, newId });
    await Promise.all([
      log.append({ at: "t1", taskId: "task-1", phase: "PLAN" }),
      log.append({ at: "t2", taskId: "task-1", phase: "EXECUTE" }),
      log.append({ at: "t3", taskId: "task-1", phase: "VERIFY" }),
    ]);
    const seqs = log.all().map((e) => e.seq);
    expect(new Set(seqs).size).toBe(3);
  });
});
