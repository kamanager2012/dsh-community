// AIOS Core — State Hash Engine.
//
// Produces canonical fingerprints of runtime state from audit log.
// Used for:
//   1. Divergence detection (live vs replay)
//   2. Tamper verification (hash chain)
//   3. Deterministic execution proof
//
// Design:
//   - Hash chain: each fingerprint includes the previous fingerprint's hash,
//     forming a tamper-evident chain (like a blockchain but for audit entries).
//   - Incremental computation: no need to rehash all entries.
//   - Canonical serialization: deterministic JSON with sorted keys.

import type { AuditEntry } from "../governor/audit.js";
import type { StateFingerprint } from "./schema/index.js";

// ── Extended fingerprint with chain link ───────────────────────────────────

export interface ChainedFingerprint extends StateFingerprint {
  prevHash: string | null;   // hash of the previous fingerprint in the chain
  entryCount: number;        // total entries covered by this chain point
}

// ── Hash chain ─────────────────────────────────────────────────────────────
// Maintains an incremental hash chain over audit entries.
// Each append produces a new ChainedFingerprint linked to the previous one.

export class HashChain {
  private chain: ChainedFingerprint[] = [];
  private lastHash: string | null = null;
  private entryCount = 0;

  /** Append an audit entry and return the new chained fingerprint. */
  async append(entry: AuditEntry): Promise<ChainedFingerprint> {
    this.entryCount++;
    const seq = entry.seq ?? this.entryCount;

    // Hash: previous hash + canonical representation of this entry
    const data = (this.lastHash ?? "genesis") + "|" + canonicalJson(entry);
    const hash = await sha256Hex(data);

    const fp: ChainedFingerprint = {
      seq,
      hash,
      prevHash: this.lastHash,
      entryCount: this.entryCount,
      taskId: entry.taskId,
      at: entry.at,
    };

    this.chain.push(fp);
    this.lastHash = hash;
    return fp;
  }

  /** Get the full chain of fingerprints. */
  getChain(): ChainedFingerprint[] {
    return [...this.chain];
  }

  /** Get the latest fingerprint. */
  latest(): ChainedFingerprint | null {
    return this.chain[this.chain.length - 1] ?? null;
  }

  /** Get the latest hash. */
  latestHash(): string | null {
    return this.lastHash;
  }

  /** Total entries processed. */
  count(): number {
    return this.entryCount;
  }

  /** Reset the chain. */
  reset(): void {
    this.chain = [];
    this.lastHash = null;
    this.entryCount = 0;
  }
}

// ── Chain verification ─────────────────────────────────────────────────────

export interface ChainVerificationResult {
  valid: boolean;
  length: number;
  firstSeq: number;
  lastSeq: number;
  breakAt: number | null;   // seq where chain breaks (null if valid)
  message: string;
}

/** Verify that a hash chain is intact (no tampering, no gaps). */
export async function verifyChain(
  chain: ChainedFingerprint[],
  entries: AuditEntry[],
): Promise<ChainVerificationResult> {
  if (chain.length === 0) {
    return { valid: true, length: 0, firstSeq: 0, lastSeq: 0, breakAt: null, message: "empty chain" };
  }

  // Verify each link
  for (let i = 0; i < chain.length; i++) {
    const fp = chain[i]!;

    // Check prevHash linkage
    if (i === 0) {
      if (fp.prevHash !== null) {
        return { valid: false, length: chain.length, firstSeq: chain[0]!.seq, lastSeq: chain[chain.length - 1]!.seq, breakAt: fp.seq, message: `first fingerprint has non-null prevHash: ${fp.prevHash}` };
      }
    } else {
      if (fp.prevHash !== chain[i - 1]!.hash) {
        return { valid: false, length: chain.length, firstSeq: chain[0]!.seq, lastSeq: chain[chain.length - 1]!.seq, breakAt: fp.seq, message: `prevHash mismatch at seq=${fp.seq}: expected ${chain[i - 1]!.hash}, got ${fp.prevHash}` };
      }
    }

    // Recompute hash from entry + prevHash
    const entry = entries[i];
    if (!entry) {
      return { valid: false, length: chain.length, firstSeq: chain[0]!.seq, lastSeq: chain[chain.length - 1]!.seq, breakAt: fp.seq, message: `missing entry at index ${i}` };
    }

    const data = (fp.prevHash ?? "genesis") + "|" + canonicalJson(entry);
    const computed = await sha256Hex(data);
    if (computed !== fp.hash) {
      return { valid: false, length: chain.length, firstSeq: chain[0]!.seq, lastSeq: chain[chain.length - 1]!.seq, breakAt: fp.seq, message: `hash mismatch at seq=${fp.seq}: recomputed ${computed} != stored ${fp.hash}` };
    }
  }

  return {
    valid: true,
    length: chain.length,
    firstSeq: chain[0]!.seq,
    lastSeq: chain[chain.length - 1]!.seq,
    breakAt: null,
    message: "chain intact",
  };
}

