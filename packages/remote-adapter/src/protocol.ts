import { RemoteProtocolError } from './errors.js'

export const REMOTE_PROTOCOL_VERSION = 1 as const

export type Capability =
  | 'observe'
  | 'prompt'
  | 'approve'
  | 'answer-question'

export type AgentEngineId = 'dsh' | 'claude' | 'codex' | 'opencode' | 'acp' | (string & {})

export type RemoteMethod =
  | 'session.list'
  | 'session.attach'
  | 'session.history'
  | 'session.search'
  | 'session.create'
  | 'session.rename'
  | 'session.fork'
  | 'engine.list'
  | 'workspace.git.status'
  | 'workspace.git.diff'
  | 'prompt.submit'
  | 'turn.abort'
  | 'approval.respond'
  | 'question.respond'
  | 'model.list'
  | 'model.select'
  | 'command.list'
  | 'command.execute'
  | 'skill.list'
  | 'workspace.upload.open'
  | 'workspace.upload.chunk'
  | 'workspace.upload.commit'
  | 'workspace.upload.abort'
  | 'stream.ack'
  | 'ping'

const REMOTE_METHODS = new Set<RemoteMethod>([
  'session.list',
  'session.attach',
  'session.history',
  'session.search',
  'session.create',
  'session.rename',
  'session.fork',
  'engine.list',
  'workspace.git.status',
  'workspace.git.diff',
  'prompt.submit',
  'turn.abort',
  'approval.respond',
  'question.respond',
  'model.list',
  'model.select',
  'command.list',
  'command.execute',
  'skill.list',
  'workspace.upload.open',
  'workspace.upload.chunk',
  'workspace.upload.commit',
  'workspace.upload.abort',
  'stream.ack',
  'ping',
])

export interface RemoteRequest<T = unknown> {
  readonly jsonrpc: '2.0'
  readonly id: string
  readonly method: RemoteMethod
  readonly protocolVersion: number
  readonly connectionEpoch: number
  readonly requestSeq: number
  readonly idempotencyKey?: string
  readonly params: T
}

export interface AuthenticatedPeer {
  readonly deviceId: string
  readonly connectionEpoch: number
}

export interface SessionRef {
  readonly id: string
  readonly engine?: AgentEngineId | undefined
  readonly nativeSessionId?: string | undefined
  readonly title?: string
  readonly updatedAtMs?: number | undefined
  readonly cwd?: string | undefined
  readonly status?: 'running' | 'idle' | undefined
  readonly preview?: string | undefined
  readonly model?: ModelSelectionParams | undefined
  readonly pendingApprovals?: number | undefined
  readonly pendingQuestions?: number | undefined
}

export interface OfficialSessionEvent {
  readonly seq: number
  readonly type: string
  readonly data?: unknown
}

export type PromptImageMediaType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/gif'

export interface PromptImageAttachment {
  readonly type: 'image'
  readonly mediaType: PromptImageMediaType
  readonly dataBase64: string
  readonly name?: string | undefined
}

export interface PromptSubmitParams {
  readonly sessionId: string
  readonly prompt: string
  readonly mode?: PromptSubmitMode | undefined
  readonly attachments?: readonly PromptImageAttachment[] | undefined
}

export interface ApprovalRespondParams {
  readonly callId: string
  readonly decision: 'approved' | 'rejected'
}

export interface QuestionRespondParams {
  readonly questionId: string
  readonly answer: unknown
}

export interface SessionAttachParams {
  readonly sessionId: string
  readonly afterSeq?: number
}

export interface StreamAckParams {
  readonly sessionId: string
  readonly seq: number
}

export type PromptSubmitMode = 'followup' | 'steer'

export interface FollowupOptions {
  readonly mode?: PromptSubmitMode | undefined
  readonly attachments?: readonly PromptImageAttachment[] | undefined
}

export interface CreateSessionParams {
  readonly sessionId?: string | undefined
  readonly title?: string | undefined
  readonly engine?: AgentEngineId | undefined
  readonly cwd?: string | undefined
  readonly model?: ModelSelectionParams | undefined
}

export interface RenameSessionParams {
  readonly sessionId: string
  readonly title: string
}

export interface TurnAbortParams {
  readonly sessionId: string
  readonly keepInbox?: boolean | undefined
}

export interface ReasoningEffortOption {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
}

export interface ModelSelectionParams {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
}

export interface ModelOptionRef {
  readonly provider: string
  readonly providerName?: string | undefined
  readonly model: string
  readonly name: string
  readonly description?: string | undefined
  readonly supportsImageInput?: boolean | undefined
  readonly reasoningEfforts?: readonly ReasoningEffortOption[] | undefined
  readonly defaultReasoningEffort?: string | undefined
  readonly contextWindow?: number | undefined
}

