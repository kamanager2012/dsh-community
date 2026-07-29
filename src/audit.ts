// governor-core — Tamper-evident append-only audit.
//
// Every governance decision is recorded as a hash-chained JSONL line: each
// record embeds the hash of the previous record, so any edit, deletion, or
// reordering breaks the chain and is detectable via verifyChain().
//
// This is the core differentiator vs observability-only governance tools:
// the log is not just append-only by convention, it is cryptographically
// verifiable.

import { appendFile, readFile, mkdir, copyFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { AuditEvent, ExecutionIdentity } from "./types.js";

export interface ChainedRecord {
  seq: number;
  event: AuditEvent;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cross-process mutex via atomic mkdir. `mkdir` fails with EEXIST when the lock
 *  is held, giving us a portable lock without extra deps. Retries with small
 *  randomized backoff, reclaims a stale lock (crashed holder), and always
 *  releases in finally. Throws on timeout so the caller fails closed. */
async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const staleMs = opts.staleMs ?? 30000;
  const start = Date.now();
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // lock vanished between EEXIST and stat — retry immediately
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`could not acquire audit lock at ${lockPath} within ${timeoutMs}ms`);
      }
      await delay(10 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

/** Deterministic hash over (seq, event, prevHash). */
export function hashRecord(seq: number, event: AuditEvent, prevHash: string): string {
  const payload = JSON.stringify({ seq, event, prevHash });
  return createHash("sha256").update(payload).digest("hex");
}

export interface AuditSink {
  append(event: AuditEvent): Promise<ChainedRecord>;
}

/** In-memory sink, mainly for tests. */
export class InMemoryAuditSink implements AuditSink {
  private records: ChainedRecord[] = [];
  async append(event: AuditEvent): Promise<ChainedRecord> {
    const prev = this.records[this.records.length - 1];
    const seq = this.records.length + 1;
    const prevHash = prev ? prev.hash : GENESIS;
    const rec: ChainedRecord = { seq, event, prevHash, hash: hashRecord(seq, event, prevHash) };
    this.records.push(rec);
    return rec;
  }
  read(): readonly ChainedRecord[] {
    return this.records;
  }
}

/** File-backed hash-chained JSONL sink. */
export class FileAuditSink implements AuditSink {
  constructor(private path: string) {}

  private async tail(): Promise<ChainedRecord | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return undefined;
    }
    const lines = raw.split("\n").filter((l) => l.trim());
    const last = lines[lines.length - 1];
    if (!last) return undefined;
    try {
      return JSON.parse(last) as ChainedRecord;
    } catch {
      // Corruption-safe + fail-closed: a non-empty log whose tail is unparseable
      // must not silently restart the chain (that would fork the audit history).
      // Back it up and throw so the caller (engine) denies the action.
      try {
        await copyFile(this.path, `${this.path}.corrupt`);
      } catch {}
      throw new Error(`audit log tail is unparseable; refusing to append (backed up to ${this.path}.corrupt)`);
    }
  }

  async append(event: AuditEvent): Promise<ChainedRecord> {
    await mkdir(dirname(this.path), { recursive: true });
    return withFileLock(`${this.path}.lock`, async () => {
      const prev = await this.tail();
      const seq = prev ? prev.seq + 1 : 1;
      const prevHash = prev ? prev.hash : GENESIS;
      const rec: ChainedRecord = { seq, event, prevHash, hash: hashRecord(seq, event, prevHash) };
      await appendFile(this.path, JSON.stringify(rec) + "\n", "utf8");
      return rec;
    });
  }
}

export interface ChainVerification {
  ok: boolean;
  count: number;
  /** 1-based seq of the first broken record, if any. */
  brokenAt?: number;
  error?: string;
}

