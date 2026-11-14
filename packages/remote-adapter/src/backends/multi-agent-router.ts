import { RemoteProtocolError } from '../errors.js'
import type {
  AgentEngineId,
  AgentHostBackend,
  CreateSessionParams,
  EngineDescriptor,
  FollowupOptions,
  ModelCatalogResult,
  ModelOptionRef,
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
  WorkspaceUploadAbortParams,
  WorkspaceUploadAbortResult,
  WorkspaceUploadChunkParams,
  WorkspaceUploadChunkResult,
  WorkspaceUploadCommitParams,
  WorkspaceUploadCommitResult,
  WorkspaceUploadOpenParams,
  WorkspaceUploadOpenResult,
} from '../protocol.js'
import { WorkspaceUploadManager } from '../workspace-upload.js'
import { inspectWorkspaceGitDiff, inspectWorkspaceGitStatus } from './git-review.js'
import { parseNamespacedSessionId, type ManagedAgentBackend } from './types.js'

export interface MultiAgentHostRouterOptions {
  readonly backends: readonly ManagedAgentBackend[]
  readonly defaultEngine?: AgentEngineId | undefined
  readonly defaultCwd?: string | undefined
}

const APPROVAL_PREFIX_TO_ENGINE: ReadonlyArray<readonly [string, AgentEngineId]> = [
  ['codex-apr-', 'codex'],
  ['claude-apr-', 'claude'],
  ['opencode-apr-', 'opencode'],
  ['acp-apr-', 'acp'],
]

const QUESTION_PREFIX_TO_ENGINE: ReadonlyArray<readonly [string, AgentEngineId]> = [
  ['codex-q-', 'codex'],
  ['claude-q-', 'claude'],
]

/**
 * Unified multi-agent AgentHostBackend multiplexer routing RPC operations,
 * streaming session events, approvals, questions, uploads, and scoped Git code review
 * across DSH, Codex, Claude Code, OpenCode ACP, and custom ACP backends.
 */
export class MultiAgentHostRouter implements AgentHostBackend {
  private readonly backendById = new Map<AgentEngineId, ManagedAgentBackend>()
  private readonly orderedBackends: ManagedAgentBackend[]
  private readonly sessionOwner = new Map<string, AgentEngineId>()
  private readonly approvalOwner = new Map<string, AgentEngineId>()
  private readonly questionOwner = new Map<string, AgentEngineId>()
  private readonly uploadOwner = new Map<string, 'dsh' | 'router'>()
  private readonly uploads = new WorkspaceUploadManager()
  private readonly defaultCwd: string
  private readonly defaultEngine: AgentEngineId | undefined
  private readonly eventSubscribers = new Set<
    (sessionId: string, events: readonly OfficialSessionEvent[]) => void
  >()
  private readonly unsubscribes: Array<() => void> = []

  constructor(options: MultiAgentHostRouterOptions) {
    this.orderedBackends = [...options.backends]
    this.defaultCwd = options.defaultCwd ?? process.cwd()
    for (const backend of this.orderedBackends) {
      this.backendById.set(backend.engineId, backend)
      if (backend.onEvent) {
        const unsub = backend.onEvent((sessionId, events) => {
          this.sessionOwner.set(sessionId, backend.engineId)
          for (const ev of events) {
            if ((ev.type === 'approval.request' || ev.type === 'approval/request') && typeof ev.data === 'object' && ev.data !== null) {
              const callId = (ev.data as { callId?: unknown }).callId
              if (typeof callId === 'string') {
                this.approvalOwner.set(callId, backend.engineId)
              }
            }
            if ((ev.type === 'question.request' || ev.type === 'question/ask') && typeof ev.data === 'object' && ev.data !== null) {
              const questionId = (ev.data as { questionId?: unknown }).questionId
              if (typeof questionId === 'string') {
                this.questionOwner.set(questionId, backend.engineId)
              }
            }
          }
          for (const listener of this.eventSubscribers) {
            try {
              listener(sessionId, events)
            } catch {}
          }
        })
        this.unsubscribes.push(unsub)
      }
    }
    this.defaultEngine = options.defaultEngine ?? this.orderedBackends[0]?.engineId
  }

  getBackend(engineId: AgentEngineId): ManagedAgentBackend | undefined {
    return this.backendById.get(engineId)
  }

  onEvent(listener: (sessionId: string, events: readonly OfficialSessionEvent[]) => void): () => void {
    this.eventSubscribers.add(listener)
    return () => {
      this.eventSubscribers.delete(listener)
    }
  }