// ── Canonical serialization ────────────────────────────────────────────────
// Deterministic JSON: keys sorted, no whitespace variation.

function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "boolean" || typeof obj === "number" || typeof obj === "string") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJson).join(",") + "]";
  }
  if (typeof obj === "object") {
    const entries = Object.entries(obj as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v));
    return "{" + entries.join(",") + "}";
  }
  return "null";
}

// ── Hash computation ───────────────────────────────────────────────────────

async function sha256Hex(data: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(data, "utf8").digest("hex");
}

// ── Legacy API (backward compatible) ───────────────────────────────────────

/** Compute a state fingerprint covering audit entries up to `seq`. */
export async function computeFingerprint(
  entries: AuditEntry[],
  seq: number,
): Promise<StateFingerprint | null> {
  const relevant = entries.filter((e) => (e.seq ?? 0) <= seq);
  if (relevant.length === 0) return null;

  const lastEntry = relevant[relevant.length - 1]!;
  const canonical = canonicalJson(relevant);
  const hash = await sha256Hex(canonical);

  return { seq, hash, taskId: lastEntry.taskId, at: lastEntry.at };
}

/** Compute fingerprint for the full audit log. */
export async function computeFullFingerprint(
  entries: AuditEntry[],
): Promise<StateFingerprint | null> {
  if (entries.length === 0) return null;
  const maxSeq = Math.max(...entries.map((e) => e.seq ?? 0));
  return computeFingerprint(entries, maxSeq);
}

/** Check if two fingerprint sets are consistent. */
export function fingerprintsMatch(
  a: StateFingerprint | null,
  b: StateFingerprint | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.hash === b.hash && a.seq === b.seq;
}

/** Divergence check: compare live state hash against replay hash. */
export interface DivergenceResult {
  diverged: boolean;
  liveHash: string | null;
  replayHash: string | null;
  seq: number;
  message: string;
}

export async function checkDivergence(
  liveEntries: AuditEntry[],
  replayEntries: AuditEntry[],
  seq: number,
): Promise<DivergenceResult> {
  const liveFp = await computeFingerprint(liveEntries, seq);
  const replayFp = await computeFingerprint(replayEntries, seq);

  if (liveFp === null && replayFp === null) {
    return { diverged: false, liveHash: null, replayHash: null, seq, message: "both empty" };
  }

  if (liveFp === null || replayFp === null) {
    return {
      diverged: true,
      liveHash: liveFp?.hash ?? null,
      replayHash: replayFp?.hash ?? null,
      seq,
      message: `one side is null: live=${liveFp ? "present" : "null"} replay=${replayFp ? "present" : "null"}`,
    };
  }

  if (liveFp.hash !== replayFp.hash) {
    return {
      diverged: true,
      liveHash: liveFp.hash,
      replayHash: replayFp.hash,
      seq,
      message: `hash mismatch at seq=${seq}`,
    };
  }

  return { diverged: false, liveHash: liveFp.hash, replayHash: replayFp.hash, seq, message: "consistent" };
}
