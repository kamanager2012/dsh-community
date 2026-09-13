import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, vi } from 'vitest';
import { DshEventStream } from '../../src/events/event-stream.js';
import { DshAgentController } from '../../src/agent/agent-controller.js';
import { DshSubprocessManager } from '../../src/runtime/subprocess-manager.js';
import { DshContextGuard } from '../../src/agent/context-guard.js';
import { DshSharedSessionStore } from '../../src/session/session-store.js';
import { DshAuditChain } from '../../src/security/audit-chain.js';
import { DshDoctor } from '../../src/runtime/doctor.js';
import { DshPluginCatalogClient } from '../../src/marketplace/plugin-catalog.js';
import { DshProviderManager } from '../../src/providers/provider-presets.js';
import { DshCheckpointEngine } from '../../src/checkpoint/checkpoint-engine.js';
import { DshTranscriptExporter } from '../../src/export/transcript-exporter.js';
import { DshIgnoreMatcher } from '../../src/security/dsh-ignore.js';
import { DshRiskEvaluator } from '../../src/security/risk-evaluator.js';
import type { DshEvent } from '../../src/types/index.js';

// Controller-managed audit chains must stay out of the real user home during
// tests; point the suite audit dir at an isolated temp location before any
// DshAgentController is constructed.
process.env.DSH_SUITE_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-contract-audit-'));