  async start(): Promise<void> {
    await Promise.allSettled(
      this.orderedBackends.map((b) => (b.start ? b.start() : Promise.resolve())),
    )
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubscribes) unsub()
    this.unsubscribes.length = 0
    this.eventSubscribers.clear()
    this.uploads.disposeAll()
    await Promise.allSettled(
      this.orderedBackends.map((b) => (b.stop ? b.stop() : Promise.resolve())),
    )
  }

  async listEngines(): Promise<readonly EngineDescriptor[]> {
    const settled = await Promise.allSettled(this.orderedBackends.map((b) => b.probe()))
    const out: EngineDescriptor[] = []
    for (let i = 0; i < settled.length; i += 1) {
      const res = settled[i]!
      const backend = this.orderedBackends[i]!
      if (res.status === 'fulfilled') {
        out.push(res.value)
      } else {
        out.push({
          id: backend.engineId,
          displayName: backend.displayName,
          available: false,
          running: false,
          error: res.reason instanceof Error ? res.reason.message : String(res.reason),
          capabilities: {
            createSession: false,
            listSessions: false,
            history: false,
            abortTurn: false,
            approvals: false,
            questions: false,
            streaming: false,
            models: false,
            gitReview: false,
          },
        })
      }
    }
    return out
  }

  async listSessions(): Promise<readonly SessionRef[]> {
    const settled = await Promise.allSettled(
      this.orderedBackends.map(async (backend) => ({
        backend,
        sessions: await backend.listSessions(),
      })),
    )
    const multiEngine = this.orderedBackends.length > 1
    const all: SessionRef[] = []
    for (const entry of settled) {
      if (entry.status !== 'fulfilled') continue
      for (const s of entry.value.sessions) {
        const engine = s.engine ?? entry.value.backend.engineId
        this.sessionOwner.set(s.id, engine)
        if (engine === 'dsh' && !multiEngine && s.engine === undefined) {
          all.push(s)
        } else {
          all.push({
            ...s,
            engine,
          })
        }
      }
    }
    if (multiEngine) {
      all.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0))
    }
    return all
  }

  private async resolveBackendForSession(sessionId: string): Promise<ManagedAgentBackend> {
    const cachedEngine = this.sessionOwner.get(sessionId)
    if (cachedEngine) {
      const b = this.backendById.get(cachedEngine)
      if (b) return b
    }

    const parsed = parseNamespacedSessionId(sessionId)
    if (parsed.engine !== undefined) {
      const explicit = this.backendById.get(parsed.engine)
      if (!explicit) {
        throw new RemoteProtocolError(
          'INVALID_REQUEST',
          `session not found: engine '${String(parsed.engine)}' is not enabled on this host`,
        )
      }
      this.sessionOwner.set(sessionId, explicit.engineId)
      return explicit
    }

    // Legacy unprefixed session IDs route to DSH first if registered, otherwise probe backends in order.
    const dshBackend = this.backendById.get('dsh')
    if (dshBackend) {
      try {
        await dshBackend.assertSession(sessionId)
        this.sessionOwner.set(sessionId, 'dsh')
        return dshBackend
      } catch {}
    }

    for (const backend of this.orderedBackends) {
      if (backend.engineId === 'dsh') continue
      try {
        await backend.assertSession(sessionId)
        this.sessionOwner.set(sessionId, backend.engineId)
        return backend
      } catch {}
    }

    throw new RemoteProtocolError('INVALID_REQUEST', `session not found: ${sessionId}`)
  }

  async assertSession(sessionId: string): Promise<void> {
    const backend = await this.resolveBackendForSession(sessionId)
    await backend.assertSession(sessionId)
    this.sessionOwner.set(sessionId, backend.engineId)
  }

  async createSession(options?: CreateSessionParams): Promise<SessionRef> {
    const requestedEngine = options?.engine
    let target: ManagedAgentBackend | undefined
    if (requestedEngine !== undefined) {
      target = this.backendById.get(requestedEngine)
      if (!target) {
        throw new RemoteProtocolError(
          'INVALID_REQUEST',
          `requested engine '${String(requestedEngine)}' is not enabled on this host`,
        )
      }
    } else if (this.defaultEngine !== undefined) {
      target = this.backendById.get(this.defaultEngine)
    }
    if (!target) {
      target = this.orderedBackends[0]
    }
    if (!target?.createSession) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'session.create is not supported by active host engines')
    }
    const created = await target.createSession(options)
    const result: SessionRef =
      target.engineId === 'dsh' && options?.engine === undefined && created.engine === undefined
        ? created
        : { ...created, engine: created.engine ?? target.engineId }
    this.sessionOwner.set(result.id, target.engineId)
    return result
  }

  async renameSession(sessionId: string, title: string): Promise<SessionRef> {
    const backend = await this.resolveBackendForSession(sessionId)
    if (!backend.renameSession) {
      throw new RemoteProtocolError('INVALID_REQUEST', `session.rename is not supported by '${String(backend.engineId)}'`)
    }
    const updated = await backend.renameSession(sessionId, title)
    if (backend.engineId === 'dsh' && updated.engine === undefined) {
      return updated
    }
    return { ...updated, engine: updated.engine ?? backend.engineId }
  }

  async forkSession(params: SessionForkParams): Promise<SessionRef> {
    const backend = await this.resolveBackendForSession(params.sessionId)
    if (!backend.forkSession) {
      throw new RemoteProtocolError('INVALID_REQUEST', `session.fork is not supported by '${String(backend.engineId)}'`)
    }
    const forked = await backend.forkSession(params)
    const result: SessionRef =
      backend.engineId === 'dsh' && forked.engine === undefined
        ? forked
        : { ...forked, engine: forked.engine ?? backend.engineId }
    this.sessionOwner.set(result.id, backend.engineId)
    return result
  }

  async followup(sessionId: string, prompt: string, options?: FollowupOptions): Promise<unknown> {
    const backend = await this.resolveBackendForSession(sessionId)
    return backend.followup(sessionId, prompt, options)
  }

  async abortTurn(sessionId: string, options?: { readonly keepInbox?: boolean | undefined }): Promise<unknown> {
    const backend = await this.resolveBackendForSession(sessionId)
    if (!backend.abortTurn) {
      throw new RemoteProtocolError('INVALID_REQUEST', `turn.abort is not supported by '${String(backend.engineId)}'`)
    }
    return backend.abortTurn(sessionId, options)
  }

  async respondApproval(callId: string, decision: 'approved' | 'rejected'): Promise<unknown> {
    const ownerEngine =
      this.approvalOwner.get(callId)
      ?? APPROVAL_PREFIX_TO_ENGINE.find(([prefix]) => callId.startsWith(prefix))?.[1]
      ?? (this.backendById.has('dsh') ? 'dsh' : undefined)

    if (ownerEngine) {
      const backend = this.backendById.get(ownerEngine)
      if (backend) {
        this.approvalOwner.delete(callId)
        return backend.respondApproval(callId, decision)
      }
    }

    for (const backend of this.orderedBackends) {
      try {
        return await backend.respondApproval(callId, decision)
      } catch (err) {
        if (err instanceof RemoteProtocolError && err.code !== 'INVALID_REQUEST') throw err
      }
    }
    throw new RemoteProtocolError('INVALID_REQUEST', `unknown pending approval '${callId}'`)
  }

  async respondQuestion(questionId: string, answer: unknown): Promise<unknown> {
    const ownerEngine =
      this.questionOwner.get(questionId)
      ?? QUESTION_PREFIX_TO_ENGINE.find(([prefix]) => questionId.startsWith(prefix))?.[1]
      ?? (this.backendById.has('dsh') ? 'dsh' : undefined)

    if (ownerEngine) {
      const backend = this.backendById.get(ownerEngine)
      if (backend) {
        this.questionOwner.delete(questionId)
        return backend.respondQuestion(questionId, answer)
      }
    }

    for (const backend of this.orderedBackends) {
      try {
        return await backend.respondQuestion(questionId, answer)
      } catch (err) {
        if (err instanceof RemoteProtocolError && err.code !== 'INVALID_REQUEST') throw err
      }
    }
    throw new RemoteProtocolError('INVALID_REQUEST', `unknown pending question '${questionId}'`)
  }

  async listModels(sessionId?: string): Promise<ModelCatalogResult> {
    if (sessionId !== undefined) {
      const backend = await this.resolveBackendForSession(sessionId)
      return backend.listModels ? backend.listModels(sessionId) : { models: [] }
    }
    const settled = await Promise.allSettled(
      this.orderedBackends.map((b) =>
        b.listModels ? b.listModels() : Promise.resolve<ModelCatalogResult>({ models: [] }),
      ),
    )
    const models: ModelOptionRef[] = []
    let current: ModelCatalogResult['current']
    for (const res of settled) {
      if (res.status !== 'fulfilled') continue
      if (!current && res.value.current) current = res.value.current
      models.push(...res.value.models)
    }
    return { ...(current !== undefined ? { current } : {}), models }
  }

  async selectModel(sessionId: string, selection: ModelSelectionParams): Promise<unknown> {
    const backend = await this.resolveBackendForSession(sessionId)
    if (!backend.selectModel) {
      throw new RemoteProtocolError('INVALID_REQUEST', `model.select is not supported by '${String(backend.engineId)}'`)
    }
    return backend.selectModel(sessionId, selection)
  }

  async getSessionLiveState(sessionId: string): Promise<SessionLiveStateSnapshot | undefined> {
    const backend = await this.resolveBackendForSession(sessionId)
    return backend.getSessionLiveState?.(sessionId)
  }

  async getSessionHistory(params: SessionHistoryParams): Promise<SessionHistoryResult> {
    const backend = await this.resolveBackendForSession(params.sessionId)
    if (!backend.getSessionHistory) {
      throw new RemoteProtocolError('INVALID_REQUEST', `session.history is not supported by '${String(backend.engineId)}'`)
    }
    return backend.getSessionHistory(params)
  }

  async searchSessions(params: SessionSearchParams): Promise<SessionSearchResult> {
    if (params.sessionId !== undefined) {
      const backend = await this.resolveBackendForSession(params.sessionId)
      return backend.searchSessions
        ? backend.searchSessions(params)
        : { query: params.query, hits: [], hasMore: false }
    }
    const settled = await Promise.allSettled(
      this.orderedBackends.map((b) =>
        b.searchSessions
          ? b.searchSessions(params)
          : Promise.resolve<SessionSearchResult>({ query: params.query, hits: [], hasMore: false }),
      ),
    )
    const hits = []
    let hasMore = false
    for (const res of settled) {
      if (res.status !== 'fulfilled') continue
      hits.push(...res.value.hits)
      if (res.value.hasMore) hasMore = true
    }
    return {
      query: params.query,
      hits: hits.slice(0, params.limit ?? 20),
      hasMore,
    }
  }

  async listCommands(sessionId?: string): Promise<readonly RemoteCommandDescriptor[]> {
    if (sessionId !== undefined) {
      const backend = await this.resolveBackendForSession(sessionId)
      return backend.listCommands ? backend.listCommands(sessionId) : []
    }
    const settled = await Promise.allSettled(
      this.orderedBackends.map((b) => (b.listCommands ? b.listCommands() : Promise.resolve([]))),
    )
    return settled.flatMap((res) => (res.status === 'fulfilled' ? res.value : []))
  }

  async executeCommand(sessionId: string, command: string): Promise<{ readonly ok: boolean; readonly commandId?: string | undefined; readonly output?: string | undefined; readonly error?: string | undefined }> {
    const backend = await this.resolveBackendForSession(sessionId)
    if (!backend.executeCommand) {
      throw new RemoteProtocolError('INVALID_REQUEST', `command.execute is not supported by '${String(backend.engineId)}'`)
    }
    return backend.executeCommand(sessionId, command)
  }

  async listSkills(sessionId?: string): Promise<readonly RemoteSkillSummary[]> {
    if (sessionId !== undefined) {
      const backend = await this.resolveBackendForSession(sessionId)
      return backend.listSkills ? backend.listSkills(sessionId) : []
    }
    const settled = await Promise.allSettled(
      this.orderedBackends.map((b) => (b.listSkills ? b.listSkills() : Promise.resolve([]))),
    )
    return settled.flatMap((res) => (res.status === 'fulfilled' ? res.value : []))
  }

  async getWorkspaceGitStatus(params: WorkspaceGitStatusParams): Promise<WorkspaceGitStatusResult> {
    const backend = await this.resolveBackendForSession(params.sessionId)
    if (backend.getWorkspaceGitStatus) {
      return backend.getWorkspaceGitStatus(params)
    }
    const cwd = (await backend.getSessionCwd?.(params.sessionId)) ?? this.defaultCwd
    return inspectWorkspaceGitStatus(params.sessionId, cwd)
  }

  async getWorkspaceGitDiff(params: WorkspaceGitDiffParams): Promise<WorkspaceGitDiffResult> {
    const backend = await this.resolveBackendForSession(params.sessionId)
    if (backend.getWorkspaceGitDiff) {
      return backend.getWorkspaceGitDiff(params)
    }
    const cwd = (await backend.getSessionCwd?.(params.sessionId)) ?? this.defaultCwd
    return inspectWorkspaceGitDiff(params, cwd)
  }

  async openWorkspaceUpload(deviceId: string, params: WorkspaceUploadOpenParams): Promise<WorkspaceUploadOpenResult> {
    const backend = await this.resolveBackendForSession(params.sessionId)
    if (backend.openWorkspaceUpload) {
      const opened = await backend.openWorkspaceUpload(deviceId, params)
      this.uploadOwner.set(opened.uploadId, 'dsh')
      return opened
    }
    const workspaceRoot = (await backend.getSessionCwd?.(params.sessionId)) ?? this.defaultCwd
    const opened = this.uploads.open({
      deviceId,
      sessionId: params.sessionId,
      workspaceRoot,
      filename: params.filename,
      sizeBytes: params.sizeBytes,
      ...(params.chunkBytes !== undefined ? { chunkBytes: params.chunkBytes } : {}),
      ...(params.sha256 !== undefined ? { sha256: params.sha256 } : {}),
      ...(params.conflictPolicy !== undefined ? { conflictPolicy: params.conflictPolicy } : {}),
    })
    this.uploadOwner.set(opened.uploadId, 'router')
    return opened
  }

  async appendWorkspaceUploadChunk(deviceId: string, params: WorkspaceUploadChunkParams): Promise<WorkspaceUploadChunkResult> {
    const owner = this.uploadOwner.get(params.uploadId)
    const dsh = this.backendById.get('dsh')
    if (owner === 'dsh' && dsh?.appendWorkspaceUploadChunk) {
      return dsh.appendWorkspaceUploadChunk(deviceId, params)
    }
    if (owner !== 'router' && dsh?.appendWorkspaceUploadChunk && !owner) {
      try {
        return await dsh.appendWorkspaceUploadChunk(deviceId, params)
      } catch (err) {
        if (!(err instanceof RemoteProtocolError) || err.code !== 'INVALID_REQUEST') throw err
      }
    }
    return this.uploads.appendChunk({
      deviceId,
      uploadId: params.uploadId,
      offset: params.offset,
      dataBase64: params.dataBase64,
    })
  }

  async commitWorkspaceUpload(deviceId: string, params: WorkspaceUploadCommitParams): Promise<WorkspaceUploadCommitResult> {
    const owner = this.uploadOwner.get(params.uploadId)
    const dsh = this.backendById.get('dsh')
    if (owner === 'dsh' && dsh?.commitWorkspaceUpload) {
      const committed = await dsh.commitWorkspaceUpload(deviceId, params)
      this.uploadOwner.delete(params.uploadId)
      return committed
    }
    if (owner !== 'router' && dsh?.commitWorkspaceUpload && !owner) {
      try {
        const committed = await dsh.commitWorkspaceUpload(deviceId, params)
        this.uploadOwner.delete(params.uploadId)
        return committed
      } catch (err) {
        if (!(err instanceof RemoteProtocolError) || err.code !== 'INVALID_REQUEST') throw err
      }
    }
    const committed = this.uploads.commit({
      deviceId,
      uploadId: params.uploadId,
      ...(params.sha256 !== undefined ? { sha256: params.sha256 } : {}),
    })
    this.uploadOwner.delete(params.uploadId)
    return committed
  }

  async abortWorkspaceUpload(deviceId: string, params: WorkspaceUploadAbortParams): Promise<WorkspaceUploadAbortResult> {
    const owner = this.uploadOwner.get(params.uploadId)
    const dsh = this.backendById.get('dsh')
    if (owner === 'dsh' && dsh?.abortWorkspaceUpload) {
      this.uploadOwner.delete(params.uploadId)
      return dsh.abortWorkspaceUpload(deviceId, params)
    }
    if (owner !== 'router' && dsh?.abortWorkspaceUpload && !owner) {
      try {
        const res = await dsh.abortWorkspaceUpload(deviceId, params)
        if (res.aborted) {
          this.uploadOwner.delete(params.uploadId)
          return res
        }
      } catch {}
    }
    this.uploadOwner.delete(params.uploadId)
    return this.uploads.abort({
      deviceId,
      uploadId: params.uploadId,
    })
  }

  revokeDeviceUploads(deviceId: string): number {
    return this.uploads.revokeDevice(deviceId)
  }
}
