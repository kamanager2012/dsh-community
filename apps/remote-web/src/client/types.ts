export type AgentEngineId = 'dsh' | 'claude' | 'codex' | 'opencode' | 'acp' | (string & {})

export type TransportKind = 'lan' | 'webrtc' | 'relay'

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'handshaking'
  | 'pairing'
  | 'active'
  | 'reconnecting'
  | 'revoked'
  | 'epoch_mismatch'
  | 'error'

export interface PairingBootstrapDescriptor {
  readonly protocolVersion: number
  readonly hostPublicKeyHex: string
  readonly hostFingerprint: string
  readonly bootstrapToken: string
  readonly endpointUrl: string
  readonly expiresAt: number
  readonly signalingUrl?: string | undefined
  readonly signalingRoomId?: string | undefined
  readonly stunUrls?: readonly string[] | undefined
  readonly relayUrl?: string | undefined
  readonly relayRoomId?: string | undefined
}

export interface TrustedHostProfile {
  readonly hostFingerprint: string
  readonly hostPublicKeyHex: string
  readonly label: string
  readonly endpointUrl: string
  readonly relayUrl?: string | undefined
  readonly relayRoomId?: string | undefined
  readonly signalingUrl?: string | undefined
  readonly signalingRoomId?: string | undefined
  readonly stunUrls?: readonly string[] | undefined
  readonly lastEpoch: number
  readonly pairedAt: number
  readonly lastConnectedAt: number
  readonly preferredTransport?: TransportKind | undefined
}

export interface SessionWorkspaceSummary {
  readonly repoRoot?: string | undefined
  readonly commonRepoRoot?: string | undefined
  readonly worktreeName?: string | undefined
  readonly isWorktree?: boolean | undefined
  readonly branch?: string | undefined
  readonly dirty?: boolean | undefined
  readonly changedFiles?: number | undefined
  readonly ahead?: number | undefined
  readonly behind?: number | undefined
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

export interface CreateSessionParams {
  readonly sessionId?: string | undefined
  readonly title?: string | undefined
  readonly engine?: AgentEngineId | undefined
  readonly cwd?: string | undefined
  readonly model?: ModelSelectionParams | undefined
}

export interface SessionRef {
  readonly id: string
  readonly engine?: AgentEngineId | undefined
  readonly nativeSessionId?: string | undefined
  readonly title?: string | undefined
  readonly updatedAtMs?: number | undefined
  readonly cwd?: string | undefined
  readonly status?: 'running' | 'idle' | undefined
  readonly preview?: string | undefined
  readonly model?: ModelSelectionParams | undefined
  readonly pendingApprovals?: number | undefined
  readonly pendingQuestions?: number | undefined
  readonly workspace?: SessionWorkspaceSummary | undefined
}

export interface OfficialSessionEvent {
  readonly seq: number
  readonly type: string
  readonly time?: number | undefined
  readonly data?: unknown
}

export interface PendingApprovalSnapshot {
  readonly callId: string
  readonly toolName: string
  readonly reason?: string | undefined
  readonly summary?: string | undefined
  readonly args?: unknown
  readonly argsTruncated?: boolean | undefined
  readonly sessionId?: string | undefined
}

export interface PendingQuestionOption {
  readonly label: string
  readonly description?: string | undefined
}

export const MAX_NOISE_PLAINTEXT_BYTES = 65_519
export const MAX_PROMPT_IMAGE_COUNT = 2
export const MAX_PROMPT_IMAGE_DECODED_BYTES = 32_768

export interface PendingQuestionPrompt {
  readonly id?: string | undefined
  readonly header?: string | undefined
  readonly question: string
  readonly multiSelect?: boolean | undefined
  readonly options?: readonly PendingQuestionOption[] | undefined
}

export interface PendingQuestionSnapshot {
  readonly questionId: string
  readonly prompt: string
  readonly questions?: readonly PendingQuestionPrompt[] | undefined
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

export type SessionAttachResult =
  | {
      readonly kind: 'events'
      readonly events: readonly OfficialSessionEvent[]
      readonly liveState?: SessionLiveStateSnapshot | undefined
    }
  | {
      readonly kind: 'reset'
      readonly reason: string
      readonly oldestSeq?: number | null | undefined
      readonly latestSeq?: number | null | undefined
      readonly liveState?: SessionLiveStateSnapshot | undefined
    }

export interface SessionHistoryResult {
  readonly sessionId: string
  readonly events: readonly OfficialSessionEvent[]
  readonly hasMore: boolean
  readonly oldestSeq: number | null
  readonly latestSeq: number | null
  readonly source: 'live' | 'disk'
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
  readonly commonRepoRoot?: string | undefined
  readonly isWorktree?: boolean | undefined
  readonly worktreeName?: string | undefined
  readonly branch: string
  readonly upstream?: string | undefined
  readonly ahead: number
  readonly behind: number
  readonly clean: boolean
  readonly files: readonly GitChangedFileSummary[]
  readonly truncated: boolean
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

export interface WorkspaceFilesResult {
  readonly sessionId: string
  readonly root: string
  readonly files: readonly string[]
  readonly totalMatched: number
  readonly truncated: boolean
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

export type TimelineItem =
  | {
      readonly kind: 'user'
      readonly id: string
      readonly seq: number
      readonly text: string
      readonly attachments: readonly string[]
      readonly optimistic?: boolean | undefined
    }
  | {
      readonly kind: 'assistant'
      readonly id: string
      readonly seq: number
      readonly thinkingText: string
      readonly markdownText: string
      readonly finalized: boolean
      readonly interrupted?: boolean | undefined
    }
  | {
      readonly kind: 'tool'
      readonly id: string
      readonly seq: number
      readonly callId: string
      readonly toolName: string
      readonly argumentsText: string
      readonly outputText: string
      readonly status: 'running' | 'completed' | 'error'
    }
  | {
      readonly kind: 'notice'
      readonly id: string
      readonly seq: number
      readonly text: string
      readonly isError: boolean
    }

/**
 * Maximum raw byte count requested for `workspace.git.diff` so the serialized JSON-RPC
 * response (including JSON escaping and RPC envelope fields) safely fits inside a single
 * 65,536-byte Noise WebSocket/DataChannel transport frame (65,519-byte plaintext cap).
 */
export const SAFE_GIT_DIFF_MAX_BYTES = 24_576