describe('DSH Bridge Contract Tests', () => {
  describe('Event Normalization & Projection', () => {
    it('normalizes streaming reasoning/thought events correctly', () => {
      const stream = new DshEventStream();
      const events: DshEvent[] = [];
      stream.onEvent((e) => events.push(e));

      // Simulate raw upstream DSH reasoning chunk
      stream.projectRawUpstreamEvent({
        type: 'agent.thought',
        delta: 'Analyzing the repository...',
        content: 'Analyzing the repository...',
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'stream:reasoning',
        delta: 'Analyzing the repository...',
        fullContent: 'Analyzing the repository...',
      });
    });

    it('auto-approves safe read-only tools without prompting for approval', () => {
      const stream = new DshEventStream();
      const events: DshEvent[] = [];
      stream.onEvent((e) => events.push(e));

      // Safe read-only inspection tool
      stream.projectRawUpstreamEvent({
        type: 'tool.call',
        id: 'call_safe_1',
        name: 'read_file',
        args: { path: '/home/project/src/main.ts' },
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool:requested');
      if (events[0].type === 'tool:requested') {
        expect(events[0].toolCall.status).toBe('running');
        expect(events[0].toolCall.riskLevel).toBe('low');
      }

      // Safe shell inspection command
      const stream2 = new DshEventStream();
      const events2: DshEvent[] = [];
      stream2.onEvent((e) => events2.push(e));

      stream2.projectRawUpstreamEvent({
        type: 'tool.call',
        id: 'call_safe_2',
        name: 'run_command',
        args: { command: 'git status' },
      });

      expect(events2).toHaveLength(1);
      expect(events2[0].type).toBe('tool:requested');
      if (events2[0].type === 'tool:requested') {
        expect(events2[0].toolCall.status).toBe('running');
        expect(events2[0].toolCall.riskLevel).toBe('low');
      }
    });

    it('accurately classifies capability semantics instead of relying on string prefix', () => {
      // Safe-sounding name with destructive and credential keywords
      const eval1 = DshRiskEvaluator.evaluate('get_password_and_delete_account', {});
      expect(eval1.capabilities).toContain('credential:read');
      expect(eval1.capabilities).toContain('fs:delete');
      expect(eval1.riskLevel).toBe('critical');
      expect(eval1.requiresApproval).toBe(true);

      // Safe read tool
      const eval2 = DshRiskEvaluator.evaluate('read_file', { path: '/project/src/index.ts' });
      expect(eval2.capabilities).toContain('fs:read');
      expect(eval2.riskLevel).toBe('low');
      expect(eval2.requiresApproval).toBe(false);
    });

    it('rejects compound shell commands, pipes, and file redirections from auto-safe bypass', () => {
      // 1. Compound chaining (&&)
      const evalCompound = DshRiskEvaluator.evaluate('run_command', { command: 'git status && touch hacked.txt' });
      expect(evalCompound.riskLevel).toBe('high');
      expect(evalCompound.requiresApproval).toBe(true);

      // 2. Output redirection (>)
      const evalRedirect = DshRiskEvaluator.evaluate('run_command', { command: 'echo hello > important.txt' });
      expect(evalRedirect.riskLevel).toBe('high');
      expect(evalRedirect.requiresApproval).toBe(true);

      // 3. Pipe operator (|)
      const evalPipe = DshRiskEvaluator.evaluate('run_command', { command: 'ls | grep secret' });
      expect(evalPipe.riskLevel).toBe('high');
      expect(evalPipe.requiresApproval).toBe(true);

      // 4. Pure single read-only command (should auto-approve)
      const evalSafeGit = DshRiskEvaluator.evaluate('run_command', { command: 'git status' });
      expect(evalSafeGit.riskLevel).toBe('low');
      expect(evalSafeGit.requiresApproval).toBe(false);
    });

    it('fails closed on wire-supplied unrestricted policy for destructive or sensitive tools', () => {
      // 1. Evaluator semantics: even an explicitly passed 'unrestricted' policy must
      //    never bypass critical-command-pattern and .dshignore credential guards.
      const evalRm = DshRiskEvaluator.evaluate('run_command', { command: 'rm -rf /' }, undefined, 'unrestricted');
      expect(evalRm.riskLevel).toBe('critical');
      expect(evalRm.requiresApproval).toBe(true);

      const evalEnv = DshRiskEvaluator.evaluate('read_file', { path: '/workspace/.env' }, undefined, 'unrestricted');
      expect(evalEnv.riskLevel).toBe('critical');
      expect(evalEnv.requiresApproval).toBe(true);

      // 2. Wire projection end-to-end: approvalPolicy:'unrestricted' from raw upstream
      //    data must be rejected (whitelist fallback to auto_safe), so rm -rf /
      //    still requires human approval.
      const stream = new DshEventStream();
      const events: DshEvent[] = [];
      stream.onEvent((e) => events.push(e));

      stream.projectRawUpstreamEvent({
        type: 'tool/call',
        id: 'call_evil_wire_1',
        name: 'run_command',
        args: { command: 'rm -rf /' },
        approvalPolicy: 'unrestricted',
      });

      expect(events.find((e) => e.type === 'tool:approval_needed')).toBeDefined();
      const requested = events.find((e) => e.type === 'tool:requested');
      if (requested && requested.type === 'tool:requested') {
        expect(requested.toolCall.status).toBe('pending_approval');
        expect(requested.toolCall.riskLevel).toBe('critical');
      }
    });

    it('requires approval for test-runner execution because test files run arbitrary code', () => {
      // vitest/jest execute whatever lives in config files, setupFiles, and the
      // tests themselves — they must not ride the read-only auto-approve list.
      for (const cmd of [
        'vitest run',
        'vitest run src/security',
        'vitest run --config ./evil.config.ts',
      ]) {
        const evaluation = DshRiskEvaluator.evaluate('run_command', { command: cmd });
        expect(evaluation.riskLevel).toBe('high');
        expect(evaluation.requiresApproval).toBe(true);
      }
    });

    it('normalizes TPS and token usage metrics', () => {
      const stream = new DshEventStream();
      let capturedMetrics: any = null;

      stream.on('stream:metrics', (e) => {
        capturedMetrics = e.metrics;
      });

      stream.projectRawUpstreamEvent({
        type: 'metrics.update',
        prompt_tokens: 1500,
        completion_tokens: 300,
        total_tokens: 1800,
        tokens_per_second: 48.5,
        contextLimit: 128000,
        contextUsagePercent: 1.4,
      });

      expect(capturedMetrics).toEqual({
        promptTokens: 1500,
        completionTokens: 300,
        totalTokens: 1800,
        tps: 48.5,
        contextLimit: 128000,
        contextUsagePercent: 1.4,
      });
    });
  });

  describe('Agent Controller State Machine', () => {
    it('manages prompt submission and status transitions', async () => {
      const mockRuntimeClient = {
        executeTurn: async () => ({ content: 'Mock refactor output', reasoning: 'Thinking...' }),
        interrupt: () => {},
      } as any;

      const controller = new DshAgentController({
        config: { model: 'deepseek-chat' },
        runtimeClient: mockRuntimeClient,
      });

      const statuses: string[] = [];
      controller.events.on('agent:status', (e) => statuses.push(e.status));

      expect(controller.getStatus()).toBe('idle');
      expect(controller.getSession().messages).toHaveLength(0);

      await controller.submitPrompt('Refactor the desktop client');

      expect(statuses).toContain('thinking');
      expect(controller.getSession().messages.length).toBeGreaterThanOrEqual(2);
      expect(controller.getSession().messages[0].content).toBe('Refactor the desktop client');
      expect(controller.getSession().messages[1].content).toBe('Mock refactor output');
    });

    it('handles interactive approval resolution', async () => {
      const controller = new DshAgentController({ config: {} });

      const approvalPromise = controller.registerApproval('appr_999');
      controller.respondApproval('appr_999', 'allow_once');

      const result = await approvalPromise;
      expect(result).toBe('allow_once');
    });

    it('supports Esc-like rewind and session forking without mutating old state', async () => {
      const controller = new DshAgentController({ config: {} });
      const session = controller.getSession();

      session.messages.push(
        { id: '1', role: 'user', content: 'First', timestamp: 1, status: 'complete' },
        { id: '2', role: 'assistant', content: 'Reply 1', timestamp: 2, status: 'complete' },
        { id: '3', role: 'user', content: 'Second', timestamp: 3, status: 'complete' }
      );

      // Fork at turn 2 (keeps first user + assistant)
      const forkedSession = controller.forkSession(2);

      expect(forkedSession.messages).toHaveLength(2);
      expect(forkedSession.messages[1].content).toBe('Reply 1');
      expect(forkedSession.id).not.toBe(session.id);
    });
  });

  describe('Subprocess Manager Port Detection', () => {
    it('finds an open port correctly', async () => {
      const manager = new DshSubprocessManager({ config: {} });
      const port = await manager.findAvailablePort(45000);
      expect(port).toBeGreaterThanOrEqual(45000);
      expect(typeof port).toBe('number');
    });

    it('stops the health poll when the subprocess errors without exiting', async () => {
      // A spawn failure (ENOENT) emits 'error' with no matching 'exit'; the
      // supervisor must tear down its 2s health interval instead of spinning.
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      const manager = new DshSubprocessManager({
        config: {},
        customExecutable: 'dsh-definitely-missing-binary',
        customArgs: [],
      });

      try {
        await manager.start();
        const startedTimer = setIntervalSpy.mock.results.at(-1)?.value;
        expect(startedTimer).toBeDefined();

        // Give the spawn 'error' event time to fire.
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(manager.getHealth().running).toBe(false);
        expect(clearIntervalSpy).toHaveBeenCalledWith(startedTimer);
        expect((manager as any).healthCheckTimer).toBeNull();
      } finally {
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
        await manager.stop();
      }
    });
  });

  describe('Context Overflow Guard & Compaction Advisor', () => {
    it('evaluates normal, warning, and critical context thresholds', () => {
      const guard = new DshContextGuard(75, 90);

      // Normal
      const normal = guard.evaluate({
        promptTokens: 1000,
        completionTokens: 200,
        totalTokens: 1200,
        tps: 30,
        contextLimit: 128000,
        contextUsagePercent: 0.9,
      });
      expect(normal.isWarning).toBe(false);
      expect(normal.recommendation).toBe('normal');

      // Warning at 80%
      const warning = guard.evaluate({
        promptTokens: 80000,
        completionTokens: 22400,
        totalTokens: 102400,
        tps: 40,
        contextLimit: 128000,
        contextUsagePercent: 80.0,
      });
      expect(warning.isWarning).toBe(true);
      expect(warning.isCritical).toBe(false);
      expect(warning.recommendation).toBe('compact_history');

      // Critical at 95%
      const critical = guard.evaluate({
        promptTokens: 100000,
        completionTokens: 21600,
        totalTokens: 121600,
        tps: 20,
        contextLimit: 128000,
        contextUsagePercent: 95.0,
      });
      expect(critical.isCritical).toBe(true);
      expect(critical.recommendation).toBe('fork_session');
    });
  });

  describe('Shared Session Store & Atomic Writes', () => {
    it('saves and reads sessions atomically without leaving temporary artifacts', () => {
      const tempOfficial = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-off-test-'));
      const tempSuite = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-suite-test-'));
      try {
        const store = new DshSharedSessionStore(tempOfficial, tempSuite);
        const session = {
          id: 'test_session_123',
          title: 'Atomic Test Session',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          workspacePath: '/tmp/workspace',
          model: 'deepseek-reasoner',
          messages: [{ id: 'm1', role: 'user' as const, content: 'Hello', timestamp: Date.now(), status: 'complete' as const }],
          metrics: { promptTokens: 10, completionTokens: 20, totalTokens: 30, tps: 15, contextLimit: 128000, contextUsagePercent: 0.1 },
        };

        store.saveSession(session);

        const readBack = store.readSession('test_session_123');
        expect(readBack).not.toBeNull();
        expect(readBack?.title).toBe('Atomic Test Session');

        const files = fs.readdirSync(tempSuite);
        expect(files).toContain('test_session_123.json');
        expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);

        const list = store.listSessions();
        expect(list).toHaveLength(1);
        expect(list[0].id).toBe('test_session_123');
      } finally {
        fs.rmSync(tempOfficial, { recursive: true, force: true });
        fs.rmSync(tempSuite, { recursive: true, force: true });
      }
    });

    it('rejects session ids attempting filesystem path traversal', () => {
      const tempOfficial = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-off3-test-'));
      const tempSuite = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-suite3-test-'));
      try {
        const store = new DshSharedSessionStore(tempOfficial, tempSuite);
        const baseSession = {
          title: 'Traversal Attempt',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          workspacePath: '/tmp/workspace',
          model: 'deepseek-reasoner',
          messages: [],
          metrics: { promptTokens: 0, completionTokens: 0, totalTokens: 0, tps: 0, contextLimit: 128000, contextUsagePercent: 0 },
        };

        expect(() => store.readSession('../evil')).toThrow(TypeError);
        expect(() => store.readSession('../../etc/passwd')).toThrow(TypeError);
        expect(() => store.readSession('..\\windows\\evil')).toThrow(TypeError);
        expect(() => store.saveSession({ ...baseSession, id: 'a\x00b' } as any)).toThrow(TypeError);
        expect(() => store.saveSession({ ...baseSession, id: 'sub/dir/evil' } as any)).toThrow(TypeError);

        // Nothing may have been written outside (or inside) the suite directory
        expect(fs.readdirSync(tempSuite)).toHaveLength(0);
      } finally {
        fs.rmSync(tempOfficial, { recursive: true, force: true });
        fs.rmSync(tempSuite, { recursive: true, force: true });
      }
    });

    it('accepts well-formed session ids through the save/read roundtrip', () => {
      const tempOfficial = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-off4-test-'));
      const tempSuite = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-suite4-test-'));
      try {
        const store = new DshSharedSessionStore(tempOfficial, tempSuite);
        const session = {
          id: 'sess_ABC-123._x9',
          title: 'Well Formed Id',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          workspacePath: '/tmp/workspace',
          model: 'deepseek-reasoner',
          messages: [{ id: 'm1', role: 'user' as const, content: 'Hello', timestamp: Date.now(), status: 'complete' as const }],
          metrics: { promptTokens: 1, completionTokens: 2, totalTokens: 3, tps: 1, contextLimit: 128000, contextUsagePercent: 0 },
        };

        store.saveSession(session);

        const readBack = store.readSession('sess_ABC-123._x9');
        expect(readBack).not.toBeNull();
        expect(readBack?.title).toBe('Well Formed Id');
        expect(fs.readdirSync(tempSuite)).toContain('sess_ABC-123._x9.json');
      } finally {
        fs.rmSync(tempOfficial, { recursive: true, force: true });
        fs.rmSync(tempSuite, { recursive: true, force: true });
      }
    });

    it('handles controller system notifications and session resume helper', () => {
      const tempOfficial = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-off2-test-'));
      const tempSuite = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-suite2-test-'));
      try {
        const store = new DshSharedSessionStore(tempOfficial, tempSuite);
        const controller = new DshAgentController({ config: {} });

        controller.addSystemMessage('System initialized');
        expect(controller.getSession().messages).toHaveLength(1);
        expect(controller.getSession().messages[0].role).toBe('system');
        expect(controller.getSession().messages[0].content).toBe('System initialized');

        const savedId = controller.saveCurrentSession(store);
        expect(savedId).toBe(controller.getSession().id);

        const newController = new DshAgentController({ config: {} });
        const resumed = newController.resumeSessionById(savedId, store);
        expect(resumed).toBe(true);
        expect(newController.getSession().id).toBe(savedId);
      } finally {
        fs.rmSync(tempOfficial, { recursive: true, force: true });
        fs.rmSync(tempSuite, { recursive: true, force: true });
      }
    });
  });

  describe('Tamper-Evident Audit Chain', () => {
    it('cryptographically chains execution records and detects tampering', () => {
      const chain = new DshAuditChain();

      const r1 = chain.append({
        sessionId: 'sess_1',
        toolName: 'read_file',
        args: { path: '/tmp/test.ts' },
        riskLevel: 'low',
        verdict: 'auto_approved',
      });

      const r2 = chain.append({
        sessionId: 'sess_1',
        toolName: 'bash',
        args: { command: 'rm -rf /tmp/build' },
        riskLevel: 'critical',
        verdict: 'approved_once',
      });

      expect(chain.getRecords()).toHaveLength(2);
      expect(r2.prevHash).toBe(r1.hash);

      const verification = chain.verify();
      expect(verification.valid).toBe(true);
    });

    it('persists to disk and loadAndVerify resumes the chain from the file tail', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-disk-'));
      try {
        // Writer chain persists every record.
        const writer = new DshAuditChain(tempDir, 'sess_disk');
        const r1 = writer.append({
          sessionId: 'sess_disk',
          toolName: 'read_file',
          args: { path: '/tmp/a.ts' },
          riskLevel: 'low',
          verdict: 'auto_approved',
          durationMs: 12,
          status: 'success',
        });
        const r2 = writer.append({
          sessionId: 'sess_disk',
          toolName: 'run_command',
          args: { command: 'git status' },
          riskLevel: 'low',
          verdict: 'auto_approved',
          durationMs: 340,
          status: 'failed',
        });

        const logPath = path.join(tempDir, 'sess_disk.audit.jsonl');
        expect(fs.existsSync(logPath)).toBe(true);

        // Fresh process: load the persisted log back and verify every link
        // (durationMs/status are now part of the hashed content).
        const loader = new DshAuditChain();
        const loadRes = loader.loadAndVerify(logPath);
        expect(loadRes.valid).toBe(true);
        expect(loadRes.loaded).toBe(2);

        // In-memory chain continues seamlessly from the file tail.
        const r3 = loader.append({
          sessionId: 'sess_disk',
          toolName: 'write_file',
          args: { path: '/tmp/b.ts' },
          riskLevel: 'medium',
          verdict: 'approved_once',
          status: 'success',
        });
        expect(r3.seq).toBe(3);
        expect(r3.prevHash).toBe(r2.hash);

        // The continuation must also persist and re-verify from scratch.
        const reloader = new DshAuditChain();
        expect(reloader.loadAndVerify(logPath)).toEqual({ valid: true, loaded: 3 });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('throws when a persisted audit log line has been tampered with', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-tamper-'));
      try {
        const writer = new DshAuditChain(tempDir, 'sess_evil');
        writer.append({
          sessionId: 'sess_evil',
          toolName: 'read_file',
          args: { path: '/tmp/innocent.ts' },
          riskLevel: 'low',
          verdict: 'auto_approved',
        });
        writer.append({
          sessionId: 'sess_evil',
          toolName: 'read_file',
          args: { path: '/workspace/.env' },
          riskLevel: 'critical',
          verdict: 'rejected',
        });

        const logPath = path.join(tempDir, 'sess_evil.audit.jsonl');

        // Hand-edit the middle record: swap a rejected credential read into an approved one.
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter((l) => l.trim());
        const rec = JSON.parse(lines[1]);
        rec.verdict = 'auto_approved';
        rec.riskLevel = 'low';
        lines[1] = JSON.stringify(rec);
        fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf-8');

        expect(() => new DshAuditChain().loadAndVerify(logPath)).toThrow(/content hash mismatch/);

        // Also reject raw corruption (invalid JSON line).
        fs.writeFileSync(logPath, lines[0] + '\n{not json\n', 'utf-8');
        expect(() => new DshAuditChain().loadAndVerify(logPath)).toThrow(/invalid JSON/);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('counts disk persistence failures instead of silently dropping them', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-wfail-'));
      try {
        // Point the audit dir at a regular FILE: appendFileSync can never succeed,
        // but records stay in memory (old behavior swallowed this entirely).
        const blockingFile = path.join(tempDir, 'not-a-dir');
        fs.writeFileSync(blockingFile, 'occupied', 'utf-8');
        const chain = new DshAuditChain(blockingFile, 'sess_wfail');

        chain.append({ sessionId: 'sess_wfail', toolName: 'read_file', args: {}, riskLevel: 'low', verdict: 'auto_approved' });
        chain.append({ sessionId: 'sess_wfail', toolName: 'write_file', args: {}, riskLevel: 'medium', verdict: 'approved_once' });

        // Memory chain intact and valid, with the persistence gap exposed.
        const res = chain.verify();
        expect(res.valid).toBe(true);
        expect(res.writeFailures).toBe(2);

        const clean = new DshAuditChain();
        clean.append({ sessionId: 's', toolName: 't', args: {}, riskLevel: 'low', verdict: 'auto_approved' });
        expect(clean.verify().writeFailures).toBe(0);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('Five-Layer Environment Doctor', () => {
    it('runs comprehensive diagnostics and formats readable health reports', () => {
      const report = DshDoctor.diagnose(
        { model: 'deepseek-reasoner', apiKey: 'sk-mock-key' },
        { running: true, pid: 12345, uptimeSeconds: 42 },
        { promptTokens: 2000, completionTokens: 500, totalTokens: 2500, tps: 45, contextLimit: 128000, contextUsagePercent: 1.95 }
      );

      expect(report.overallStatus).toBe('healthy');
      expect(report.checks.length).toBeGreaterThanOrEqual(4);

      const text = DshDoctor.formatReport(report);
      expect(text).toContain('DeepSeek Harness System Health Report');
      expect(text).toContain('Node.js Runtime Version');
    });
  });

  describe('Community Plugin Marketplace Discovery', () => {
    it('searches and formats community plugins from registry', async () => {
      const client = new DshPluginCatalogClient();
      const plugins = await client.searchPlugins('context');

      expect(plugins.length).toBeGreaterThan(0);
      expect(plugins[0].name).toContain('context');

      const formatted = client.formatPluginList(plugins, '0.1.0-rc.8');
      expect(formatted).toContain('DSH Community Plugin Marketplace');
      expect(formatted).toContain('dsh plugin add');
    });
  });

  describe('Multi-Provider Preset Manager', () => {
    it('provides preset details and handles dynamic provider switching', () => {
      const presets = DshProviderManager.listPresets();
      expect(presets.length).toBeGreaterThanOrEqual(4);

      const silicon = DshProviderManager.getPreset('siliconflow');
      expect(silicon?.baseUrl).toContain('siliconflow.cn');

      const controller = new DshAgentController({ config: {} });
      const switchRes = controller.switchProvider('siliconflow');
      expect(switchRes.success).toBe(true);
      expect(controller.getSession().model).toBe('deepseek-ai/DeepSeek-R1');
    });
  });

  describe('File Checkpoint & Mutation Undo Engine', () => {
    it('captures pre-mutation snapshots and successfully rolls back changes', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cp-test-'));
      try {
        const engine = new DshCheckpointEngine(tempDir);
        const testFile = path.join(tempDir, 'sample.ts');
        fs.writeFileSync(testFile, 'const initial = 1;', 'utf-8');

        engine.snapshot([testFile], 'Before refactor');

        // Mutate file
        fs.writeFileSync(testFile, 'const modified = 2;', 'utf-8');
        expect(fs.readFileSync(testFile, 'utf-8')).toBe('const modified = 2;');

        // Undo
        const undoRes = engine.undo();
        expect(undoRes.success).toBe(true);
        expect(fs.readFileSync(testFile, 'utf-8')).toBe('const initial = 1;');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('keeps checkpoint seq unique across sliding-window eviction and undoes by exact seq', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cp-seq-'));
      try {
        const testFile = path.join(tempDir, 'evict.ts');

        // maxCheckpoints=2 forces eviction after the 2nd snapshot.
        const engine = new DshCheckpointEngine(tempDir, undefined, 2);

        const contents = ['v0', 'v1', 'v2', 'v3'];
        const seqs: number[] = [];
        for (const content of contents) {
          fs.writeFileSync(testFile, content, 'utf-8');
          // Snapshot captures the current content BEFORE the next mutation.
          seqs.push(engine.snapshot([testFile], `state ${content}`).seq);
        }

        // Old bug: seq derived from array length → [1,2,3,3] after eviction.
        expect(seqs).toEqual([1, 2, 3, 4]);
        expect(new Set(seqs).size).toBe(4);

        // Window holds only cp3 (captures v2) and cp4 (captures v3).
        // undo(3) must restore v2 (state before mutation 3) via exact seq match,
        // not fall back onto a duplicate/wrong record.
        const undoRes = engine.undo(3);
        expect(undoRes.success).toBe(true);
        expect(fs.readFileSync(testFile, 'utf-8')).toBe('v2');
        expect(engine.getCheckpoints()).toHaveLength(0);

        // Sequence continues monotonically after undo truncation (no seq reuse).
        fs.writeFileSync(testFile, 'v9', 'utf-8');
        const next = engine.snapshot([testFile], 'after undo');
        expect(next.seq).toBe(5);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('enforces strict workspace path jail and rejects escapes and control chars', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cp-jail-'));
      try {
        const engine = new DshCheckpointEngine(tempDir);
        
        // 1. Path traversal escape
        expect(() => {
          engine.snapshot(['../../etc/passwd'], 'Malicious escape');
        }).toThrow(/Security Boundary Violation/);

        // 2. Control character injection
        expect(() => {
          engine.snapshot(['file\x00name.ts'], 'NUL byte');
        }).toThrow(/Security Boundary Violation/);

        expect(() => {
          engine.snapshot(['file\x1fname.ts'], 'Control char');
        }).toThrow(/Security Boundary Violation/);

        // 3. Valid workspace path
        const valid = engine.sanitizeWorkspacePath('src/main.ts');
        expect(valid.relativePath).toBe('src/main.ts');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('fails closed on completely unrecognized tools', () => {
      const evalRes = DshRiskEvaluator.evaluate('magic_unknown_tool_123', {});
      expect(evalRes.capabilities).toContain('system:mutate');
      expect(evalRes.riskLevel).toBe('high');
      expect(evalRes.requiresApproval).toBe(true);
      expect(evalRes.reason).toContain('failed closed');
    });
  });

  describe('Session Transcript Exporter', () => {
    it('exports session history into structured Markdown and JSON reports', () => {
      const session = {
        id: 'sess_export_1',
        title: 'Export Test',
        createdAt: 1700000000000,
        updatedAt: 1700000010000,
        workspacePath: '/tmp/workspace',
        model: 'deepseek-reasoner',
        messages: [
          { id: 'm1', role: 'user' as const, content: 'Write a quicksort function', timestamp: 1700000000000, status: 'complete' as const },
          { id: 'm2', role: 'assistant' as const, reasoning: 'Thinking about partition...', content: 'Here is quicksort in TypeScript', timestamp: 1700000005000, status: 'complete' as const },
        ],
        metrics: { promptTokens: 15, completionTokens: 40, totalTokens: 55, tps: 30, contextLimit: 128000, contextUsagePercent: 0.04 },
      };

      const md = DshTranscriptExporter.toMarkdown(session);
      expect(md).toContain('DeepSeek Harness Session Transcript');
      expect(md).toContain('Write a quicksort function');
      expect(md).toContain('Thinking about partition...');

      const json = DshTranscriptExporter.toJson(session);
      expect(JSON.parse(json).id).toBe('sess_export_1');
    });
  });

  describe('DSH Ignore & Sensitive Path Defense', () => {
    it('detects sensitive files and elevates risk to critical', () => {
      const matcher = new DshIgnoreMatcher('/tmp');
      expect(matcher.isIgnored('.env')).toBe(true);
      expect(matcher.isIgnored('server.key')).toBe(true);
      expect(matcher.isIgnored('node_modules/express/index.js')).toBe(true);
      expect(matcher.isIgnored('src/App.tsx')).toBe(false);

      // Verify RiskEvaluator triggers critical approval for sensitive file
      const evalResult = DshRiskEvaluator.evaluate('read_file', { path: '/workspace/.env' });
      expect(evalResult.riskLevel).toBe('critical');
      expect(evalResult.requiresApproval).toBe(true);
    });

    it('matches built-in sensitive credential basenames case-insensitively', () => {
      // macOS/Windows preserve case, so `.ENV` / `ID_RSA` must not bypass the guard.
      const matcher = new DshIgnoreMatcher('/tmp');
      expect(matcher.isIgnored('.ENV')).toBe(true);
      expect(matcher.isIgnored('config/.Env.Local')).toBe(true);
      expect(matcher.isIgnored('secrets/SERVER.KEY')).toBe(true);
      expect(matcher.isSensitiveCredential('certs/CA.PEM')).toBe(true);
      expect(matcher.isSensitiveCredential('~/.SSH/ID_RSA')).toBe(true);

      // Shell argument scanning inherits the case-insensitive guard.
      const evalUpper = DshRiskEvaluator.evaluate('run_command', { command: 'cat .ENV.PRODUCTION' });
      expect(evalUpper.riskLevel).toBe('critical');
      expect(evalUpper.requiresApproval).toBe(true);

      // Only the credential rules fold case; ordinary literal matching stays exact.
      expect(matcher.isIgnored('SRC/App.tsx'.toUpperCase())).toBe(false);
    });

    it('warns once per unsupported ignore-file pattern instead of failing silently', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ignore-warn-'));
      try {
        fs.writeFileSync(
          path.join(tempDir, '.gitignore'),
          ['*.log', '!keep.log', 'logs/', '# just a comment', 'plain-name'].join('\n'),
          'utf-8'
        );

        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
          new DshIgnoreMatcher(tempDir);
          // Second construction with the same patterns must NOT re-warn.
          new DshIgnoreMatcher(tempDir);

          const warnedText = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
          expect(warnedText).toContain('*.log');
          expect(warnedText).toContain('!keep.log');
          expect(warnedText).toContain('logs/');
          expect(warnedText).toContain('matched literally');

          const countFor = (needle: string) =>
            stderrSpy.mock.calls.filter((c) => String(c[0]).includes(needle)).length;
          expect(countFor('*.log')).toBe(1);
          expect(countFor('!keep.log')).toBe(1);
          expect(countFor('logs/')).toBe(1);

          // Literal patterns and comments are honored as-is and never warn.
          expect(warnedText).not.toContain('plain-name');
          expect(warnedText).not.toContain('# just a comment');
        } finally {
          stderrSpy.mockRestore();
        }

        // Literal entries still match by exact name/path equality.
        const matcher = new DshIgnoreMatcher(tempDir);
        expect(matcher.isIgnored('plain-name')).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('scans shell command arguments for protected credentials before auto-approval', () => {
      // 1. Credential paths inside command strings must escalate to approval
      const evalRsa = DshRiskEvaluator.evaluate('run_command', { command: 'cat ~/.ssh/id_rsa' });
      expect(evalRsa.riskLevel).toBe('critical');
      expect(evalRsa.requiresApproval).toBe(true);
      expect(evalRsa.reason).toContain('id_rsa');

      const evalEnv = DshRiskEvaluator.evaluate('run_command', { command: 'cat .env.production' });
      expect(evalEnv.riskLevel).toBe('critical');
      expect(evalEnv.requiresApproval).toBe(true);

      const evalPem = DshRiskEvaluator.evaluate('run_command', { command: "openssl verify './certs/server.pem'" });
      expect(evalPem.riskLevel).toBe('critical');
      expect(evalPem.requiresApproval).toBe(true);

      // 2. Non-credential read-only commands remain auto-approved (no semantic drift)
      const evalSafe = DshRiskEvaluator.evaluate('run_command', { command: 'cat src/index.ts' });
      expect(evalSafe.riskLevel).toBe('low');
      expect(evalSafe.requiresApproval).toBe(false);
    });
  });
});
