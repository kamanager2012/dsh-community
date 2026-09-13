/**
 * @dsh-community/dsh-bridge
 * Normalized Contract & Type Definitions
 * 
 * Isolates upstream @deepseek-ai/dsh changes from UI consumers (TUI / Desktop).
 */

export type DshRole = 'user' | 'assistant' | 'system' | 'tool';

export type DshAgentStatus = 
  | 'idle'
  | 'thinking'
  | 'generating'
  | 'awaiting_approval'
  | 'executing_tool'
  | 'interrupted'
  | 'error';

export interface DshUsageMetrics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tps: number; // Tokens per second
  contextLimit: number;
  contextUsagePercent: number;
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface DshToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'pending_approval' | 'running' | 'success' | 'failed';
  riskLevel: RiskLevel;
  diff?: string; // Unified diff snippet for file edits
  output?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface DshApprovalRequest {
  id: string;
  toolCall: DshToolCall;
  promptMessage: string;
  riskLevel: RiskLevel;
  timestamp: number;
}

export type DshApprovalDecision = 'allow_once' | 'allow_always' | 'reject';

export interface DshMessage {
  id: string;
  role: DshRole;
  content: string;
  reasoning?: string;
  reasoningContent?: string;
  toolCalls?: DshToolCall[];
  timestamp: number;
  status: 'streaming' | 'complete' | 'error';
}

export interface DshSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  workspacePath: string;
  model: string;
  messages: DshMessage[];
  metrics: DshUsageMetrics;
}

/**
 * Normalized Events emitted by the Bridge Event Stream
 */
export type DshEvent =
  | { type: 'agent:status'; status: DshAgentStatus; payload?: Record<string, unknown> }
  | { type: 'stream:reasoning'; delta: string; fullContent: string }
  | { type: 'stream:content'; delta: string; fullContent: string }
  | { type: 'stream:metrics'; metrics: Partial<DshUsageMetrics> }
  | { type: 'tool:requested'; toolCall: DshToolCall }
  | { type: 'tool:approval_needed'; approval: DshApprovalRequest }
  | { type: 'tool:started'; toolCallId: string }
  | { type: 'tool:output'; toolCallId: string; output: string }
  | { type: 'tool:finished'; toolCallId: string; status: 'success' | 'failed'; output?: string; error?: string }
  | { type: 'session:updated'; session: DshSession }
  | { type: 'session:forked'; originalSessionId: string; newSessionId: string; atTurn: number }
  | { type: 'error'; message: string; code?: string; fatal?: boolean };

export interface DshConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  workspacePath?: string;
  port?: number;
  sandboxMode?: 'strict' | 'workspace_only' | 'unrestricted';
  approvalPolicy?: 'auto_safe' | 'strict' | 'unrestricted';
  runtimeVersion?: string;
  runtimeExecutable?: string;
  runtimeExecutableArgs?: string[];
  disableFallback?: boolean;
  customPlugins?: string[];
}

export interface DshRuntimeHealth {
  running: boolean;
  pid?: number;
  port?: number;
  url?: string;
  uptimeSeconds: number;
  version?: string;
  lastHeartbeat?: number;
}
