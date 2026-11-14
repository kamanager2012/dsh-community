import { type spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { RemoteProtocolError } from '../errors.js'
import type {
  AgentEngineId,
  CreateSessionParams,
  EngineDescriptor,
  FollowupOptions,
  ModelCatalogResult,
  ModelOptionRef,
  ModelSelectionParams,
  OfficialSessionEvent,
  PendingApprovalSnapshot,
  SessionForkParams,
  SessionLiveStateSnapshot,
  SessionRef,
  WorkspaceGitDiffParams,
  WorkspaceGitDiffResult,
  WorkspaceGitStatusParams,
  WorkspaceGitStatusResult,
} from '../protocol.js'
import { inspectWorkspaceGitDiff, inspectWorkspaceGitStatus } from './git-review.js'
import { NdjsonRpcProcess } from './ndjson-rpc.js'
import {
  extractTextSnippet,
  findBinaryOnPath,
  formatNamespacedSessionId,
  isRecord,
  MonotonicSessionEventEmitter,
  parseNamespacedSessionId,
  probeBinaryVersion,
  type ManagedAgentBackend,
} from './types.js'

export interface AcpBackendOptions {
  readonly engineId?: AgentEngineId | undefined
  readonly displayName?: string | undefined
  readonly command?: string | undefined
  readonly args?: readonly string[] | undefined
  readonly defaultCwd?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly spawnFn?: typeof spawn | undefined
  readonly requestTimeoutMs?: number | undefined
}

interface AcpSessionMeta {
  readonly nativeId: string
  readonly sessionId: string
  title?: string | undefined
  cwd?: string | undefined
  updatedAtMs?: number | undefined
  status: 'running' | 'idle'
  model?: ModelSelectionParams | undefined
}

interface PendingAcpPermission {
  readonly callId: string
  readonly sessionId: string
  readonly toolName: string
  readonly summary?: string | undefined
  readonly allowOptionId?: string | undefined
  readonly rejectOptionId?: string | undefined
  readonly resolve: (value: unknown) => void
  readonly reject: (err: Error) => void
}

/**
 * Multi-agent backend driving any Agent Client Protocol (ACP) CLI over stdio,
 * defaulting to OpenCode (`opencode acp`).
 */
export class AcpAgentBackend implements ManagedAgentBackend {
  readonly engineId: AgentEngineId
  readonly displayName: string

  private readonly command: string
  private readonly args: readonly string[]
  private readonly defaultCwd: string
  private readonly env: NodeJS.ProcessEnv
  private readonly emitter = new MonotonicSessionEventEmitter()

  private rpc: NdjsonRpcProcess | undefined
  private startPromise: Promise<NdjsonRpcProcess> | undefined
  private readonly loadedSessions = new Set<string>()
  private readonly sessions = new Map<string, AcpSessionMeta>()
  private readonly availableModels = new Map<string, ModelOptionRef>()
  private readonly pendingPermissions = new Map<string, PendingAcpPermission>()
  private agentCapabilities: Record<string, unknown> | undefined
  private agentVersion: string | undefined

  constructor(private readonly options: AcpBackendOptions = {}) {
    this.engineId = options.engineId ?? 'opencode'
    this.displayName = options.displayName ?? 'OpenCode (ACP)'
    this.command = options.command ?? 'opencode'
    this.args = options.args ?? ['acp']
    this.defaultCwd = options.defaultCwd ?? process.cwd()
    this.env = options.env ?? process.env
  }

  onEvent(listener: (sessionId: string, events: readonly OfficialSessionEvent[]) => void): () => void {
    return this.emitter.subscribe(listener)
  }

  async probe(): Promise<EngineDescriptor> {
    const binaryPath = findBinaryOnPath(this.command, this.env)
    const version =
      this.agentVersion
      ?? (binaryPath ? await probeBinaryVersion(binaryPath, ['--version'], this.env) : undefined)
    return {
      id: this.engineId,
      displayName: this.displayName,
      available: Boolean(binaryPath),
      running: Boolean(this.rpc?.isAlive()),
      ...(binaryPath !== undefined ? { binaryPath } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(binaryPath === undefined ? { error: `'${this.command}' binary not found on PATH` } : {}),
      capabilities: {
        createSession: Boolean(binaryPath),
        listSessions: Boolean(binaryPath),
        history: false,
        abortTurn: Boolean(binaryPath),
        approvals: true,
        questions: false,
        streaming: true,
        models: true,
        gitReview: true,
      },
    }
  }

  async start(): Promise<void> {
    await this.ensureRpc()
  }

  async stop(): Promise<void> {
    this.startPromise = undefined
    const active = this.rpc
    this.rpc = undefined
    this.loadedSessions.clear()
    for (const [id, entry] of this.pendingPermissions.entries()) {
      this.pendingPermissions.delete(id)
      entry.resolve({ outcome: { outcome: 'cancelled' } })
    }
    if (active) {
      await active.stop()
    }
  }

  private async ensureRpc(): Promise<NdjsonRpcProcess> {
    if (this.rpc?.isAlive()) return this.rpc
    if (this.startPromise) return this.startPromise

    this.startPromise = (async () => {
      const binaryPath = findBinaryOnPath(this.command, this.env)
      if (!binaryPath && !this.options.spawnFn) {
        throw new RemoteProtocolError(
          'INVALID_REQUEST',
          `ACP CLI '${this.command}' is not installed on PATH`,
        )
      }
      const proc = new NdjsonRpcProcess({
        command: binaryPath ?? this.command,
        args: this.args,
        cwd: this.defaultCwd,
        env: this.env,
        includeJsonRpcHeader: true,
        defaultRequestTimeoutMs: this.options.requestTimeoutMs ?? 30_000,
        ...(this.options.spawnFn !== undefined ? { spawnFn: this.options.spawnFn } : {}),
        onNotification: (method, params) => this.handleNotification(method, params),
        onServerRequest: (method, params) => this.handleServerRequest(method, params),
        onExit: () => {
          if (this.rpc === proc) {
            this.rpc = undefined
            this.loadedSessions.clear()
          }
        },
      })

      try {
        const initRes = await proc.request<Record<string, unknown>>('initialize', {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'dsh-community', version: '0.3.0' },
        }, 10_000)
        if (isRecord(initRes?.agentCapabilities)) {
          this.agentCapabilities = initRes.agentCapabilities
        }
        if (isRecord(initRes?.agentInfo) && typeof initRes.agentInfo.version === 'string') {
          this.agentVersion = initRes.agentInfo.version
        }
        this.rpc = proc
        return proc
      } catch (err) {
        await proc.stop().catch(() => {})
        throw err
      } finally {
        this.startPromise = undefined
      }
    })()

    return this.startPromise
  }

  private resolveNativeId(sessionId: string): string {
    const parsed = parseNamespacedSessionId(sessionId)
    if (parsed.engine !== undefined && parsed.engine !== this.engineId) {
      throw new RemoteProtocolError('INVALID_REQUEST', `session '${sessionId}' does not belong to '${this.engineId}'`)
    }
    return parsed.nativeId
  }

  private formatId(nativeId: string): string {
    return formatNamespacedSessionId(this.engineId, nativeId)
  }

  private cacheRawSession(raw: Record<string, unknown>): AcpSessionMeta | undefined {
    const nativeId = typeof raw.sessionId === 'string'
      ? raw.sessionId
      : typeof raw.id === 'string'
        ? raw.id
        : undefined
    if (!nativeId) return undefined
    const sessionId = this.formatId(nativeId)
    const prev = this.sessions.get(nativeId)
    const updatedAt = typeof raw.updatedAt === 'string' ? Date.parse(raw.updatedAt) : undefined
    const meta: AcpSessionMeta = {
      nativeId,
      sessionId,
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : prev?.title,
      cwd: typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : prev?.cwd,
      updatedAtMs:
        updatedAt !== undefined && Number.isFinite(updatedAt) ? updatedAt : prev?.updatedAtMs,
      status: prev?.status ?? 'idle',
      model: prev?.model,
    }
    this.sessions.set(nativeId, meta)
    return meta
  }

  private captureModelsMetadata(response: unknown, meta?: AcpSessionMeta): void {
    if (!isRecord(response) || !isRecord(response.models)) return
    const currentId = typeof response.models.currentModelId === 'string'
      ? response.models.currentModelId
      : undefined
    if (meta && currentId) {
      meta.model = { provider: String(this.engineId), model: currentId }
    }
    const list = Array.isArray(response.models.availableModels) ? response.models.availableModels : []
    for (const item of list) {
      if (!isRecord(item) || typeof item.modelId !== 'string') continue
      this.availableModels.set(item.modelId, {
        provider: String(this.engineId),
        providerName: this.displayName,
        model: item.modelId,
        name: typeof item.name === 'string' ? item.name : item.modelId,
        ...(typeof item.description === 'string' ? { description: item.description } : {}),
      })
    }
  }

  private toSessionRef(meta: AcpSessionMeta): SessionRef {
    let pendingApprovals = 0
    for (const a of this.pendingPermissions.values()) {
      if (a.sessionId === meta.sessionId) pendingApprovals += 1
    }
    return {
      id: meta.sessionId,
      engine: this.engineId,
      nativeSessionId: meta.nativeId,
      ...(meta.title !== undefined ? { title: meta.title } : {}),
      ...(meta.updatedAtMs !== undefined ? { updatedAtMs: meta.updatedAtMs } : {}),
      ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
      status: meta.status,
      ...(meta.model !== undefined ? { model: meta.model } : {}),
      ...(pendingApprovals > 0 ? { pendingApprovals } : {}),
    }
  }

  async listSessions(): Promise<readonly SessionRef[]> {
    const rpc = await this.ensureRpc()
    const res = await rpc.request<{ sessions?: unknown[] }>('session/list', {})
    const rows = Array.isArray(res?.sessions) ? res.sessions : []
    const out: SessionRef[] = []
    for (const row of rows) {
      if (!isRecord(row)) continue
      const meta = this.cacheRawSession(row)
      if (meta) out.push(this.toSessionRef(meta))
    }
    out.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0))
    return out
  }

  async assertSession(sessionId: string): Promise<void> {
    const nativeId = this.resolveNativeId(sessionId)
    if (this.sessions.has(nativeId)) return
    await this.listSessions()
    if (!this.sessions.has(nativeId)) {
      throw new RemoteProtocolError('INVALID_REQUEST', `ACP session '${nativeId}' not found`)
    }
  }

  async createSession(options?: CreateSessionParams): Promise<SessionRef> {
    const rpc = await this.ensureRpc()
    const cwd = options?.cwd ?? this.defaultCwd
    const res = await rpc.request<Record<string, unknown>>('session/new', {
      cwd,
      mcpServers: [],
    })
    const nativeId = typeof res?.sessionId === 'string' ? res.sessionId : undefined
    if (!nativeId) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'ACP session/new did not return a sessionId')
    }
    const meta: AcpSessionMeta = {
      nativeId,
      sessionId: this.formatId(nativeId),
      title: options?.title,
      cwd,
      updatedAtMs: Date.now(),
      status: 'idle',
    }
    this.sessions.set(nativeId, meta)
    this.loadedSessions.add(nativeId)
    this.captureModelsMetadata(res, meta)
    return this.toSessionRef(meta)
  }

  async forkSession(params: SessionForkParams): Promise<SessionRef> {
    const nativeId = this.resolveNativeId(params.sessionId)
    await this.assertSession(params.sessionId)
    const rpc = await this.ensureRpc()
    const meta = this.sessions.get(nativeId)
    const res = await rpc.request<Record<string, unknown>>('session/fork', {
      sessionId: nativeId,
      cwd: meta?.cwd ?? this.defaultCwd,
    })
    const newId = typeof res?.sessionId === 'string' ? res.sessionId : undefined
    if (!newId) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'ACP session/fork did not return a sessionId')
    }
    const forked: AcpSessionMeta = {
      nativeId: newId,
      sessionId: this.formatId(newId),
      title: params.title ?? meta?.title,
      cwd: meta?.cwd ?? this.defaultCwd,
      updatedAtMs: Date.now(),
      status: 'idle',
    }
    this.sessions.set(newId, forked)
    this.loadedSessions.add(newId)
    return this.toSessionRef(forked)
  }

  private async ensureLoaded(rpc: NdjsonRpcProcess, nativeId: string): Promise<void> {
    if (this.loadedSessions.has(nativeId)) return
    const meta = this.sessions.get(nativeId)
    const res = await rpc.request<Record<string, unknown>>('session/load', {
      sessionId: nativeId,
      cwd: meta?.cwd ?? this.defaultCwd,
      mcpServers: [],
    })
    this.loadedSessions.add(nativeId)
    this.captureModelsMetadata(res, meta)
  }

  async followup(sessionId: string, prompt: string, options?: FollowupOptions): Promise<unknown> {
    const nativeId = this.resolveNativeId(sessionId)
    await this.assertSession(sessionId)
    const rpc = await this.ensureRpc()
    await this.ensureLoaded(rpc, nativeId)
    const meta = this.sessions.get(nativeId)!
    meta.status = 'running'
    meta.updatedAtMs = Date.now()

    const promptBlocks: Array<Record<string, unknown>> = []
    if (prompt.length > 0) {
      promptBlocks.push({ type: 'text', text: prompt })
    }
    for (const att of options?.attachments ?? []) {
      promptBlocks.push({
        type: 'image',
        mimeType: att.mediaType,
        data: att.dataBase64,
      })
    }

    this.emitter.emit(meta.sessionId, 'turn/start', {})
    this.emitter.emit(meta.sessionId, 'user/message', { message: { role: 'user', content: prompt } })

    // ACP session/prompt stays open for the entire turn; dispatch asynchronously so RPC ack returns immediately.
    void rpc
      .request<Record<string, unknown>>(
        'session/prompt',
        { sessionId: nativeId, prompt: promptBlocks },
        10 * 60_000,
      )
      .then((res) => {
        meta.status = 'idle'
        meta.updatedAtMs = Date.now()
        this.emitter.emit(meta.sessionId, 'turn/end', {
          stopReason: res?.stopReason ?? 'end_turn',
        })
      })
      .catch((err) => {
        meta.status = 'idle'
        meta.updatedAtMs = Date.now()
        this.emitter.emit(meta.sessionId, 'turn/end', {
          error: err instanceof Error ? err.message : String(err),
        })
      })

    return { accepted: true, sessionId: meta.sessionId }
  }

  async abortTurn(sessionId: string): Promise<unknown> {
    const nativeId = this.resolveNativeId(sessionId)
    await this.assertSession(sessionId)
    const rpc = await this.ensureRpc()
    rpc.notify('session/cancel', { sessionId: nativeId })
    const meta = this.sessions.get(nativeId)
    if (meta) meta.status = 'idle'
    return { sessionId: this.formatId(nativeId), aborted: true }
  }

  async respondApproval(callId: string, decision: 'approved' | 'rejected'): Promise<unknown> {
    const pending = this.pendingPermissions.get(callId)
    if (!pending) {
      throw new RemoteProtocolError('INVALID_REQUEST', `unknown ACP pending permission '${callId}'`)
    }
    this.pendingPermissions.delete(callId)
    const optionId = decision === 'approved' ? pending.allowOptionId : pending.rejectOptionId
    if (optionId) {
      pending.resolve({ outcome: { outcome: 'selected', optionId } })
    } else {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
    this.emitter.emit(pending.sessionId, 'approval.resolved', { callId, decision })
    return { ok: true, callId, decision }
  }

  async respondQuestion(): Promise<unknown> {
    throw new RemoteProtocolError('INVALID_REQUEST', `${String(this.engineId)} ACP backend does not support interactive questions`)
  }

  async listModels(sessionId?: string): Promise<ModelCatalogResult> {
    if (sessionId) {
      const nativeId = this.resolveNativeId(sessionId)
      const rpc = await this.ensureRpc()
      await this.assertSession(sessionId)
      await this.ensureLoaded(rpc, nativeId)
      return {
        ...(this.sessions.get(nativeId)?.model !== undefined ? { current: this.sessions.get(nativeId)!.model } : {}),
        models: [...this.availableModels.values()],
      }
    }
    return { models: [...this.availableModels.values()] }
  }

  async selectModel(sessionId: string, selection: ModelSelectionParams): Promise<unknown> {
    const nativeId = this.resolveNativeId(sessionId)
    await this.assertSession(sessionId)
    const rpc = await this.ensureRpc()
    await this.ensureLoaded(rpc, nativeId)
    await rpc.request('session/set_model', { sessionId: nativeId, modelId: selection.model }).catch(() => {})
    const meta = this.sessions.get(nativeId)
    if (meta) meta.model = selection
    this.emitter.emit(this.formatId(nativeId), 'session.model', selection)
    return { ok: true, sessionId: this.formatId(nativeId), selection }
  }

  async getSessionLiveState(sessionId: string): Promise<SessionLiveStateSnapshot | undefined> {
    const nativeId = this.resolveNativeId(sessionId)
    const meta = this.sessions.get(nativeId)
    if (!meta) return undefined
    const pendingApprovals: PendingApprovalSnapshot[] = []
    for (const a of this.pendingPermissions.values()) {
      if (a.sessionId === meta.sessionId) {
        pendingApprovals.push({
          callId: a.callId,
          toolName: a.toolName,
          ...(a.summary !== undefined ? { summary: a.summary } : {}),
          sessionId: meta.sessionId,
        })
      }
    }
    return {
      status: meta.status,
      ...(meta.model !== undefined ? { model: meta.model } : {}),
      ...(meta.title !== undefined ? { title: meta.title } : {}),
      pendingApprovals,
      pendingQuestions: [],
      todos: [],
      oldestSeq: 1,
      latestSeq: this.emitter.currentSeq(meta.sessionId) || null,
    }
  }

  async getSessionCwd(sessionId: string): Promise<string | undefined> {
    const nativeId = this.resolveNativeId(sessionId)
    await this.assertSession(sessionId)
    return this.sessions.get(nativeId)?.cwd ?? this.defaultCwd
  }

  async getWorkspaceGitStatus(params: WorkspaceGitStatusParams): Promise<WorkspaceGitStatusResult> {
    const cwd = (await this.getSessionCwd(params.sessionId)) ?? this.defaultCwd
    return inspectWorkspaceGitStatus(params.sessionId, cwd)
  }

  async getWorkspaceGitDiff(params: WorkspaceGitDiffParams): Promise<WorkspaceGitDiffResult> {
    const cwd = (await this.getSessionCwd(params.sessionId)) ?? this.defaultCwd
    return inspectWorkspaceGitDiff(params, cwd)
  }

  private handleNotification(method: string, rawParams: unknown): void {
    if (method !== 'session/update' || !isRecord(rawParams)) return
    const nativeId = typeof rawParams.sessionId === 'string' ? rawParams.sessionId : undefined
    if (!nativeId) return
    const publicId = this.formatId(nativeId)
    const update = isRecord(rawParams.update) ? rawParams.update : undefined
    if (!update) return
    const updateType = update.sessionUpdate

    if (updateType === 'agent_message_chunk' && isRecord(update.content) && typeof update.content.text === 'string') {
      const meta = this.sessions.get(nativeId)
      if (meta) meta.title = meta.title ?? extractTextSnippet(update.content.text, 80)
      this.emitter.emit(publicId, 'assistant/chunk', {
        text: update.content.text,
        chunk: { type: 'text-delta', text: update.content.text },
      })
    } else if (updateType === 'agent_thought_chunk' && isRecord(update.content) && typeof update.content.text === 'string') {
      this.emitter.emit(publicId, 'assistant/chunk', {
        text: update.content.text,
        chunk: { type: 'reasoning-delta', text: update.content.text },
      })
    } else if (updateType === 'tool_call') {
      this.emitter.emit(publicId, 'tool/call', {
        callId: update.toolCallId,
        toolName: typeof update.title === 'string' ? update.title : String(update.kind ?? 'tool'),
        args: update.rawInput,
      })
    } else if (updateType === 'tool_call_update' && (update.status === 'completed' || update.status === 'failed')) {
      this.emitter.emit(publicId, 'tool/result', {
        callId: update.toolCallId,
        result: update.rawOutput ?? update.content,
        isError: update.status === 'failed',
      })
    } else if (updateType === 'session_info_update' && typeof update.title === 'string') {
      const meta = this.sessions.get(nativeId)
      if (meta) meta.title = update.title
      this.emitter.emit(publicId, 'session/title', { title: update.title })
    }
  }

  private async handleServerRequest(method: string, rawParams: unknown): Promise<unknown> {
    const params = isRecord(rawParams) ? rawParams : {}

    if (method === 'session/request_permission') {
      const nativeId = typeof params.sessionId === 'string' ? params.sessionId : 'unknown'
      const publicId = this.formatId(nativeId)
      const toolCall = isRecord(params.toolCall) ? params.toolCall : {}
      const callId = `${String(this.engineId)}-apr-${randomUUID()}`
      const toolName = typeof toolCall.title === 'string' ? toolCall.title : String(toolCall.kind ?? 'tool')

      const opts = Array.isArray(params.options)
        ? params.options.filter((o): o is Record<string, unknown> => isRecord(o))
        : []
      const allowOption = opts.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always')
      const rejectOption = opts.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always')

      return await new Promise((resolve, reject) => {
        this.pendingPermissions.set(callId, {
          callId,
          sessionId: publicId,
          toolName,
          summary: typeof toolCall.title === 'string' ? toolCall.title : undefined,
          allowOptionId: typeof allowOption?.optionId === 'string' ? allowOption.optionId : undefined,
          rejectOptionId: typeof rejectOption?.optionId === 'string' ? rejectOption.optionId : undefined,
          resolve,
          reject,
        })
        this.emitter.emit(publicId, 'approval.request', {
          callId,
          toolName,
          args: toolCall.rawInput ?? toolCall.locations,
        })
      })
    }

    if (method === 'fs/read_text_file') {
      const nativeId = typeof params.sessionId === 'string' ? params.sessionId : undefined
      const reqPath = typeof params.path === 'string' ? params.path : ''
      const sessionCwd = nativeId ? (this.sessions.get(nativeId)?.cwd ?? this.defaultCwd) : this.defaultCwd
      const rootReal = realpathSync(resolve(sessionCwd))
      const resolvedTarget = isAbsolute(reqPath) ? resolve(reqPath) : resolve(rootReal, reqPath)
      if (!existsSync(resolvedTarget)) {
        throw new Error('file not found')
      }
      const targetReal = realpathSync(resolvedTarget)
      const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`
      if (targetReal !== rootReal && !targetReal.startsWith(prefix)) {
        throw new Error('read_text_file denied outside session workspace root')
      }
      const content = readFileSync(targetReal, 'utf8')
      return { content }
    }

    throw new Error(`Unsupported ACP callback method: ${method}`)
  }
}
