import type {
  AgentEngineId,
  AgentHostBackend,
  CreateSessionParams,
  EngineDescriptor,
  FollowupOptions,
  ModelCatalogResult,
  ModelSelectionParams,
  OfficialSessionEvent,
  RemoteCommandDescriptor,
  RemoteSkillSummary,
  SessionForkParams,
  SessionHistoryParams,
  SessionHistoryResult,
  SessionLiveStateSnapshot,
  SessionRef,
  SessionSearchParams,
  SessionSearchResult,
  WorkspaceGitDiffParams,
  WorkspaceGitDiffResult,
  WorkspaceGitStatusParams,
  WorkspaceGitStatusResult,
} from '../protocol.js'
import { inspectWorkspaceGitDiff, inspectWorkspaceGitStatus } from './git-review.js'
import {
  findBinaryOnPath,
  probeBinaryVersion,
  type ManagedAgentBackend,
} from './types.js'

export interface DshBackendOptions {
  readonly seams: AgentHostBackend
  readonly defaultCwd?: string | undefined
  readonly binaryName?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly checkAvailable?: (() => boolean) | undefined
}

/**
 * Wraps the existing DSH AgentHostBackend (typically OfficialHostCordisBridge or mock seams)
 * as a first-class ManagedAgentBackend without altering DSH session IDs or legacy SessionRef fields.
 */
export class DshAgentBackend implements ManagedAgentBackend {
  readonly engineId: AgentEngineId = 'dsh'
  readonly displayName = 'DeepSeek Harness (DSH)'
  private readonly binaryName: string
  private readonly env: NodeJS.ProcessEnv
  private readonly defaultCwd: string

  constructor(private readonly options: DshBackendOptions) {
    this.binaryName = options.binaryName ?? 'dsh'
    this.env = options.env ?? process.env
    this.defaultCwd = options.defaultCwd ?? process.cwd()
  }

