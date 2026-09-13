import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { 
  DshSession, 
  DshMessage, 
  DshApprovalDecision, 
  DshConfig,
  DshAgentStatus,
  DshEvent,
  DshToolCall,
  RiskLevel
} from '../types/index.js';
import { DshEventStream } from '../events/event-stream.js';
import { DshSharedSessionStore } from '../session/session-store.js';
import { DshAuditChain } from '../security/audit-chain.js';
import { DshDoctor, type DoctorReport } from '../runtime/doctor.js';
import { DshPluginCatalogClient, type PluginEntry } from '../marketplace/plugin-catalog.js';
import { DshCheckpointEngine } from '../checkpoint/checkpoint-engine.js';
import { DshProviderManager, type ProviderPreset } from '../providers/provider-presets.js';
import { DshTranscriptExporter } from '../export/transcript-exporter.js';
import { DshRuntimeClient } from '../runtime/runtime-client.js';

export interface AgentControllerOptions {
  config: DshConfig;
  events?: DshEventStream;
  auditChain?: DshAuditChain;
  /** Override the suite audit directory (defaults to $DSH_SUITE_AUDIT_DIR or ~/.dsh/suite_audit). */
  auditDir?: string;
  checkpoints?: DshCheckpointEngine;
  runtimeClient?: DshRuntimeClient;
}

/** Correlates a tool invocation's start record with its terminal record. */
interface TrackedToolInvocation {
  toolName: string;
  args: Record<string, unknown>;
  riskLevel: RiskLevel;
  startedAt: number;
}

/**
 * High-Level Agent Controller Facade
 * 
 * Provides an anti-corruption interface for executing turns, handling approvals,
 * managing session forks/rollbacks, and controlling the agent loop.
 */
export class DshAgentController {
  private static readonly MAX_TRACKED_TOOL_CALLS = 512;

  public readonly events: DshEventStream;
  /**
   * Mutable by design: when the controller owns its chain (no injected one),
   * it is rebound whenever the active session identity changes (load/fork) so
   * records always live in the log file named after the session they describe.
   */
  public auditChain: DshAuditChain;
  public readonly checkpoints: DshCheckpointEngine;
  public readonly runtimeClient: DshRuntimeClient;
  private pluginClient = new DshPluginCatalogClient();
  private config: DshConfig;
  private currentSession: DshSession | null = null;
  private currentStatus: DshAgentStatus = 'idle';
  private pendingApprovals = new Map<string, (decision: DshApprovalDecision) => void>();
  /** True when the chain was auto-created here (injected chains are never rebound). */
  private ownsAuditChain: boolean;
  private readonly auditDir?: string;
  /** Tool invocations observed but not yet finished, keyed by call id. */
  private trackedToolCalls = new Map<string, TrackedToolInvocation>();

  constructor(options: AgentControllerOptions) {
    this.config = options.config;
    this.auditDir = options.auditDir;
    this.ownsAuditChain = !options.auditChain;
    this.events = options.events || new DshEventStream();
    this.checkpoints = options.checkpoints || new DshCheckpointEngine(this.config.workspacePath);
    this.runtimeClient = options.runtimeClient || new DshRuntimeClient();

    // Session identity first: the default audit chain persists under
    // suite_audit/<sessionId>.audit.jsonl and resumes an existing log instead
    // of rewriting it from seq=1.
    this.initSession();
    if (options.auditChain) {
      this.auditChain = options.auditChain;
    } else {
      this.auditChain = this.attachSessionAuditChain(this.getSession().id);
    }

    this.setupInternalListeners();
  }

