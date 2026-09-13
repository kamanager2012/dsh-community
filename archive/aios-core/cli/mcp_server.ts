/**
 * AIOS Model Context Protocol (MCP) Server
 * 
 * Exposes AIOS Evidence Gate, Contract Verification, and Tamper-evident Audit
 * as standard MCP Tools over JSON-RPC (Stdio), compatible with Claude Code, Cursor, Windsurf, etc.
 */

import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateReliability } from '../kernel/reliability.js';
import type { TaskContract, EvidenceItem, Decision } from '../kernel/schema/index.js';
import { AuditLog } from '../governor/audit.js';
import { MemoryStore } from '../memory/index.js';

interface McpRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: any;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

// Default root is unique per process (pid-suffixed). AuditLog now waits for
// seq recovery before the first append, but two processes sharing one directory
// can still collide on files. Set AIOS_MCP_AUDIT_ROOT to pin a single instance.
const auditMemory = new MemoryStore({
  root: process.env.AIOS_MCP_AUDIT_ROOT ?? join(tmpdir(), `aios-mcp-audit-${process.pid}`),
});
const auditLog = new AuditLog({
  memory: auditMemory,
  now: () => new Date().toISOString(),
  newId: randomUUID,
});

const TOOLS = [
  {
    name: 'aios_verify_evidence',
    description: 'Verify software engineering task outcome evidence against strict contract acceptance criteria (Fail-Closed gate).',
    inputSchema: {
      type: 'object',
      properties: {
        contract: {
          type: 'object',
          description: 'Task acceptance contract defining required evidence, minimum passing tests, and required invariants.'
        },
        evidence: {
          type: 'array',
          description: 'Collected evidence items (test, build, diff, invariant).'
        }
      },
      required: ['contract', 'evidence']
    }
  },
  {
    name: 'aios_record_audit',
    description: 'Append a task phase-transition entry into the tamper-evident, sequence-stamped AIOS audit log (per Charter §7).',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task identifier this entry belongs to.' },
        phase: {
          type: 'string',
          enum: ['IDLE', 'PLAN', 'EXECUTE', 'VERIFY', 'COMMIT', 'DONE', 'ROLLBACK'],
          description: 'Lifecycle phase this entry records.'
        },
        decision: {
          type: 'string',
          enum: ['COMMIT', 'ROLLBACK'],
          description: 'Optional COMMIT/ROLLBACK decision associated with this entry.'
        },
        note: { type: 'string', description: 'Human-readable summary stored on the entry.' }
      },
      required: ['taskId', 'phase']
    }
  }
];

export async function handleMcpMessage(msg: McpRequest): Promise<McpResponse> {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'aios-mcp-server', version: '0.2.0' }
      }
    };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS }
    };
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};

    if (name === 'aios_verify_evidence') {
      const verdict = evaluateReliability(args.contract as TaskContract, args.evidence as EvidenceItem[]);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(verdict, null, 2)
            }
          ]
        }
      };
    }

    if (name === 'aios_record_audit') {
      await auditLog.append({
        at: new Date().toISOString(),
        taskId: args.taskId,
        phase: args.phase,
        ...(args.decision ? { decision: args.decision as Decision } : {}),
        ...(args.note ? { result: args.note } : {}),
      });
      const entry = auditLog.bySeq(auditLog.seq());
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(entry, null, 2)
            }
          ]
        }
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Tool not found: ${name}` }
    };
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  };
}

export function startMcpServer() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    try {
      const request: McpRequest = JSON.parse(line);
      const response = await handleMcpMessage(request);
      process.stdout.write(JSON.stringify(response) + '\n');
    } catch (e: any) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: `Parse error: ${e.message}` }
        }) + '\n'
      );
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer();
}
