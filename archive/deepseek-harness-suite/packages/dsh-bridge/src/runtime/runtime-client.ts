import { 
  DeepSeekHarness, 
  type RunResult, 
  type HarnessNotification 
} from '@deepseek-ai/dsh-sdk-client';
import { spawn, type ChildProcess } from 'node:child_process';
import { DshEventStream } from '../events/event-stream.js';
import type { DshConfig, DshToolCall } from '../types/index.js';

export interface RuntimeExecutionOptions {
  prompt: string;
  config: DshConfig;
  events: DshEventStream;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface RuntimeExecutionResult {
  content: string;
  reasoning?: string;
  sessionId?: string;
  toolCalls?: DshToolCall[];
  tokensUsed?: { prompt: number; completion: number; total: number };
  executionMode: 'sdk_jsonrpc' | 'headless_cli';
}

/**
 * Official DSH Runtime Execution Client (over @deepseek-ai/dsh-sdk-client)
 * 
 * Drives DeepSeek Harness runtime subprocess over stdio JSON-RPC using the
 * official TypeScript SDK client, normalizing wire notifications and SessionEvents
 * into the DshEventStream.
 * 
 * Enforces pre-enqueue only fallback to prevent duplicate execution side-effects.
 */
export class DshRuntimeClient {
  private activeHarness: DeepSeekHarness | null = null;
  private fallbackProcess: ChildProcess | null = null;