export interface ModelCatalogResult {
  readonly current?: ModelSelectionParams | undefined
  readonly models: readonly ModelOptionRef[]
}

export interface PendingApprovalSnapshot {
  readonly callId: string
  readonly toolName: string
  readonly reason?: string | undefined
  readonly summary?: string | undefined
  readonly sessionId?: string | undefined
}

export interface PendingQuestionSnapshot {
  readonly questionId: string
  readonly prompt: string
  readonly questions?: readonly unknown[] | undefined
  readonly sessionId?: string | undefined
}

export interface TodoItemSnapshot {
  readonly id?: string | undefined
  readonly content: string
  readonly status: string
  readonly priority?: string | undefined
}

export interface SessionUsageSnapshot {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number | undefined
  readonly cacheWriteTokens?: number | undefined
  readonly totalTokens: number
  readonly turns: number
}

export interface SessionLiveStateSnapshot {
  readonly status: 'running' | 'idle'
  readonly model?: ModelSelectionParams | undefined
  readonly title?: string | undefined
  readonly pendingApprovals: readonly PendingApprovalSnapshot[]
  readonly pendingQuestions: readonly PendingQuestionSnapshot[]
  readonly todos: readonly TodoItemSnapshot[]
  readonly usage?: SessionUsageSnapshot | undefined
  readonly oldestSeq?: number | null | undefined
  readonly latestSeq?: number | null | undefined
  readonly hasMoreHistory?: boolean | undefined
  readonly turnCount?: number | undefined
}

export interface SessionHistoryParams {
  readonly sessionId: string
  readonly beforeSeq?: number | undefined
  readonly limit?: number | undefined
  readonly minTurns?: number | undefined
}

export interface SessionHistoryResult {
  readonly sessionId: string
  readonly events: readonly { readonly seq: number; readonly type: string; readonly time?: number | undefined; readonly data?: unknown }[]
  readonly hasMore: boolean
  readonly oldestSeq: number | null
  readonly latestSeq: number | null
  readonly source: 'live' | 'disk'
}

export interface SessionForkParams {
  readonly sessionId: string
  readonly atSeq?: number | undefined
  readonly title?: string | undefined
}

export interface SessionSearchParams {
  readonly query: string
  readonly sessionId?: string | undefined
  readonly limit?: number | undefined
}

export interface SessionSearchHit {
  readonly sessionId: string
  readonly title?: string | undefined
  readonly seq: number
  readonly type: string
  readonly snippet: string
  readonly updatedAt?: string | undefined
}

export interface SessionSearchResult {
  readonly query: string
  readonly hits: readonly SessionSearchHit[]
  readonly hasMore: boolean
}

export interface RemoteCommandDescriptor {
  readonly name: string
  readonly description: string
  readonly inputHint?: string | undefined
  readonly acceptsAttachments?: boolean | undefined
}

export interface RemoteSkillSummary {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string | undefined
  readonly source?: string | undefined
}

export interface WorkspaceUploadOpenParams {
  readonly sessionId: string
  readonly filename: string
  readonly sizeBytes: number
  readonly chunkBytes?: number | undefined
  readonly sha256?: string | undefined
  readonly conflictPolicy?: 'rename' | 'fail' | undefined
}

export interface WorkspaceUploadOpenResult {
  readonly uploadId: string
  readonly sessionId: string
  readonly chunkBytes: number
  readonly maxBytes: number
  readonly relativePath: string
}

export interface WorkspaceUploadChunkParams {
  readonly uploadId: string
  readonly offset: number
  readonly dataBase64: string
}

export interface WorkspaceUploadChunkResult {
  readonly uploadId: string
  readonly receivedBytes: number
  readonly nextOffset: number
}

export interface WorkspaceUploadCommitParams {
  readonly uploadId: string
  readonly sha256?: string | undefined
}

export interface WorkspaceUploadCommitResult {
  readonly uploadId: string
  readonly sessionId: string
  readonly relativePath: string
  readonly bytesWritten: number
  readonly sha256: string
}

export interface WorkspaceUploadAbortParams {
  readonly uploadId: string
}

export interface WorkspaceUploadAbortResult {
  readonly uploadId: string
  readonly aborted: boolean
}

export interface EngineCapabilityFlags {
  readonly createSession: boolean
  readonly listSessions: boolean
  readonly history: boolean
  readonly abortTurn: boolean
  readonly approvals: boolean
  readonly questions: boolean
  readonly streaming: boolean
  readonly models: boolean
  readonly gitReview: boolean
}

export interface EngineDescriptor {
  readonly id: AgentEngineId
  readonly displayName: string
  readonly available: boolean
  readonly running: boolean
  readonly binaryPath?: string | undefined
  readonly version?: string | undefined
  readonly error?: string | undefined
  readonly capabilities: EngineCapabilityFlags
}

