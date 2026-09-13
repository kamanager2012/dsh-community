import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { RiskLevel } from '../types/index.js';

export interface AuditRecordPayload {
  seq: number;
  timestamp: number;
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  riskLevel: RiskLevel;
  /**
   * Authorization outcome for approval records. Omitted on pure lifecycle
   * records (tool invocation start/end) where no decision has been made yet.
   */
  verdict?: 'auto_approved' | 'approved_once' | 'approved_always' | 'rejected';
  reason?: string;
  durationMs?: number;
  status?: 'success' | 'failed' | 'pending';
}

export interface ChainedAuditRecord extends AuditRecordPayload {
  prevHash: string;
  hash: string;
}

const GENESIS_HASH = '0'.repeat(64);

/**
 * Deterministic Tamper-Evident Audit Chain
 * 
 * Cryptographically chains every tool invocation, security judgment,
 * and approval decision using SHA-256 hash chaining (like governor-core / aios-core).
 */
export class DshAuditChain {
  private records: ChainedAuditRecord[] = [];
  private logPath?: string;
  /** Number of times persisting a record to disk failed (memory chain stayed intact). */
  private writeFailures = 0;

  constructor(auditDir?: string, sessionId?: string) {
    if (auditDir || sessionId) {
      const dir = auditDir || path.join(os.homedir(), '.dsh', 'audit');
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch {
          // Ignore
        }
      }
      if (sessionId) {
        this.logPath = path.join(dir, `${sessionId}.audit.jsonl`);
      }
    }
  }

  public append(payload: Omit<AuditRecordPayload, 'seq' | 'timestamp'>): ChainedAuditRecord {
    const seq = this.records.length + 1;
    const timestamp = Date.now();
    const prevHash = this.records.length > 0 ? this.records[this.records.length - 1].hash : GENESIS_HASH;

    const fullPayload: AuditRecordPayload = {
      seq,
      timestamp,
      ...payload,
    };

    const hash = this.calculateHash(fullPayload, prevHash);
    const chainedRecord: ChainedAuditRecord = {
      ...fullPayload,
      prevHash,
      hash,
    };

    this.records.push(chainedRecord);

    if (this.logPath) {
      try {
        fs.appendFileSync(this.logPath, JSON.stringify(chainedRecord) + '\n', 'utf-8');
      } catch {
        // Never lose the in-memory record, but count the persistence gap so
        // verify()/loadAndVerify() can surface that disk is behind memory.
        this.writeFailures++;
      }
    }

    return chainedRecord;
  }

  public verify(): { valid: boolean; brokenAtSeq?: number; error?: string; writeFailures: number } {
    let expectedPrevHash = GENESIS_HASH;

    for (let i = 0; i < this.records.length; i++) {
      const rec = this.records[i];

      if (rec.seq !== i + 1) {
        return { valid: false, brokenAtSeq: rec.seq, error: `Sequence mismatch at index ${i}: expected ${i + 1}, got ${rec.seq}`, writeFailures: this.writeFailures };
      }

      if (rec.prevHash !== expectedPrevHash) {
        return { valid: false, brokenAtSeq: rec.seq, error: `Hash chain broken at seq ${rec.seq}: prevHash does not match`, writeFailures: this.writeFailures };
      }

      const calculated = this.calculateHash(rec, expectedPrevHash);
      if (rec.hash !== calculated) {
        return { valid: false, brokenAtSeq: rec.seq, error: `Content altered at seq ${rec.seq}: hash mismatch`, writeFailures: this.writeFailures };
      }

      expectedPrevHash = rec.hash;
    }

    return { valid: true, writeFailures: this.writeFailures };
  }

  /**
   * Read a persisted .audit.jsonl log back and verify every link.
   *
   * Throws on any corruption: invalid JSON, seq gaps/duplicates, broken
   * prevHash linkage, or content hash mismatch. On success the in-memory
   * chain is replaced with the loaded records so subsequent append() calls
   * continue seamlessly from the file tail.
   */
  public loadAndVerify(logPath: string): { valid: boolean; loaded: number } {
    const raw = fs.readFileSync(logPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);

    const records: ChainedAuditRecord[] = [];
    let expectedPrevHash = GENESIS_HASH;

    for (let i = 0; i < lines.length; i++) {
      const fail = (msg: string): never => {
        throw new Error(`Audit log verification failed at line ${i + 1} (seq ${i + 1}): ${msg}`);
      };

      let rec: ChainedAuditRecord;
      try {
        rec = JSON.parse(lines[i]) as ChainedAuditRecord;
      } catch {
        return fail('invalid JSON');
      }

      if (!rec || typeof rec !== 'object') return fail('record is not an object');
      if (rec.seq !== i + 1) return fail(`sequence mismatch: expected ${i + 1}, got ${rec.seq}`);
      if (rec.prevHash !== expectedPrevHash) return fail('prevHash does not match chain');
      if (this.calculateHash(rec, rec.prevHash) !== rec.hash) return fail('content hash mismatch');

      records.push(rec);
      expectedPrevHash = rec.hash;
    }

    // Chain verified: resume from file tail.
    this.records = records;
    this.writeFailures = 0;
    this.logPath = logPath;

    return { valid: true, loaded: records.length };
  }

  public getRecords(): readonly ChainedAuditRecord[] {
    return this.records;
  }

  private calculateHash(payload: AuditRecordPayload, prevHash: string): string {
    const content = JSON.stringify({
      seq: payload.seq,
      timestamp: payload.timestamp,
      sessionId: payload.sessionId,
      toolName: payload.toolName,
      args: payload.args,
      riskLevel: payload.riskLevel,
      verdict: payload.verdict,
      reason: payload.reason,
      durationMs: payload.durationMs,
      status: payload.status,
      prevHash,
    });

    return createHash('sha256').update(content).digest('hex');
  }
}