  /**
   * Execute prompt turn through official JSON-RPC SDK or fallback CLI
   */
  public async executeTurn(options: RuntimeExecutionOptions): Promise<RuntimeExecutionResult> {
    const { prompt, config, events, sessionId, signal } = options;

    // Replay-hazard latch for the SDK path: flipped ONLY once a successful side
    // effect is confirmed. The official SDK forwards onNotification exclusively
    // after observing the durable inbox receipt (agent/inbox/spliced) for THIS
    // prompt's message id, so the first callback invocation proves the runtime
    // durably enqueued the turn. Failures before that (boot/handshake/prompt
    // dispatch) have produced no side effects and may safely fall back to
    // headless execution; failures after it must never be replayed. Residual
    // gap: enqueue succeeded but the receipt frame itself was lost on stdio
    // before any callback fired — accepted as narrower than blocking every
    // startup failure behind the replay guard.
    let isPromptEnqueuedOrActive = false;
    // Abort handler for the SDK path; unregistered in the finally block below
    // so the caller's signal does not accumulate listeners turn after turn.
    let onAbort: (() => void) | undefined;

    events.emitEvent({
      type: 'agent:status',
      status: 'thinking',
    });

    try {
      // 1. Primary path: Official @deepseek-ai/dsh-sdk-client stdio JSON-RPC
      const harness = new DeepSeekHarness({
        launch: {
          command: config.runtimeExecutable || 'npx',
          args: config.runtimeExecutableArgs || ['-y', `@deepseek-ai/dsh@${config.runtimeVersion || '0.1.0-rc.6'}`, '--profile', 'jsonrpc-agent'],
          cwd: config.workspacePath || process.cwd(),
          env: {
            ...process.env,
            DEEPSEEK_API_KEY: config.apiKey || process.env.DEEPSEEK_API_KEY,
            DEEPSEEK_BASE_URL: config.baseUrl || process.env.DEEPSEEK_BASE_URL,
          },
          requestTimeoutMs: 120000,
        },
        cwd: config.workspacePath || process.cwd(),
        provider: config.provider || 'deepseek-official',
        model: config.model || 'deepseek-reasoner',
        maxTokens: config.maxTokens,
      });

      this.activeHarness = harness;

      if (signal) {
        onAbort = () => this.interrupt();
        signal.addEventListener('abort', onAbort);
      }

      let accumulatedContent = '';
      let accumulatedReasoning = '';
      const toolCalls: DshToolCall[] = [];

      const result: RunResult = await harness.run(prompt, {
        sessionId,
        onNotification: (notif: HarnessNotification) => {
          isPromptEnqueuedOrActive = true;
          // Normalize official SessionEvent envelope from JSON-RPC wire
          if (notif.method === 'session.event' || notif.method === 'session/event') {
            const ev = (notif.params?.event || notif.params) as any;
            const eventType = String(ev?.type || '');
            const data = (ev?.data || ev) as any;

            // 1. Assistant streaming chunks (inspect data.chunk envelope)
            if (eventType === 'assistant/chunk') {
              const chunk = data.chunk || data;
              const isReasoning = chunk.type === 'reasoning' || chunk.blockType === 'reasoning' || data.isReasoning;
              const delta = String(chunk.delta || chunk.text || chunk.content || '');

              if (isReasoning) {
                accumulatedReasoning += delta;
                events.emitEvent({
                  type: 'stream:reasoning',
                  delta,
                  fullContent: accumulatedReasoning,
                });
              } else {
                accumulatedContent += delta;
                events.emitEvent({
                  type: 'agent:status',
                  status: 'generating',
                });
                events.emitEvent({
                  type: 'stream:content',
                  delta,
                  fullContent: accumulatedContent,
                });
              }
            } else if (eventType === 'assistant/message') {
              const text = String(data.content || data.text || '');
              if (text && !accumulatedContent.includes(text)) {
                accumulatedContent += text;
              }
            }

            // 2. Official Tool Call Events (inspect data envelope)
            if (eventType === 'tool/call') {
              const call: DshToolCall = {
                id: data.id || ev.id || `call_${Date.now()}`,
                name: data.name || data.tool || ev.name || 'unknown_tool',
                args: data.args || ev.args || {},
                status: 'running',
                riskLevel: 'medium',
                startedAt: ev.time || Date.now(),
              };
              toolCalls.push(call);
              events.emitEvent({
                type: 'tool:requested',
                toolCall: call,
              });
            } else if (eventType === 'tool/result') {
              const callId = data.id || data.callId || ev.id || 'unknown';
              const target = toolCalls.find(c => c.id === callId);
              const toolStatus = (data.error || ev.error) ? 'failed' : 'success';
              const outputText = typeof data.result === 'string'
                ? data.result
                : JSON.stringify(data.result || data.output || ev.result || {});

              if (target) {
                target.status = toolStatus;
                target.output = outputText;
                target.completedAt = ev.time || Date.now();
              }
              events.emitEvent({
                type: 'tool:output',
                toolCallId: callId,
                output: outputText,
              });
              events.emitEvent({
                type: 'tool:finished',
                toolCallId: callId,
                status: toolStatus,
                output: outputText,
                error: (data.error || ev.error) ? String(data.error || ev.error) : undefined,
              });
            }

            // 3. Official Approval Events (inspect data envelope)
            if (eventType === 'approval/asked') {
              events.emitEvent({
                type: 'tool:approval_needed',
                approval: {
                  id: data.id || ev.id || `appr_${Date.now()}`,
                  toolCall: {
                    id: data.toolCallId || data.id || ev.id,
                    name: data.tool || data.name || 'unknown',
                    args: data.args || {},
                    status: 'pending_approval',
                    riskLevel: 'high',
                    startedAt: ev.time || Date.now(),
                  },
                  riskLevel: 'high',
                  promptMessage: data.message || `Approval required for tool ${data.tool || data.name}`,
                  timestamp: ev.time || Date.now(),
                },
              });
            }
          }
        },
      });

      events.emitEvent({
        type: 'agent:status',
        status: 'idle',
      });

      const finalResponseText = result.finalResponse || accumulatedContent;

      return {
        content: finalResponseText.trim(),
        reasoning: accumulatedReasoning.trim() || undefined,
        sessionId: result.sessionId,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        executionMode: 'sdk_jsonrpc',
      };
    } catch (sdkErr: any) {
      if (config.disableFallback) {
        events.emitEvent({
          type: 'error',
          message: `SDK stdio JSON-RPC transport failed: ${sdkErr.message}`,
        });
        throw sdkErr;
      }

      // PRE-ENQUEUE ONLY FALLBACK: If prompt was already enqueued or active, do NOT replay
      if (isPromptEnqueuedOrActive) {
        const replayHazardError = new Error(
          `SDK JSON-RPC transport failed during active turn execution (${sdkErr.message}). ` +
          `Automatic fallback aborted to prevent duplicate mutation side-effects.`
        );
        events.emitEvent({
          type: 'error',
          message: replayHazardError.message,
        });
        throw replayHazardError;
      }

      // Safe pre-enqueue fallback (e.g. SDK handshake/boot failure)
      events.emitEvent({
        type: 'error',
        message: `SDK stdio JSON-RPC handshake failed (${sdkErr.message}), executing pre-enqueue headless fallback.`,
      });

      return this.executeHeadlessFallback(options);
    } finally {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
      if (this.activeHarness) {
        try {
          await this.activeHarness.close();
        } catch {
          // Ignore close errors
        }
        this.activeHarness = null;
      }
    }
  }