/** Recompute the chain and detect any tampering. */
export function verifyChain(records: ChainedRecord[]): ChainVerification {
  let prevHash = GENESIS;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    const expectedSeq = i + 1;
    if (r.seq !== expectedSeq) {
      return { ok: false, count: records.length, brokenAt: expectedSeq, error: `seq mismatch at index ${i}: expected ${expectedSeq}, got ${r.seq}` };
    }
    if (r.prevHash !== prevHash) {
      return { ok: false, count: records.length, brokenAt: r.seq, error: `prevHash mismatch at seq ${r.seq}` };
    }
    const recomputed = hashRecord(r.seq, r.event, r.prevHash);
    if (recomputed !== r.hash) {
      return { ok: false, count: records.length, brokenAt: r.seq, error: `hash mismatch at seq ${r.seq} (record was modified)` };
    }
    prevHash = r.hash;
  }
  return { ok: true, count: records.length };
}

/** Read and parse a hash-chained JSONL audit file. */
export async function readChain(path: string): Promise<ChainedRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ChainedRecord);
}

// ── External anchoring ──────────────────────────────────────────────────────
//
// The hash chain is tamper-EVIDENT but not tamper-PROOF: an attacker who can
// write the log file can delete it wholesale and rebuild a shorter, internally
// consistent chain, which verifyChain alone cannot catch (there is nothing left
// to compare against). An anchor pins the chain head (seq -> hash) into a
// SEPARATE store. Because each record's hash is fixed forever once written, an
// old anchor stays valid against a longer chain — but a truncated or rebuilt log
// will no longer contain the anchored seq with the anchored hash, and that is
// detectable. The anchor only helps to the degree its store is out of the
// agent's reach: a different directory raises the bar; a remote/WORM/read-only
// sink is what actually closes the gap.

export interface Anchor {
  seq: number;
  hash: string;
  timestamp: string;
}

/** Append the current chain head to an external anchor file (JSONL). */
export async function writeAnchor(
  anchorPath: string,
  head: { seq: number; hash: string },
  now: () => string,
): Promise<Anchor> {
  await mkdir(dirname(anchorPath), { recursive: true });
  const anchor: Anchor = { seq: head.seq, hash: head.hash, timestamp: now() };
  await appendFile(anchorPath, JSON.stringify(anchor) + "\n", "utf8");
  return anchor;
}

/** Read and parse an anchor file. Missing file => no anchors. */
export async function readAnchors(anchorPath: string): Promise<Anchor[]> {
  let raw: string;
  try {
    raw = await readFile(anchorPath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Anchor);
}

export interface AnchorVerification {
  ok: boolean;
  /** Number of anchors successfully matched against the chain. */
  checked: number;
  /** Anchored seq that failed, if any. */
  brokenAt?: number;
  error?: string;
}

/** Cross-check a chain against external anchors. Each anchor pins (seq -> hash);
 *  if the chain no longer contains that record with that hash, the log was
 *  truncated, rebuilt, or edited at/below the anchor point. */
export function verifyAgainstAnchor(records: ChainedRecord[], anchors: Anchor[]): AnchorVerification {
  let checked = 0;
  for (const a of anchors) {
    const rec = records.find((r) => r.seq === a.seq);
    if (!rec) {
      return {
        ok: false,
        checked,
        brokenAt: a.seq,
        error: `anchored seq ${a.seq} is missing from the chain (log truncated or rebuilt)`,
      };
    }
    if (rec.hash !== a.hash) {
      return {
        ok: false,
        checked,
        brokenAt: a.seq,
        error: `anchored hash mismatch at seq ${a.seq} (history was altered)`,
      };
    }
    checked++;
  }
  return { ok: true, checked };
}

export class AuditLog {
  constructor(private sink: AuditSink, private now: () => string, private actor: string) {}

  async record(
    mode: AuditEvent["mode"],
    action: string,
    opts: { planId?: string; reason?: string; identity?: ExecutionIdentity } = {},
  ): Promise<ChainedRecord> {
    const event: AuditEvent = {
      mode,
      actor: this.actor,
      action,
      timestamp: this.now(),
      ...(opts.planId !== undefined ? { planId: opts.planId } : {}),
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      ...(opts.identity !== undefined ? { identity: opts.identity } : {}),
    };
    return this.sink.append(event);
  }
}
