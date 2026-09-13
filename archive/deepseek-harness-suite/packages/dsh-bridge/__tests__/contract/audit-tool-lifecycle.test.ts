import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DshAgentController } from '../../src/agent/agent-controller.js';
import { DshAuditChain, type ChainedAuditRecord } from '../../src/security/audit-chain.js';
import { DshSharedSessionStore } from '../../src/session/session-store.js';
import type { DshEvent, DshToolCall } from '../../src/types/index.js';

let auditDir: string;
let sessionStoreDir: string;
let officialStoreDir: string;

beforeEach(() => {
  auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-hook-'));
  sessionStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-sessions-'));
  officialStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-official-'));
  process.env.DSH_SUITE_AUDIT_DIR = auditDir;
});

afterEach(() => {
  fs.rmSync(auditDir, { recursive: true, force: true });
  fs.rmSync(sessionStoreDir, { recursive: true, force: true });
  fs.rmSync(officialStoreDir, { recursive: true, force: true });
});

const requested = (id: string, name = 'bash', riskLevel: DshToolCall['riskLevel'] = 'medium'): DshEvent => ({
  type: 'tool:requested',
  toolCall: {
    id,
    name,
    args: { command: 'ls -la' },
    status: 'running',
    riskLevel,
    startedAt: Date.now(),
  },
});

const finished = (id: string, status: 'success' | 'failed' = 'success'): DshEvent => ({
  type: 'tool:finished',
  toolCallId: id,
  status,
  output: 'ok',
});

