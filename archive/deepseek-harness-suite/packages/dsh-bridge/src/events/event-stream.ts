import { EventEmitter } from 'node:events';
import type { DshEvent, DshAgentStatus, DshApprovalRequest, DshToolCall, DshUsageMetrics } from '../types/index.js';
import { DshRiskEvaluator } from '../security/risk-evaluator.js';

export type DshEventListener<T extends DshEvent = DshEvent> = (event: T) => void;

/**
 * Reactive Event Bus providing standardized event streams for TUI and Desktop.
 */
export class DshEventStream {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
    // emitEvent() re-emits each event by its `type`. A normalized event typed
    // 'error' then collides with the EventEmitter control channel and throws
    // ERR_UNHANDLED_ERROR when nobody subscribed through the private emitter.
    // The public surface (on()/onEvent()) only ever listens on the 'event'
    // bus, so that typed channel can never gain subscribers — keep it inert
    // instead of crashing the host process.
    this.emitter.on('error', () => {});
  }

  /**
   * Subscribe to all normalized events
   */
  public onEvent(listener: DshEventListener): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  /**
   * Subscribe to specific event types
   */
  public on<K extends DshEvent['type']>(
    type: K,
    listener: (event: Extract<DshEvent, { type: K }>) => void
  ): () => void {
    const wrapped = (event: DshEvent) => {
      if (event.type === type) {
        listener(event as Extract<DshEvent, { type: K }>);
      }
    };
    this.emitter.on('event', wrapped);
    return () => this.emitter.off('event', wrapped);
  }

  /**
   * Emit a normalized DshEvent
   */
  public emitEvent(event: DshEvent): void {
    this.emitter.emit('event', event);
    this.emitter.emit(event.type, event);
  }

  /**
   * Project raw upstream @deepseek-ai/dsh events into clean normalized events.
   * Isolates upstream schema changes to this single transformer method.
   */
  public projectRawUpstreamEvent(rawEvent: Record<string, any>): void {
    if (!rawEvent || typeof rawEvent !== 'object') return;

    const rawType = String(rawEvent.type || rawEvent.event || '');
    const data = rawEvent.data || rawEvent;

    switch (rawType) {
      // 1. Assistant Chunk & Reasoning
      case 'assistant/chunk': {
        const chunk = data.chunk || data;
        const isReasoning = chunk.type === 'reasoning' || chunk.blockType === 'reasoning' || data.isReasoning;
        const delta = String(chunk.delta || chunk.text || chunk.content || '');

        if (isReasoning) {
          this.emitEvent({
            type: 'stream:reasoning',
            delta,
            fullContent: delta,
          });
        } else {
          this.emitEvent({
            type: 'stream:content',
            delta,
            fullContent: delta,
          });
        }
        break;
      }

      case 'agent.thought':
      case 'reasoning_content':
      case 'stream:thought': {
        const delta = rawEvent.delta || rawEvent.chunk || '';
        const full = rawEvent.content || rawEvent.text || '';
        this.emitEvent({
          type: 'stream:reasoning',
          delta,
          fullContent: full,
        });
        break;
      }

      case 'assistant/message':
      case 'agent.message':
      case 'content':
      case 'stream:content': {
        const delta = data.delta || data.chunk || '';
        const full = data.content || data.text || '';
        this.emitEvent({
          type: 'stream:content',
          delta,
          fullContent: full,
        });
        break;
      }

      case 'metrics.update':
      case 'usage': {
        const metrics: Partial<DshUsageMetrics> = {
          promptTokens: rawEvent.promptTokens ?? rawEvent.prompt_tokens,
          completionTokens: rawEvent.completionTokens ?? rawEvent.completion_tokens,
          totalTokens: rawEvent.totalTokens ?? rawEvent.total_tokens,
          tps: rawEvent.tps ?? rawEvent.tokens_per_second ?? 0,
          contextLimit: rawEvent.contextLimit ?? 128000,
          contextUsagePercent: rawEvent.contextUsagePercent ?? 0,
        };
        this.emitEvent({
          type: 'stream:metrics',
          metrics,
        });
        break;
      }

      case 'tool/call':
      case 'tool.call':
      case 'tool.invoke': {
        const name = data.name || data.tool || 'unknown_tool';
        const args = data.args || data.arguments || {};
        const explicitApproval = data.requiresApproval;

        // Only trusted policy values are accepted from the wire; anything else
        // (including 'unrestricted') falls back to the conservative auto_safe default.
        const wirePolicy = data.approvalPolicy;
        const approvalPolicy: 'auto_safe' | 'strict' =
          wirePolicy === 'auto_safe' || wirePolicy === 'strict' ? wirePolicy : 'auto_safe';

        // Auto-approve safe read-only operations; require approval for destructive or high-risk tasks
        const evaluation = DshRiskEvaluator.evaluate(name, args, explicitApproval, approvalPolicy);
        const riskLevel = data.riskLevel || evaluation.riskLevel;
        const requiresApproval = evaluation.requiresApproval;

        const toolCall: DshToolCall = {
          id: data.id || rawEvent.id || String(Date.now()),
          name,
          args,
          status: requiresApproval ? 'pending_approval' : 'running',
          riskLevel,
          diff: data.diff,
          startedAt: rawEvent.time || Date.now(),
        };

        this.emitEvent({
          type: 'tool:requested',
          toolCall,
        });

        if (requiresApproval) {
          const approval: DshApprovalRequest = {
            id: `appr_${toolCall.id}`,
            toolCall,
            promptMessage: data.promptMessage || `Approve tool execution: ${toolCall.name}${evaluation.reason ? ` (${evaluation.reason})` : ''}`,
            riskLevel: toolCall.riskLevel,
            timestamp: rawEvent.time || Date.now(),
          };
          this.emitEvent({
            type: 'tool:approval_needed',
            approval,
          });
        }
        break;
      }

      case 'tool/result':
      case 'tool.result':
      case 'tool.finish': {
        const toolCallId = data.id || data.toolCallId || rawEvent.id;
        const status = (data.error || rawEvent.error) ? 'failed' : 'success';
        const output = typeof data.result === 'string'
          ? data.result
          : (data.output || data.result || rawEvent.output || rawEvent.result);

        this.emitEvent({
          type: 'tool:output',
          toolCallId,
          output: typeof output === 'string' ? output : JSON.stringify(output || {}),
        });

        this.emitEvent({
          type: 'tool:finished',
          toolCallId,
          status,
          output: typeof output === 'string' ? output : JSON.stringify(output || {}),
          error: data.error || rawEvent.error,
        });
        break;
      }

      case 'approval/asked': {
        const approval: DshApprovalRequest = {
          id: data.id || `appr_${Date.now()}`,
          toolCall: {
            id: data.toolCallId || data.id,
            name: data.tool || data.name || 'unknown',
            args: data.args || {},
            status: 'pending_approval',
            riskLevel: 'high',
            startedAt: rawEvent.time || Date.now(),
          },
          riskLevel: 'high',
          promptMessage: data.message || `Approval required for tool ${data.tool || data.name}`,
          timestamp: rawEvent.time || Date.now(),
        };
        this.emitEvent({
          type: 'tool:approval_needed',
          approval,
        });
        break;
      }

      case 'agent.state':
      case 'status': {
        let status: DshAgentStatus = 'idle';
        const rawStatus = String(rawEvent.status || rawEvent.state).toLowerCase();
        if (rawStatus.includes('think')) status = 'thinking';
        else if (rawStatus.includes('gen') || rawStatus.includes('stream')) status = 'generating';
        else if (rawStatus.includes('approv')) status = 'awaiting_approval';
        else if (rawStatus.includes('tool') || rawStatus.includes('exec')) status = 'executing_tool';
        else if (rawStatus.includes('interrupt') || rawStatus.includes('cancel')) status = 'interrupted';
        else if (rawStatus.includes('err')) status = 'error';

        this.emitEvent({
          type: 'agent:status',
          status,
          payload: rawEvent,
        });
        break;
      }

      case 'error': {
        this.emitEvent({
          type: 'error',
          message: rawEvent.message || 'Unknown runtime error',
          code: rawEvent.code,
          fatal: rawEvent.fatal ?? false,
        });
        break;
      }

      default:
        break;
    }
  }

  public removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