export interface WorkspaceGitStatusParams {
  readonly sessionId: string
}

export interface GitChangedFileSummary {
  readonly path: string
  readonly origPath?: string | undefined
  readonly indexStatus: string
  readonly worktreeStatus: string
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
}

export interface WorkspaceGitStatusResult {
  readonly sessionId: string
  readonly repoRoot: string
  readonly branch: string
  readonly upstream?: string | undefined
  readonly ahead: number
  readonly behind: number
  readonly clean: boolean
  readonly files: readonly GitChangedFileSummary[]
  readonly truncated: boolean
}

export interface WorkspaceGitDiffParams {
  readonly sessionId: string
  readonly path?: string | undefined
  readonly staged?: boolean | undefined
  readonly maxBytes?: number | undefined
}

export interface WorkspaceGitDiffResult {
  readonly sessionId: string
  readonly repoRoot: string
  readonly branch: string
  readonly staged: boolean
  readonly path?: string | undefined
  readonly diff: string
  readonly bytes: number
  readonly truncated: boolean
}

export interface AgentHostBackend {
  listSessions(): Promise<readonly SessionRef[]>
  assertSession(sessionId: string): Promise<void>
  followup(sessionId: string, prompt: string, options?: FollowupOptions): Promise<unknown>
  respondApproval(callId: string, decision: 'approved' | 'rejected'): Promise<unknown>
  respondQuestion(questionId: string, answer: unknown): Promise<unknown>
  listEngines?(): Promise<readonly EngineDescriptor[]>
  getWorkspaceGitStatus?(params: WorkspaceGitStatusParams): Promise<WorkspaceGitStatusResult>
  getWorkspaceGitDiff?(params: WorkspaceGitDiffParams): Promise<WorkspaceGitDiffResult>
  createSession?(options?: CreateSessionParams): Promise<SessionRef>
  renameSession?(sessionId: string, title: string): Promise<SessionRef>
  abortTurn?(sessionId: string, options?: { readonly keepInbox?: boolean | undefined }): Promise<unknown>
  listModels?(sessionId?: string): Promise<ModelCatalogResult>
  selectModel?(sessionId: string, selection: ModelSelectionParams): Promise<unknown>
  getSessionLiveState?(sessionId: string): Promise<SessionLiveStateSnapshot | undefined>
  getSessionHistory?(params: SessionHistoryParams): Promise<SessionHistoryResult>
  forkSession?(params: SessionForkParams): Promise<SessionRef>
  searchSessions?(params: SessionSearchParams): Promise<SessionSearchResult>
  listCommands?(sessionId?: string): Promise<readonly RemoteCommandDescriptor[]>
  executeCommand?(sessionId: string, command: string): Promise<{ readonly ok: boolean; readonly commandId?: string | undefined; readonly output?: string | undefined; readonly error?: string | undefined }>
  listSkills?(sessionId?: string): Promise<readonly RemoteSkillSummary[]>
  openWorkspaceUpload?(deviceId: string, params: WorkspaceUploadOpenParams): Promise<WorkspaceUploadOpenResult>
  appendWorkspaceUploadChunk?(deviceId: string, params: WorkspaceUploadChunkParams): Promise<WorkspaceUploadChunkResult>
  commitWorkspaceUpload?(deviceId: string, params: WorkspaceUploadCommitParams): Promise<WorkspaceUploadCommitResult>
  abortWorkspaceUpload?(deviceId: string, params: WorkspaceUploadAbortParams): Promise<WorkspaceUploadAbortResult>
}

export type OfficialRemoteSeams = AgentHostBackend

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseRemoteRequest(input: unknown): RemoteRequest {
  if (!isRecord(input)) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'request must be an object')
  }

  const {
    jsonrpc,
    id,
    method,
    protocolVersion,
    connectionEpoch,
    requestSeq,
    idempotencyKey,
  } = input

  if (jsonrpc !== '2.0') {
    throw new RemoteProtocolError('INVALID_REQUEST', 'jsonrpc must equal 2.0')
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'request id is required')
  }
  if (typeof method !== 'string' || !REMOTE_METHODS.has(method as RemoteMethod)) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'unknown remote method')
  }
  if (!Number.isSafeInteger(protocolVersion)) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'protocolVersion must be an integer')
  }
  if (!Number.isSafeInteger(connectionEpoch) || (connectionEpoch as number) < 1) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'connectionEpoch must be positive')
  }
  if (!Number.isSafeInteger(requestSeq) || (requestSeq as number) < 1) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'requestSeq must be positive')
  }
  if (
    idempotencyKey !== undefined
    && (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0)
  ) {
    throw new RemoteProtocolError(
      'INVALID_REQUEST',
      'idempotencyKey must be a non-empty string',
    )
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'params')) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'params is required')
  }

  return input as unknown as RemoteRequest
}