describe('Tool Execution Audit Trail (Reality Gate: Tamper-Evident Audit [REAL])', () => {
  it('records a start/end pair per observed tool invocation and the chain verifies', () => {
    const controller = new DshAgentController({ config: {} });

    controller.events.emitEvent(requested('call_1'));
    controller.events.emitEvent(finished('call_1'));
    controller.events.emitEvent(requested('call_2', 'read_file', 'low'));
    controller.events.emitEvent(finished('call_2', 'failed'));

    const records = controller.auditChain.getRecords();
    expect(records).toHaveLength(4);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4]);

    const [start1, end1, start2, end2] = records;

    // Start record: no verdict yet (no approval decision happened), pending status.
    expect(start1.toolName).toBe('bash');
    expect(start1.status).toBe('pending');
    expect(start1.verdict).toBeUndefined();
    expect(start1.reason).toContain('call_1');
    expect(start1.durationMs).toBeUndefined();

    // Terminal record closes the invocation with outcome + duration.
    expect(end1.toolName).toBe('bash');
    expect(end1.status).toBe('success');
    expect(typeof end1.durationMs).toBe('number');
    expect(end1.durationMs as number).toBeGreaterThanOrEqual(0);
    expect(end1.reason).toContain('call_1');

    expect(end2.toolName).toBe('read_file');
    expect(end2.status).toBe('failed');

    // All records belong to the controller's active session.
    for (const rec of records) {
      expect(rec.sessionId).toBe(controller.getSession().id);
    }

    expect(controller.auditChain.verify()).toMatchObject({ valid: true, writeFailures: 0 });
  });

  it('restart resumes the persisted chain via loadAndVerify and keeps seq continuous', () => {
    const store = new DshSharedSessionStore(officialStoreDir, sessionStoreDir);

    // First "process": run one tool through the lifecycle.
    const first = new DshAgentController({ config: {} });
    const sessionId = first.getSession().id;
    first.saveCurrentSession(store);
    first.events.emitEvent(requested('call_a', 'write_file', 'high'));
    first.events.emitEvent(finished('call_a'));

    const logPath = path.join(auditDir, `${sessionId}.audit.jsonl`);
    expect(fs.existsSync(logPath)).toBe(true);
    expect(first.auditChain.getRecords()).toHaveLength(2);

    // Second "process": resume the same logical session; its audit chain must
    // rebind to the existing log and continue from the file tail.
    const second = new DshAgentController({ config: {} });
    expect(second.resumeSessionById(sessionId, store)).toBe(true);
    expect(second.getSession().id).toBe(sessionId);
    expect(second.auditChain.getRecords()).toHaveLength(2);

    second.events.emitEvent(requested('call_b'));
    second.events.emitEvent(finished('call_b'));

    const continued = second.auditChain.getRecords();
    expect(continued.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(second.auditChain.verify()).toEqual({ valid: true, writeFailures: 0 });

    // The on-disk log holds the full continuation and re-verifies from scratch.
    const freshReader = new DshAuditChain();
    expect(freshReader.loadAndVerify(logPath)).toEqual({ valid: true, loaded: 4 });
  });

  it('quarantines a corrupted log at startup instead of rewriting or crashing', () => {
    const store = new DshSharedSessionStore(officialStoreDir, sessionStoreDir);

    const first = new DshAgentController({ config: {} });
    const sessionId = first.getSession().id;
    first.saveCurrentSession(store);
    first.events.emitEvent(requested('call_x'));

    const logPath = path.join(auditDir, `${sessionId}.audit.jsonl`);

    // Tamper with the persisted chain so loadAndVerify must fail.
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter((l) => l.trim());
    const rec = JSON.parse(lines[0]) as ChainedAuditRecord;
    rec.riskLevel = 'critical';
    fs.writeFileSync(logPath, lines.map((l) => JSON.stringify(rec)).join('\n') + '\n', 'utf-8');

    const second = new DshAgentController({ config: {} });
    expect(second.resumeSessionById(sessionId, store)).toBe(true);

    // Corrupt file preserved aside for forensics; fresh chain starts over cleanly.
    expect(fs.existsSync(logPath)).toBe(false);
    const quarantined = fs.readdirSync(auditDir).filter((f) => f.startsWith(`${sessionId}.audit.jsonl.corrupt-`));
    expect(quarantined).toHaveLength(1);
    expect(second.auditChain.getRecords()).toHaveLength(0);

    // New records append to a clean, verifiable file under the same path.
    second.events.emitEvent(requested('call_y'));
    second.events.emitEvent(finished('call_y'));
    expect(second.auditChain.verify()).toEqual({ valid: true, writeFailures: 0 });
    const freshReader = new DshAuditChain();
    expect(freshReader.loadAndVerify(logPath)).toEqual({ valid: true, loaded: 2 });
  });

  it('keeps dispatching events when disk persistence fails (writeFailures only)', () => {
    // Point the audit dir at a regular FILE: every persist attempt fails.
    const blockingFile = path.join(auditDir, 'not-a-dir');
    fs.writeFileSync(blockingFile, 'occupied', 'utf-8');
    process.env.DSH_SUITE_AUDIT_DIR = blockingFile;

    const controller = new DshAgentController({ config: {} });

    const seen: string[] = [];
    controller.events.on('tool:requested', () => seen.push('requested'));
    controller.events.on('tool:finished', () => seen.push('finished'));

    controller.events.emitEvent(requested('call_1'));
    controller.events.emitEvent(finished('call_1'));

    // Events flowed to downstream subscribers exactly once each.
    expect(seen).toEqual(['requested', 'finished']);

    // Memory chain intact and valid; persistence gap exposed, never thrown.
    const verification = controller.auditChain.verify();
    expect(verification.valid).toBe(true);
    expect(verification.writeFailures).toBe(2);
  });

  it('keeps the execution pipeline alive when append() itself throws', () => {
    const hostileChain = {
      append: () => {
        throw new Error('audit subsystem down');
      },
      getRecords: () => [],
      verify: () => ({ valid: false, writeFailures: 0 }),
    };

    const controller = new DshAgentController({
      config: {},
      auditChain: hostileChain as unknown as DshAuditChain,
    });

    // A downstream listener registered after the internal audit hooks: if the
    // audit listener threw inside emit(), this would neither run nor would
    // emitEvent() return normally.
    const seen: string[] = [];
    controller.events.onEvent((event) => {
      if (event.type === 'tool:requested') seen.push(event.type);
    });

    expect(() => controller.events.emitEvent(requested('call_1'))).not.toThrow();
    expect(() => controller.events.emitEvent(finished('call_1'))).not.toThrow();
    expect(seen).toEqual(['tool:requested']);
  });

  it('records unmatched completions without a tracked start instead of dropping them', () => {
    const controller = new DshAgentController({ config: {} });

    controller.events.emitEvent(finished('orphan_call'));

    const records = controller.auditChain.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0].toolName).toBe('unknown_tool');
    expect(records[0].status).toBe('success');
    expect(records[0].durationMs).toBeUndefined();
    expect(records[0].reason).toContain('orphan_call');
  });
});