  async probe(): Promise<EngineDescriptor> {
    const binaryPath = findBinaryOnPath(this.binaryName, this.env)
    const version = binaryPath ? await probeBinaryVersion(binaryPath, ['--version'], this.env) : undefined
    const hasApiKey = Boolean(this.env.DEEPSEEK_API_KEY?.trim())
    const available = this.options.checkAvailable ? this.options.checkAvailable() : hasApiKey || Boolean(binaryPath)
    return {
      id: this.engineId,
      displayName: this.displayName,
      available,
      running: true,
      ...(binaryPath !== undefined ? { binaryPath } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(!hasApiKey ? { error: 'DEEPSEEK_API_KEY not configured (optional if using other engines)' } : {}),
      capabilities: {
        createSession: typeof this.options.seams.createSession === 'function',
        listSessions: true,
        history: typeof this.options.seams.getSessionHistory === 'function',
        abortTurn: typeof this.options.seams.abortTurn === 'function',
        approvals: true,
        questions: true,
        streaming: true,
        models: typeof this.options.seams.listModels === 'function',
        gitReview: true,
      },
    }
  }

  async listSessions(): Promise<readonly SessionRef[]> {
    return this.options.seams.listSessions()
  }

  async assertSession(sessionId: string): Promise<void> {
    return this.options.seams.assertSession(sessionId)
  }

  async followup(sessionId: string, prompt: string, options?: FollowupOptions): Promise<unknown> {
    return this.options.seams.followup(sessionId, prompt, options)
  }

  async respondApproval(callId: string, decision: 'approved' | 'rejected'): Promise<unknown> {
    return this.options.seams.respondApproval(callId, decision)
  }

  async respondQuestion(questionId: string, answer: unknown): Promise<unknown> {
    return this.options.seams.respondQuestion(questionId, answer)
  }

  async createSession(options?: CreateSessionParams): Promise<SessionRef> {
    if (!this.options.seams.createSession) {
      throw new Error('session.create is not supported by DSH backend')
    }
    return this.options.seams.createSession(options)
  }

  async renameSession(sessionId: string, title: string): Promise<SessionRef> {
    if (!this.options.seams.renameSession) {
      throw new Error('session.rename is not supported by DSH backend')
    }
    return this.options.seams.renameSession(sessionId, title)
  }

  async abortTurn(sessionId: string, options?: { readonly keepInbox?: boolean | undefined }): Promise<unknown> {
    if (!this.options.seams.abortTurn) {
      throw new Error('turn.abort is not supported by DSH backend')
    }
    return this.options.seams.abortTurn(sessionId, options)
  }

  async listModels(sessionId?: string): Promise<ModelCatalogResult> {
    if (!this.options.seams.listModels) return { models: [] }
    return this.options.seams.listModels(sessionId)
  }

  async selectModel(sessionId: string, selection: ModelSelectionParams): Promise<unknown> {
    if (!this.options.seams.selectModel) {
      throw new Error('model.select is not supported by DSH backend')
    }
    return this.options.seams.selectModel(sessionId, selection)
  }

  async getSessionLiveState(sessionId: string): Promise<SessionLiveStateSnapshot | undefined> {
    return this.options.seams.getSessionLiveState?.(sessionId)
  }

  async getSessionHistory(params: SessionHistoryParams): Promise<SessionHistoryResult> {
    if (!this.options.seams.getSessionHistory) {
      throw new Error('session.history is not supported by DSH backend')
    }
    return this.options.seams.getSessionHistory(params)
  }

  async forkSession(params: SessionForkParams): Promise<SessionRef> {
    if (!this.options.seams.forkSession) {
      throw new Error('session.fork is not supported by DSH backend')
    }
    return this.options.seams.forkSession(params)
  }

  async searchSessions(params: SessionSearchParams): Promise<SessionSearchResult> {
    if (!this.options.seams.searchSessions) {
      return { query: params.query, hits: [], hasMore: false }
    }
    return this.options.seams.searchSessions(params)
  }

  async listCommands(sessionId?: string): Promise<readonly RemoteCommandDescriptor[]> {
    return this.options.seams.listCommands ? this.options.seams.listCommands(sessionId) : []
  }

  async executeCommand(sessionId: string, command: string): Promise<{ readonly ok: boolean; readonly commandId?: string | undefined; readonly output?: string | undefined; readonly error?: string | undefined }> {
    if (!this.options.seams.executeCommand) {
      throw new Error('command.execute is not supported by DSH backend')
    }
    return this.options.seams.executeCommand(sessionId, command)
  }

  async listSkills(sessionId?: string): Promise<readonly RemoteSkillSummary[]> {
    return this.options.seams.listSkills ? this.options.seams.listSkills(sessionId) : []
  }

  async getSessionCwd(sessionId: string): Promise<string | undefined> {
    const sessions = await this.options.seams.listSessions()
    const match = sessions.find((s) => s.id === sessionId)
    return match?.cwd ?? this.defaultCwd
  }

  async getWorkspaceGitStatus(params: WorkspaceGitStatusParams): Promise<WorkspaceGitStatusResult> {
    if (this.options.seams.getWorkspaceGitStatus) {
      return this.options.seams.getWorkspaceGitStatus(params)
    }
    const cwd = (await this.getSessionCwd(params.sessionId)) ?? this.defaultCwd
    return inspectWorkspaceGitStatus(params.sessionId, cwd)
  }

  async getWorkspaceGitDiff(params: WorkspaceGitDiffParams): Promise<WorkspaceGitDiffResult> {
    if (this.options.seams.getWorkspaceGitDiff) {
      return this.options.seams.getWorkspaceGitDiff(params)
    }
    const cwd = (await this.getSessionCwd(params.sessionId)) ?? this.defaultCwd
    return inspectWorkspaceGitDiff(params, cwd)
  }

  onEvent?: (listener: (sessionId: string, events: readonly OfficialSessionEvent[]) => void) => () => void
}
