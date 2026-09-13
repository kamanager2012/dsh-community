import { describe, it, expect } from "vitest";
import {
  computeFingerprint,
  computeFullFingerprint,
  fingerprintsMatch,
  checkDivergence,
} from "../../kernel/statehash.js";
import type { AuditEntry } from "../../governor/audit.js";

function makeEntry(seq: number, taskId: string, phase: string, extra?: Partial<AuditEntry>): AuditEntry {
  return {
    seq,
    at: `2026-06-14T00:${String(seq).padStart(2, "0")}:00Z`,
    taskId,
    phase,
    ...extra,
  };
}

describe("computeFingerprint", () => {
  it("returns null for empty entries", async () => {
    const fp = await computeFingerprint([], 1);
    expect(fp).toBeNull();
  });

  it("produces a consistent hash for the same entries", async () => {
    const entries = [
      makeEntry(1, "t1", "PLAN", { fromPhase: "IDLE", toPhase: "PLAN" }),
      makeEntry(2, "t1", "EXECUTE", { fromPhase: "PLAN", toPhase: "EXECUTE" }),
    ];
    const fp1 = await computeFingerprint(entries, 2);
    const fp2 = await computeFingerprint(entries, 2);
    expect(fp1).not.toBeNull();
    expect(fp1!.hash).toBe(fp2!.hash);
  });

  it("produces different hashes for different entries", async () => {
    const entriesA = [makeEntry(1, "t1", "PLAN")];
    const entriesB = [makeEntry(1, "t1", "EXECUTE")];
    const fpA = await computeFingerprint(entriesA, 1);
    const fpB = await computeFingerprint(entriesB, 1);
    expect(fpA!.hash).not.toBe(fpB!.hash);
  });

  it("includes seq and taskId in fingerprint", async () => {
    const entries = [makeEntry(1, "t1", "PLAN")];
    const fp = await computeFingerprint(entries, 1);
    expect(fp!.seq).toBe(1);
    expect(fp!.taskId).toBe("t1");
  });
});

describe("computeFullFingerprint", () => {
  it("returns null for empty entries", async () => {
    const fp = await computeFullFingerprint([]);
    expect(fp).toBeNull();
  });

  it("covers all entries", async () => {
    const entries = [
      makeEntry(1, "t1", "PLAN"),
      makeEntry(2, "t1", "EXECUTE"),
      makeEntry(3, "t1", "VERIFY"),
    ];
    const fp = await computeFullFingerprint(entries);
    expect(fp!.seq).toBe(3);
  });
});

describe("fingerprintsMatch", () => {
  it("matches identical fingerprints", async () => {
    const entries = [makeEntry(1, "t1", "PLAN")];
    const a = await computeFingerprint(entries, 1);
    const b = await computeFingerprint(entries, 1);
    expect(fingerprintsMatch(a, b)).toBe(true);
  });

  it("rejects null vs non-null", () => {
    expect(fingerprintsMatch(null, { seq: 1, hash: "abc", taskId: "t1", at: "now" })).toBe(false);
  });

  it("matches two nulls", () => {
    expect(fingerprintsMatch(null, null)).toBe(true);
  });
});

describe("checkDivergence", () => {
  it("reports no divergence for identical logs", async () => {
    const entries = [
      makeEntry(1, "t1", "PLAN", { fromPhase: "IDLE", toPhase: "PLAN" }),
      makeEntry(2, "t1", "EXECUTE", { fromPhase: "PLAN", toPhase: "EXECUTE" }),
    ];
    const result = await checkDivergence(entries, entries, 2);
    expect(result.diverged).toBe(false);
    expect(result.liveHash).toBe(result.replayHash);
  });

  it("reports divergence for different logs", async () => {
    const live = [
      makeEntry(1, "t1", "PLAN", { fromPhase: "IDLE", toPhase: "PLAN" }),
      makeEntry(2, "t1", "EXECUTE", { fromPhase: "PLAN", toPhase: "EXECUTE" }),
    ];
    const replay = [
      makeEntry(1, "t1", "PLAN", { fromPhase: "IDLE", toPhase: "PLAN" }),
      makeEntry(2, "t1", "ROLLBACK", { fromPhase: "PLAN", toPhase: "ROLLBACK" }),
    ];
    const result = await checkDivergence(live, replay, 2);
    expect(result.diverged).toBe(true);
  });

  it("handles both-empty logs", async () => {
    const result = await checkDivergence([], [], 0);
    expect(result.diverged).toBe(false);
  });
});