  /**
   * Headless CLI fallback for environments where jsonrpc-agent profile is not initialized
   */
  private async executeHeadlessFallback(options: RuntimeExecutionOptions): Promise<RuntimeExecutionResult> {
    const { prompt, config, events, signal } = options;

    return new Promise<RuntimeExecutionResult>((resolve, reject) => {
      let accumulatedContent = '';

      // '--' guards against the prompt being parsed as downstream CLI flags
      // when it begins with '-'. (Prompt visibility in `ps` and ARG_MAX limits
      // are accepted trade-offs of argv transport.)
      const child = spawn('npx', ['-y', `@deepseek-ai/dsh@${config.runtimeVersion || '0.1.0-rc.6'}`, '--profile', 'headless', '--', prompt], {
        cwd: config.workspacePath || process.cwd(),
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: config.apiKey || process.env.DEEPSEEK_API_KEY,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.fallbackProcess = child;

      // Abort wiring: unregistered on close/error so the signal does not keep
      // this turn's handler alive after the fallback process is gone.
      const onAbort = () => {
        child.kill('SIGTERM');
      };
      if (signal) {
        signal.addEventListener('abort', onAbort);
      }
      const detachAbortListener = () => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      child.stdout.on('data', (data: Buffer) => {
        const text = data.toString('utf-8');
        accumulatedContent += text;
        events.emitEvent({
          type: 'stream:content',
          delta: text,
          fullContent: accumulatedContent,
        });
      });

      child.on('error', (err) => {
        detachAbortListener();
        events.emitEvent({
          type: 'agent:status',
          status: 'error',
          payload: { error: err.message },
        });
        reject(err);
      });

      child.on('close', (code, signal) => {
        detachAbortListener();
        this.fallbackProcess = null;

        // Check both non-zero exit code and signal termination
        if (code !== 0 || signal !== null) {
          const reason = signal ? `terminated by signal ${signal}` : `exited with code ${code}`;
          const errorMsg = `Official DSH headless process failed: ${reason}`;
          events.emitEvent({
            type: 'agent:status',
            status: signal ? 'interrupted' : 'error',
            payload: { error: errorMsg },
          });
          reject(new Error(errorMsg));
          return;
        }

        events.emitEvent({
          type: 'agent:status',
          status: 'idle',
        });

        resolve({
          content: accumulatedContent.trim(),
          executionMode: 'headless_cli',
        });
      });
    });
  }

  /**
   * Interrupt runtime execution through official SDK shutdown ladder or SIGTERM
   */
  public interrupt(): void {
    if (this.activeHarness) {
      this.activeHarness.close().catch(() => {});
      this.activeHarness = null;
    }
    if (this.fallbackProcess) {
      this.fallbackProcess.kill('SIGTERM');
      this.fallbackProcess = null;
    }
  }
}
