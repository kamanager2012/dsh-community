// AIOS Core — Audit.
// Per Charter §7: append-only log.
//
// Industrial redesign: audit entries record complete state transitions,
// enabling deterministic replay from audit log alone.
//
// Callers never pass `seq` — AuditLog assigns it automatically.

import type { MemoryStore } from "../memory/index.js";
import type { Phase, Decision, Plan, ExecutionResult, VerificationReport } from "../kernel/schema/index.js";
import { stampEntry } from "../kernel/schema_version.js";

// ── Audit Entry (enhanced for replay) ──────────────────────────────────────

export interface AuditEntry {
  // Schema version — auto-assigned by AuditLog.append. Callers must not pass this field.
  _v?: number;
  // Auto-assigned by AuditLog.append. Callers must not pass this field.
  seq?: number;
  at: string;
  taskId: string;
  phase: string;

  // Transition context
  fromPhase?: Phase | "IDLE";
  toPhase?: Phase | "IDLE";

  // Human-readable summary
  input?: string;
  execution?: string;
  result?: string;

  // Structured data for replay
  transition?: {
    from: Phase | "IDLE";
    to: Phase;
    note?: string;
  };
  plan?: Plan;
  execResult?: ExecutionResult;
  verifyReport?: VerificationReport;
  decision?: Decision;
  snapshotId?: string;

  // Retry / auto-fix tracking
  attempt?: number;
  autoFixAttempts?: number;

  // Limits at this point
  limitsUsed?: { turns: number; context: number; retries: number };
}

// ── Audit log ──────────────────────────────────────────────────────────────

export interface AuditDeps {
  memory: MemoryStore;
  now: () => string;
  newId: () => string;
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  private deps: AuditDeps | null = null;
  private _seq = 0;
  /** Resolves after disk recovery. `append` waits on this so seq cannot restart at 0. */
  private _ready: Promise<void> = Promise.resolve();
  /** Serializes appends so two concurrent callers cannot mint the same seq. */
  private _writeChain: Promise<void> = Promise.resolve();

  constructor(deps?: AuditDeps) {
    this.deps = deps ?? null;
    if (this.deps) {
      this._ready = this._recoverSeq();
    }
  }

  /** Scan `_max_seq` and `audit/entry_*.json` so a missing pointer cannot rewind seq. */
  private async _recoverSeq(): Promise<void> {
    if (!this.deps) return;
    let recovered = 0;
    try {
      const raw = await this.deps.memory.readCurrent("audit/_max_seq");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.seq === "number") recovered = parsed.seq;
      }
    } catch {
      // No existing seq file — fall through to entry scan
    }
    const files = await this.deps.memory.listCurrent("audit");
    for (const name of files) {
      const match = /^entry_(\d+)\.json$/.exec(name);
      if (match) recovered = Math.max(recovered, Number(match[1]));
    }
    if (recovered > this._seq) this._seq = recovered;
  }

  /** Persist current _seq so it survives process restart. */
  private async _persistSeq(): Promise<void> {
    if (!this.deps) return;
    try {
      await this.deps.memory.writeToCurrent("audit/_max_seq", JSON.stringify({ seq: this._seq }));
    } catch {}
  }

  async append(entry: AuditEntry): Promise<void> {
    const run = this._writeChain.then(() => this._appendUnlocked(entry));
    this._writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async _appendUnlocked(entry: AuditEntry): Promise<void> {
    await this._ready;
    this._seq++;
    const seqEntry = stampEntry({ ...entry, seq: this._seq });
    this.entries.push(seqEntry);
    if (this.deps) {
      const path = `audit/entry_${String(this._seq).padStart(6, "0")}.json`;
      await this.deps.memory.writeToCurrent(path, JSON.stringify(seqEntry, null, 2));
      await this._persistSeq();
    }
  }

  all(): AuditEntry[] {
    return [...this.entries];
  }

  filterByTask(taskId: string): AuditEntry[] {
    return this.entries.filter((e) => e.taskId === taskId);
  }

  bySeq(seq: number): AuditEntry | undefined {
    return this.entries.find((e) => e.seq === seq);
  }

  count(): number {
    return this.entries.length;
  }

  seq(): number {
    return this._seq;
  }
}