  private initSession(): void {
    this.currentSession = {
      id: `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title: 'New Workspace Session',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspacePath: this.config.workspacePath || process.cwd(),
      model: this.config.model || 'deepseek-reasoner',
      messages: [],
      metrics: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        tps: 0,
        contextLimit: 128000,
        contextUsagePercent: 0,
      },
    };
  }

  private setupInternalListeners(): void {
    this.events.on('agent:status', (event) => {
      this.currentStatus = event.status;
    });

    this.events.on('stream:metrics', (event) => {
      if (this.currentSession) {
        this.currentSession.metrics = {
          ...this.currentSession.metrics,
          ...event.metrics,
        };
        this.events.emitEvent({
          type: 'session:updated',
          session: this.currentSession,
        });
      }
    });

    // Tool execution audit trail: normalized tool lifecycle events emitted by
    // the runtime transport (SDK notifications or upstream projection) are
    // mirrored into the tamper-evident chain. Auditing is a side channel —
    // risk gating stays in DshRiskEvaluator, persistence failures never
    // propagate into the execution path.
    this.events.on('tool:requested', (event) => {
      this.recordToolInvocationStart(event.toolCall);
    });
    this.events.on('tool:finished', (event) => {
      this.recordToolInvocationFinish(event);
    });
  }

  /**
   * Suite-owned audit persistence following the same ~/.dsh isolation
   * convention as ~/.dsh/suite_sessions: one JSONL chain log per session under
   * ~/.dsh/suite_audit. An existing log is resumed via loadAndVerify so
   * restarts continue the chain instead of rewriting from seq=1. A corrupted
   * log is quarantined (renamed aside, never deleted) to preserve forensic
   * evidence while keeping future records verifiable; startup never fails
   * because of auditing.
   */
  private attachSessionAuditChain(sessionId: string): DshAuditChain {
    const dir = this.auditDir || process.env.DSH_SUITE_AUDIT_DIR || path.join(os.homedir(), '.dsh', 'suite_audit');
    const chain = new DshAuditChain(dir, sessionId);
    const logPath = path.join(dir, `${sessionId}.audit.jsonl`);

    if (fs.existsSync(logPath)) {
      try {
        chain.loadAndVerify(logPath);
      } catch {
        try {
          fs.renameSync(logPath, `${logPath}.corrupt-${Date.now()}`);
        } catch {
          // Hostile disk: fall back to memory-only auditing rather than blocking.
        }
      }
    }

    return chain;
  }

  /** Append to the audit chain without ever disturbing the execution pipeline. */
  private safeAuditAppend(payload: Parameters<DshAuditChain['append']>[0]): void {
    try {
      this.auditChain.append(payload);
    } catch {
      // Observational side channel only; disk-level gaps are already counted
      // in DshAuditChain.writeFailures and surfaced via verify().
    }
  }

  private recordToolInvocationStart(call: DshToolCall): void {
    const startedAt = call.startedAt ?? Date.now();
    this.trackedToolCalls.set(call.id, {
      toolName: call.name,
      args: call.args ?? {},
      riskLevel: call.riskLevel,
      startedAt,
    });

    // Bound the correlation table: results that never arrive (runtime crash
    // mid-call) must not grow it without limit. Map preserves insertion
    // order, so eviction is FIFO.
    if (this.trackedToolCalls.size > DshAgentController.MAX_TRACKED_TOOL_CALLS) {
      const oldest = this.trackedToolCalls.keys().next().value;
      if (oldest !== undefined) {
        this.trackedToolCalls.delete(oldest);
      }
    }

    this.safeAuditAppend({
      sessionId: this.getSession().id,
      toolName: call.name,
      args: call.args ?? {},
      riskLevel: call.riskLevel,
      // No approval decision has happened at this point; the terminal record
      // closes this invocation (approval verdicts are recorded separately).
      status: 'pending',
      reason: `tool invocation ${call.id} started`,
    });
  }

  private recordToolInvocationFinish(event: Extract<DshEvent, { type: 'tool:finished' }>): void {
    const tracked = this.trackedToolCalls.get(event.toolCallId);
    this.trackedToolCalls.delete(event.toolCallId);

    const completedAt = Date.now();
    this.safeAuditAppend({
      sessionId: this.getSession().id,
      toolName: tracked?.toolName ?? 'unknown_tool',
      args: tracked?.args ?? {},
      riskLevel: tracked?.riskLevel ?? 'medium',
      status: event.status === 'failed' ? 'failed' : 'success',
      durationMs: tracked ? Math.max(0, completedAt - tracked.startedAt) : undefined,
      reason: tracked
        ? `tool invocation ${event.toolCallId} finished`
        : `tool completion observed without a tracked start (${event.toolCallId})`,
    });
  }

  public getSession(): DshSession {
    if (!this.currentSession) {
      this.initSession();
    }
    return this.currentSession!;
  }

  public getStatus(): DshAgentStatus {
    return this.currentStatus;
  }

  public updateConfig(newConfig: Partial<DshConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  public getConfig(): Readonly<DshConfig> {
    return this.config;
  }

  /**
   * Submit a user prompt to the Agent
   */
  public async submitPrompt(promptText: string): Promise<void> {
    if (this.currentStatus !== 'idle' && this.currentStatus !== 'error') {
      throw new Error(`Cannot submit prompt while agent is in state: ${this.currentStatus}`);
    }

    const session = this.getSession();
    const userMsg: DshMessage = {
      id: `msg_u_${Date.now()}`,
      role: 'user',
      content: promptText,
      timestamp: Date.now(),
      status: 'complete',
    };

    session.messages.push(userMsg);
    session.updatedAt = Date.now();

    this.events.emitEvent({
      type: 'agent:status',
      status: 'thinking',
    });

    this.events.emitEvent({
      type: 'session:updated',
      session,
    });

    try {
      const result = await this.runtimeClient.executeTurn({
        prompt: promptText,
        config: this.config,
        events: this.events,
      });

      if (result.content || result.reasoning) {
        const assistantMsg: DshMessage = {
          id: `msg_a_${Date.now()}`,
          role: 'assistant',
          content: result.content,
          reasoning: result.reasoning,
          reasoningContent: result.reasoning,
          timestamp: Date.now(),
          status: 'complete',
        };

        session.messages.push(assistantMsg);
        session.updatedAt = Date.now();

        this.events.emitEvent({
          type: 'session:updated',
          session,
        });
      }
    } catch (err: any) {
      this.events.emitEvent({
        type: 'agent:status',
        status: 'error',
        payload: { error: err.message },
      });
    }
  }

  /**
   * Respond to a pending approval request (e.g. tool execution permission)
   */
  public respondApproval(approvalId: string, decision: DshApprovalDecision): void {
    const resolver = this.pendingApprovals.get(approvalId);
    if (resolver) {
      resolver(decision);
      this.pendingApprovals.delete(approvalId);
      this.auditChain.append({
        sessionId: this.getSession().id,
        toolName: approvalId,
        args: {},
        riskLevel: 'high',
        verdict: decision === 'allow_once' ? 'approved_once' : decision === 'allow_always' ? 'approved_always' : 'rejected',
        reason: `Human decision: ${decision}`,
        status: decision === 'reject' ? 'failed' : 'success',
      });
    }
  }

  /**
   * Register a pending approval promise
   */
  public registerApproval(approvalId: string): Promise<DshApprovalDecision> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(approvalId, resolve);
    });
  }

  /**
   * Interrupt / cancel active agent loop
   */
  public interrupt(): void {
    this.runtimeClient.interrupt();
    this.events.emitEvent({
      type: 'agent:status',
      status: 'interrupted',
    });
    // Clear pending approvals with reject
    for (const [id, resolver] of this.pendingApprovals.entries()) {
      resolver('reject');
    }
    this.pendingApprovals.clear();
  }

  /**
   * Rollback the session to a specific turn index (Claude Code style rewind)
   */
  public rollback(turnIndex: number): void {
    const session = this.getSession();
    if (turnIndex < 0 || turnIndex >= session.messages.length) {
      throw new Error(`Invalid turn index for rollback: ${turnIndex}`);
    }

    session.messages = session.messages.slice(0, turnIndex);
    session.updatedAt = Date.now();

    this.events.emitEvent({
      type: 'session:updated',
      session,
    });
  }

  /**
   * Fork session from a specific point into a new session
   */
  public forkSession(atTurnIndex: number): DshSession {
    const oldSession = this.getSession();
    const truncatedMessages = oldSession.messages.slice(0, atTurnIndex);

    const newSession: DshSession = {
      id: `session_fork_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title: `Fork of ${oldSession.title}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspacePath: oldSession.workspacePath,
      model: oldSession.model,
      messages: JSON.parse(JSON.stringify(truncatedMessages)),
      metrics: { ...oldSession.metrics },
    };

    this.events.emitEvent({
      type: 'session:forked',
      originalSessionId: oldSession.id,
      newSessionId: newSession.id,
      atTurn: atTurnIndex,
    });

    this.currentSession = newSession;
    if (this.ownsAuditChain) {
      this.auditChain = this.attachSessionAuditChain(newSession.id);
    }
    this.events.emitEvent({
      type: 'session:updated',
      session: newSession,
    });

    return newSession;
  }

  /**
   * Load and resume an existing session from the shared store
   */
  public loadSession(session: DshSession): void {
    this.currentSession = session;
    if (this.ownsAuditChain) {
      // Resume (or start) the audit log of the session being loaded so
      // appended records live in the file named after this session id.
      this.auditChain = this.attachSessionAuditChain(session.id);
    }
    this.events.emitEvent({
      type: 'session:updated',
      session: this.currentSession,
    });
  }

  /**
   * Append a system notification/log message to the current session
   */
  public addSystemMessage(content: string): DshMessage {
    const session = this.getSession();
    const sysMsg: DshMessage = {
      id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      role: 'system',
      content,
      timestamp: Date.now(),
      status: 'complete',
    };
    session.messages.push(sysMsg);
    session.updatedAt = Date.now();
    this.events.emitEvent({
      type: 'session:updated',
      session,
    });
    return sysMsg;
  }

  /**
   * Save the active session to the shared session store
   */
  public saveCurrentSession(store?: DshSharedSessionStore): string {
    const sessionStore = store || new DshSharedSessionStore();
    const session = this.getSession();
    sessionStore.saveSession(session);
    this.addSystemMessage(`Session successfully saved to ~/.dsh/suite_sessions/${session.id}.json`);
    return session.id;
  }

  /**
   * Resume an existing session by ID
   */
  public resumeSessionById(sessionId: string, store?: DshSharedSessionStore): boolean {
    const sessionStore = store || new DshSharedSessionStore();
    const loaded = sessionStore.readSession(sessionId);
    if (loaded) {
      this.loadSession(loaded);
      this.addSystemMessage(`Resumed session "${sessionId}" (${loaded.title})`);
      return true;
    }
    this.addSystemMessage(`Session "${sessionId}" not found in ~/.dsh/suite_sessions`);
    return false;
  }

  /**
   * Run full system and environmental health diagnostics (/doctor)
   */
  public diagnose(runtimeHealth?: any): DoctorReport {
    return DshDoctor.diagnose(this.config, runtimeHealth, this.getSession().metrics);
  }

  /**
   * Format doctor diagnostics report as human readable text
   */
  public formatDoctorReport(report: DoctorReport): string {
    return DshDoctor.formatReport(report);
  }

  /**
   * Search community and official plugin catalog
   */
  public async searchPlugins(query = ''): Promise<PluginEntry[]> {
    return this.pluginClient.searchPlugins(query);
  }

  /**
   * Format plugin list for display in TUI
   */
  public formatPluginList(plugins: PluginEntry[]): string {
    return this.pluginClient.formatPluginList(plugins, this.config.runtimeVersion || '0.1.0-rc.6');
  }

  /**
   * Switch model provider preset (/provider switch <id> [model])
   */
  public switchProvider(providerId: string, modelName?: string): { success: boolean; message: string } {
    const preset = DshProviderManager.getPreset(providerId);
    if (!preset) {
      return {
        success: false,
        message: `Unknown provider "${providerId}". Supported: ${Object.keys(DshProviderManager.listPresets()).join(', ')}`,
      };
    }

    const session = this.getSession();
    const targetModel = modelName || preset.defaultModel;
    session.model = targetModel;
    session.metrics = {
      ...session.metrics,
      contextLimit: preset.contextLimit,
    };

    this.events.emitEvent({
      type: 'session:updated',
      session,
    });

    return {
      success: true,
      message: `Switched provider to "${preset.name}" (Model: ${targetModel}, Context Limit: ${(preset.contextLimit / 1024).toFixed(0)}k)`,
    };
  }

  /**
   * List available provider presets
   */
  public listProviders(): string {
    return DshProviderManager.formatPresetsList(this.config.provider || 'deepseek');
  }

  /**
   * Undo the latest file modification checkpoint (/undo)
   */
  public undoLastMutation(): { success: boolean; message: string } {
    const res = this.checkpoints.undo();
    if (!res.success) {
      return { success: false, message: res.error || 'Undo failed.' };
    }

    return {
      success: true,
      message: `Successfully rolled back ${res.revertedFiles.length} file(s):\n` + res.revertedFiles.map((f) => `  • ${f}`).join('\n'),
    };
  }

  /**
   * Export the current session transcript (/export [markdown|json])
   */
  public exportTranscript(format: 'markdown' | 'json' = 'markdown'): string {
    const session = this.getSession();
    if (format === 'json') {
      return DshTranscriptExporter.toJson(session);
    }
    return DshTranscriptExporter.toMarkdown(session);
  }
}
