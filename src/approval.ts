// governor-core — Approval: one-time, time-limited tokens keyed to an operation.
//
// When the engine returns "ask", it records a pending request whose id is
// derived deterministically from the ToolCall signature {tool, command, file}.
// A human grants it out-of-band (`aigov approve <id>`), which writes a token
// file with an expiry. On the next attempt of the *same* operation, if the
// token exists and is unexpired, the engine consumes it (one-time) and allows
// the call. A different operation produces a different id, so a grant can never
// authorize an unrelated action; an expired token is treated as absent.
//
// State IO is corruption-safe: writes are atomic (tmp + rename) and a file that
// fails to parse is backed up to .corrupt and treated as missing (fail-closed).

import { mkdir, writeFile, readFile, readdir, rm, rename, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { ToolCall } from "./types.js";

/** Default token lifetime once granted: 15 minutes. */
export const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Stable id for an operation: same {tool, command, file} → same id. */
export function signatureId(call: ToolCall): string {
  const sig = JSON.stringify({
    tool: call.tool,
    command: call.command ?? null,
    file: call.file ?? null,
  });
  return createHash("sha256").update(sig).digest("hex").slice(0, 16);
}

export interface PendingRequest {
  id: string;
  tool: string;
  command?: string;
  file?: string;
  reason: string;
  createdAt: string;
}

export interface GrantedToken {
  id: string;
  approvedBy: string;
  approvedAt: string;
  /** ISO timestamp after which the token is no longer valid. */
  expiresAt: string;
}

/** Default store lives under the user home so it survives across agent runs. */
export function defaultApprovalDir(): string {
  return join(homedir(), ".aigov", "approvals");
}

/** Atomic write: write to a unique temp file then rename over the target. */
async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

/** Parse JSON from a file. On corruption, back it up to .corrupt (once) and
 *  return null so the caller fails closed (treats it as absent). */
async function safeReadJson<T>(path: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    try {
      await copyFile(path, `${path}.corrupt`);
    } catch {}
    return null;
  }
}

export class ApprovalStore {
  constructor(private baseDir: string = defaultApprovalDir()) {}

  private pendingPath(id: string): string {
    return join(this.baseDir, "pending", `${id}.json`);
  }
  private tokenPath(id: string): string {
    return join(this.baseDir, "tokens", `${id}.json`);
  }

  /** Record (or refresh) a pending approval request for an asked operation. */
  async recordPending(call: ToolCall, reason: string, now: () => string): Promise<PendingRequest> {
    const id = signatureId(call);
    const req: PendingRequest = {
      id,
      ...(call.command !== undefined ? { command: call.command } : {}),
      ...(call.file !== undefined ? { file: call.file } : {}),
      tool: call.tool,
      reason,
      createdAt: now(),
    };
    await mkdir(join(this.baseDir, "pending"), { recursive: true });
    await atomicWrite(this.pendingPath(id), JSON.stringify(req, null, 2));
    return req;
  }

  async listPending(): Promise<PendingRequest[]> {
    const dir = join(this.baseDir, "pending");
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const out: PendingRequest[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const req = await safeReadJson<PendingRequest>(join(dir, f));
      if (req) out.push(req);
    }
    return out;
  }

  /** Grant approval for a pending id: write a one-time, time-limited token and
   *  clear the pending record. */
  async grant(
    id: string,
    approvedBy: string,
    now: () => string,
    ttlMs: number = DEFAULT_TOKEN_TTL_MS,
  ): Promise<GrantedToken> {
    const approvedAt = now();
    const expiresAt = new Date(Date.parse(approvedAt) + ttlMs).toISOString();
    const token: GrantedToken = { id, approvedBy, approvedAt, expiresAt };
    await mkdir(join(this.baseDir, "tokens"), { recursive: true });
    await atomicWrite(this.tokenPath(id), JSON.stringify(token, null, 2));
    await rm(this.pendingPath(id), { force: true });
    return token;
  }

  private isExpired(token: GrantedToken, now: () => string): boolean {
    const exp = Date.parse(token.expiresAt);
    if (Number.isNaN(exp)) return false; // no/invalid expiry → treat as non-expiring
    return Date.parse(now()) > exp;
  }

  /** True if a valid, unexpired token exists for this operation. */
  async hasToken(call: ToolCall, now: () => string = () => new Date().toISOString()): Promise<boolean> {
    const token = await safeReadJson<GrantedToken>(this.tokenPath(signatureId(call)));
    if (!token) return false;
    return !this.isExpired(token, now);
  }

  /** Consume the token for this operation (one-time). Returns true only if a
   *  valid, unexpired token existed. Atomic under concurrency: the token file is
   *  first renamed to a unique claim path — rename is atomic, so among racing
   *  callers exactly one wins and the losers get ENOENT and return false. This
   *  is what makes the token genuinely one-time even with concurrent hooks.
   *  Expired or corrupt claimed tokens are removed and return false (fail-closed). */
  async consume(call: ToolCall, now: () => string = () => new Date().toISOString()): Promise<boolean> {
    const src = this.tokenPath(signatureId(call));
    const claim = `${src}.${randomUUID()}.claim`;
    try {
      await rename(src, claim);
    } catch {
      // No token, or a concurrent caller already claimed it.
      return false;
    }
    const token = await safeReadJson<GrantedToken>(claim);
    await rm(claim, { force: true });
    if (!token) return false;
    return !this.isExpired(token, now);
  }
}
