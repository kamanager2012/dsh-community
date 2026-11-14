import { type spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
  PendingQuestionSnapshot,
  ReasoningEffortOption,
  SessionForkParams,
  SessionHistoryParams,
  SessionHistoryResult,
  SessionLiveStateSnapshot,
  SessionRef,
  SessionSearchParams,
  SessionSearchResult,
  SessionUsageSnapshot,
  WorkspaceGitDiffParams,
  WorkspaceGitDiffResult,
  WorkspaceGitStatusParams,
  WorkspaceGitStatusResult,
} from '../protocol.js'
import {
  paginateNormalizedTranscriptEvents,
  searchSessionCollections,
  type NormalizedTranscriptEvent,
} from '../session-transcript.js'
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

export interface CodexBackendOptions {
  readonly command?: string | undefined
  readonly args?: readonly string[] | undefined
  readonly defaultCwd?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly spawnFn?: typeof spawn | undefined
  readonly requestTimeoutMs?: number | undefined
}

interface CachedThreadMeta {
  readonly nativeId: string
  readonly sessionId: string
  title?: string | undefined
  cwd?: string | undefined
  preview?: string | undefined
  updatedAtMs?: number | undefined
  status: 'running' | 'idle'
  model?: ModelSelectionParams | undefined
  usage?: SessionUsageSnapshot | undefined
}

interface PendingCodexApproval {
  readonly callId: string
  readonly sessionId: string
  readonly toolName: string
  readonly reason?: string | undefined
  readonly summary?: string | undefined
  readonly resolve: (value: unknown) => void
  readonly reject: (err: Error) => void
}

interface PendingCodexQuestion {
  readonly questionId: string
  readonly sessionId: string
  readonly prompt: string
  readonly rawQuestions: readonly Record<string, unknown>[]
  readonly resolve: (value: unknown) => void
  readonly reject: (err: Error) => void
}

function buildCodexUserInput(
  prompt: string,
  options?: FollowupOptions,
): Array<Record<string, unknown>> {
  const inputs: Array<Record<string, unknown>> = []
  if (prompt.length > 0) {
    inputs.push({ type: 'text', text: prompt, text_elements: [] })
  }
  for (const att of options?.attachments ?? []) {
    inputs.push({
      type: 'image',
      url: `data:${att.mediaType};base64,${att.dataBase64}`,
    })
  }
  return inputs
}

interface CodexCanonicalEventDescriptor {
  readonly key: string
  readonly type: string
  readonly data?: unknown
}

function buildCodexItemDescriptors(
  rawItem: Record<string, unknown>,
  turnKey: string,
  itemIndex: number,
): CodexCanonicalEventDescriptor[] {
  const itemType = rawItem.type
  const itemId = typeof rawItem.id === 'string' && rawItem.id.length > 0 ? rawItem.id : undefined
  const itemKey = itemId !== undefined ? `id:${itemId}` : `pos:${itemIndex}`
  const events: CodexCanonicalEventDescriptor[] = []
  const push = (type: string, data?: unknown): void => {
    const key = `item:${turnKey}:${itemKey}:${type}`
    events.push(data !== undefined ? { key, type, data } : { key, type })
  }

  if (itemType === 'userMessage') {
    const content = Array.isArray(rawItem.content) ? rawItem.content : []
    const texts = content
      .map((c) => (isRecord(c) && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n')
    push('user/message', { message: { role: 'user', content: texts } })
  } else if (itemType === 'agentMessage') {
    const text = typeof rawItem.text === 'string' ? rawItem.text : ''
    push('assistant/message', { message: { role: 'assistant', content: text } })
  } else if (itemType === 'reasoning') {
    const summary = Array.isArray(rawItem.summary)
      ? rawItem.summary.filter((s): s is string => typeof s === 'string').join('\n')
      : ''
    if (summary) {
      push('thinking/message', { text: summary })
    }
  } else if (itemType === 'commandExecution') {
    const command = typeof rawItem.command === 'string' ? rawItem.command : ''
    push('tool/call', {
      callId: itemId,
      toolName: 'bash',
      args: { command, cwd: rawItem.cwd },
    })
    if (rawItem.aggregatedOutput !== undefined || rawItem.exitCode !== undefined) {
      push('tool/result', {
        callId: itemId,
        toolName: 'bash',
        result: rawItem.aggregatedOutput ?? '',
        exitCode: rawItem.exitCode ?? null,
      })
    }
  } else if (itemType === 'fileChange') {
    push('tool/call', {
      callId: itemId,
      toolName: 'file_change',
      args: { changes: rawItem.changes },
    })
    push('tool/result', {
      callId: itemId,
      toolName: 'file_change',
      result: { status: rawItem.status },
    })
  } else if (itemType === 'mcpToolCall') {
    const name = `${String(rawItem.server ?? 'mcp')}:${String(rawItem.tool ?? 'call')}`
    push('tool/call', { callId: itemId, toolName: name, args: rawItem.arguments })
    if (rawItem.result !== null || rawItem.error !== null) {
      push('tool/result', {
        callId: itemId,
        toolName: name,
        result: rawItem.result,
        error: rawItem.error,
      })
    }
  }

  return events
}

function buildCodexTurnEventDescriptors(turnsRaw: unknown): CodexCanonicalEventDescriptor[] {
  if (!Array.isArray(turnsRaw)) return []
  const events: CodexCanonicalEventDescriptor[] = []

  for (let turnIdx = 0; turnIdx < turnsRaw.length; turnIdx += 1) {
    const rawTurn = turnsRaw[turnIdx]
    if (!isRecord(rawTurn)) continue
    const turnId = typeof rawTurn.id === 'string' && rawTurn.id.length > 0 ? rawTurn.id : undefined
    const turnKey = turnId !== undefined ? `id:${turnId}` : `pos:${turnIdx}`
    events.push({
      key: `turn:${turnKey}:start`,
      type: 'turn/start',
      data: turnId !== undefined ? { turnId } : {},
    })

    const items = Array.isArray(rawTurn.items) ? rawTurn.items : []
    for (let itemIdx = 0; itemIdx < items.length; itemIdx += 1) {
      const rawItem = items[itemIdx]
      if (!isRecord(rawItem)) continue
      events.push(...buildCodexItemDescriptors(rawItem, turnKey, itemIdx))
    }

    events.push({
      key: `turn:${turnKey}:end`,
      type: 'turn/end',
      data: {
        ...(turnId !== undefined ? { turnId } : {}),
        status: rawTurn.status ?? 'completed',
      },
    })
  }

  return events
}

/**
 * Multi-agent backend driving OpenAI Codex CLI (`codex app-server --stdio`).
 */
export class CodexAgentBackend implements ManagedAgentBackend {
  readonly engineId: AgentEngineId = 'codex'
  readonly displayName = 'Codex CLI'

  private readonly command: string
  private readonly args: readonly string[]
  private readonly defaultCwd: string
  private readonly env: NodeJS.ProcessEnv
  private readonly emitter = new MonotonicSessionEventEmitter()

  private rpc: NdjsonRpcProcess | undefined
  private startPromise: Promise<NdjsonRpcProcess> | undefined
  private readonly resumedThreads = new Set<string>()
  private readonly seededHistoryThreads = new Set<string>()
  private readonly canonicalSeqByThread = new Map<string, Map<string, number>>()
  private readonly liveItemIndexByTurn = new Map<string, number>()
  private readonly activeTurnByThread = new Map<string, string>()
  private readonly sessions = new Map<string, CachedThreadMeta>()
  private readonly pendingApprovals = new Map<string, PendingCodexApproval>()
  private readonly pendingQuestions = new Map<string, PendingCodexQuestion>()

  constructor(private readonly options: CodexBackendOptions = {}) {
    this.command = options.command ?? 'codex'
    this.args = options.args ?? ['app-server', '--stdio']
    this.defaultCwd = options.defaultCwd ?? process.cwd()
    this.env = options.env ?? process.env
  }

  onEvent(listener: (sessionId: string, events: readonly OfficialSessionEvent[]) => void): () => void {
    return this.emitter.subscribe(listener)
  }

  async probe(): Promise<EngineDescriptor> {
    const binaryPath = findBinaryOnPath(this.command, this.env)
    const version = binaryPath ? await probeBinaryVersion(binaryPath, ['--version'], this.env) : undefined
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
        history: Boolean(binaryPath),
        abortTurn: Boolean(binaryPath),
        approvals: true,
        questions: true,
        streaming: true,
        models: Boolean(binaryPath),
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
    this.resumedThreads.clear()
    this.activeTurnByThread.clear()
    for (const [id, entry] of this.pendingApprovals.entries()) {
      this.pendingApprovals.delete(id)
      entry.resolve({ decision: 'cancel' })
    }
    for (const [id, entry] of this.pendingQuestions.entries()) {
      this.pendingQuestions.delete(id)
      entry.reject(new Error('codex host stopping'))
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
          `Codex CLI '${this.command}' is not installed on PATH`,
        )
      }

      const proc = new NdjsonRpcProcess({
        command: binaryPath ?? this.command,
        args: this.args,
        cwd: this.defaultCwd,
        env: this.env,
        includeJsonRpcHeader: false,
        defaultRequestTimeoutMs: this.options.requestTimeoutMs ?? 30_000,
        ...(this.options.spawnFn !== undefined ? { spawnFn: this.options.spawnFn } : {}),
        onNotification: (method, params) => this.handleNotification(method, params),
        onServerRequest: (method, params) => this.handleServerRequest(method, params),
        onExit: () => {
          if (this.rpc === proc) {
            this.rpc = undefined
            this.resumedThreads.clear()
            this.activeTurnByThread.clear()
          }
        },
      })

      try {
        await proc.request('initialize', {
          clientInfo: { name: 'dsh-community', version: '0.3.0' },
          capabilities: { experimentalApi: true },
        }, 10_000)
        proc.notify('initialized', {})
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
    if (parsed.engine !== undefined && parsed.engine !== 'codex') {
      throw new RemoteProtocolError('INVALID_REQUEST', `session not found in codex: ${sessionId}`)
    }
    return parsed.nativeId
  }

  private cacheThread(raw: Record<string, unknown>): CachedThreadMeta | undefined {
    const nativeId = typeof raw.id === 'string' ? raw.id : undefined
    if (!nativeId) return undefined
    const sessionId = formatNamespacedSessionId('codex', nativeId)
    const prev = this.sessions.get(nativeId)
    const previewText = typeof raw.preview === 'string' ? extractTextSnippet(raw.preview, 140) : undefined
    const explicitName = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : undefined
    const title = explicitName ?? prev?.title ?? previewText
    const cwd = typeof raw.cwd === 'string' && raw.cwd.length > 0 ? raw.cwd : prev?.cwd
    const updatedAtSec = typeof raw.updatedAt === 'number' ? raw.updatedAt : undefined
    const updatedAtMs = updatedAtSec !== undefined ? Math.trunc(updatedAtSec * 1000) : prev?.updatedAtMs
    const statusObj = isRecord(raw.status) ? raw.status : undefined
    const running =
      this.activeTurnByThread.has(nativeId)
      || statusObj?.type === 'active'
      || raw.status === 'running'
    const modelProvider = typeof raw.modelProvider === 'string' ? raw.modelProvider : prev?.model?.provider ?? 'openai'
    const modelName = typeof raw.model === 'string' ? raw.model : prev?.model?.model
    const reasoningEffort = typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort : prev?.model?.reasoningEffort
    const model: ModelSelectionParams | undefined =
      modelName !== undefined
        ? {
            provider: modelProvider,
            model: modelName,
            ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
          }
        : prev?.model

    const meta: CachedThreadMeta = {
      nativeId,
      sessionId,
      title,
      cwd,
      preview: previewText ?? prev?.preview,
      updatedAtMs,
      status: running ? 'running' : 'idle',
      model,
      usage: prev?.usage,
    }
    this.sessions.set(nativeId, meta)
    return meta
  }

  private toSessionRef(meta: CachedThreadMeta): SessionRef {
    let pendingApprovals = 0
    for (const a of this.pendingApprovals.values()) {
      if (a.sessionId === meta.sessionId) pendingApprovals += 1
    }
    let pendingQuestions = 0
    for (const q of this.pendingQuestions.values()) {
      if (q.sessionId === meta.sessionId) pendingQuestions += 1
    }
    return {
      id: meta.sessionId,
      engine: 'codex',
      nativeSessionId: meta.nativeId,
      ...(meta.title !== undefined ? { title: meta.title } : {}),
      ...(meta.updatedAtMs !== undefined ? { updatedAtMs: meta.updatedAtMs } : {}),
      ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
      status: meta.status,
      ...(meta.preview !== undefined ? { preview: meta.preview } : {}),
      ...(meta.model !== undefined ? { model: meta.model } : {}),
      ...(pendingApprovals > 0 ? { pendingApprovals } : {}),
      ...(pendingQuestions > 0 ? { pendingQuestions } : {}),
    }
  }

  async listSessions(): Promise<readonly SessionRef[]> {
    const rpc = await this.ensureRpc()
    const res = await rpc.request<{ data?: unknown[] }>('thread/list', {
      limit: 50,
      useStateDbOnly: true,
    })
    const rows = Array.isArray(res?.data) ? res.data : []
    const refs: SessionRef[] = []
    for (const row of rows) {
      if (!isRecord(row)) continue
      const meta = this.cacheThread(row)
      if (meta) refs.push(this.toSessionRef(meta))
    }
    refs.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0))
    return refs
  }

  async assertSession(sessionId: string): Promise<void> {
    const nativeId = this.resolveNativeId(sessionId)
    if (this.sessions.has(nativeId)) return
    const rpc = await this.ensureRpc()
    try {
      const res = await rpc.request<{ thread?: unknown }>('thread/read', {
        threadId: nativeId,
        includeTurns: false,
      })
      if (isRecord(res?.thread)) {
        this.cacheThread(res.thread)
        return
      }
    } catch {}
    throw new RemoteProtocolError('INVALID_REQUEST', `codex thread '${nativeId}' was not found`)
  }

  async createSession(options?: CreateSessionParams): Promise<SessionRef> {
    const rpc = await this.ensureRpc()
    const res = await rpc.request<{ thread?: Record<string, unknown> }>('thread/start', {
      cwd: options?.cwd ?? this.defaultCwd,
      approvalPolicy: 'on-request',
      ...(options?.model?.model ? { model: options.model.model } : {}),
      ...(options?.model?.provider ? { modelProvider: options.model.provider } : {}),
    })
    const threadRec = isRecord(res?.thread) ? res.thread : undefined
    if (!threadRec || typeof threadRec.id !== 'string') {
      throw new RemoteProtocolError('INVALID_REQUEST', 'codex thread/start did not return a thread id')
    }
    this.resumedThreads.add(threadRec.id)
    this.seededHistoryThreads.add(threadRec.id)
    if (options?.title) {
      await rpc.request('thread/name/set', { threadId: threadRec.id, name: options.title }).catch(() => {})
      threadRec.name = options.title
    }
    const meta = this.cacheThread(threadRec)!
    return this.toSessionRef(meta)
  }

  async renameSession(sessionId: string, title: string): Promise<SessionRef> {
    const nativeId = this.resolveNativeId(sessionId)
    await this.assertSession(sessionId)
    const rpc = await this.ensureRpc()
    await rpc.request('thread/name/set', { threadId: nativeId, name: title })
    const meta = this.sessions.get(nativeId)
    if (meta) {
      meta.title = title
      meta.updatedAtMs = Date.now()
    }
    this.emitter.emit(formatNamespacedSessionId('codex', nativeId), 'session/title', { title })
    return this.toSessionRef(
      meta ?? {
        nativeId,
        sessionId: formatNamespacedSessionId('codex', nativeId),
        title,
        status: 'idle',
      },
    )
  }

  async forkSession(params: SessionForkParams): Promise<SessionRef> {
    const nativeId = this.resolveNativeId(params.sessionId)
    await this.assertSession(params.sessionId)
    const rpc = await this.ensureRpc()
    const res = await rpc.request<{ thread?: Record<string, unknown> }>('thread/fork', {
      threadId: nativeId,
      excludeTurns: true,
    })
    const threadRec = isRecord(res?.thread) ? res.thread : undefined
    if (!threadRec || typeof threadRec.id !== 'string') {
      throw new RemoteProtocolError('INVALID_REQUEST', 'codex thread/fork did not return a thread')
    }
    this.resumedThreads.add(threadRec.id)
    this.seededHistoryThreads.add(threadRec.id)
    if (params.title) {
      await rpc.request('thread/name/set', { threadId: threadRec.id, name: params.title }).catch(() => {})
      threadRec.name = params.title
    }
    return this.toSessionRef(this.cacheThread(threadRec)!)
  }

  private getCanonicalSeqMap(nativeId: string): Map<string, number> {
    let map = this.canonicalSeqByThread.get(nativeId)
    if (!map) {
      map = new Map<string, number>()
      this.canonicalSeqByThread.set(nativeId, map)
    }
    return map
  }

  private nextLiveItemIndex(nativeId: string, turnKey: string): number {
    const scopeKey = `${nativeId}:${turnKey}`
    const index = this.liveItemIndexByTurn.get(scopeKey) ?? 0
    this.liveItemIndexByTurn.set(scopeKey, index + 1)
    return index
  }

  private emitCanonicalEvent(
    nativeId: string,
    publicId: string,
    canonicalKey: string | undefined,
    type: string,
    data?: unknown,
  ): void {
    const event = this.emitter.emit(publicId, type, data)
    if (canonicalKey !== undefined) {
      const seqMap = this.getCanonicalSeqMap(nativeId)
      if (!seqMap.has(canonicalKey)) {
        seqMap.set(canonicalKey, event.seq)
      }
    }
  }

  private reconcileThreadTurns(
    nativeId: string,
    publicId: string,
    turnsRaw: unknown,
  ): NormalizedTranscriptEvent[] {
    const descriptors = buildCodexTurnEventDescriptors(turnsRaw)
    const seqMap = this.getCanonicalSeqMap(nativeId)
    const events: NormalizedTranscriptEvent[] = []
    for (const desc of descriptors) {
      let seq = seqMap.get(desc.key)
      if (seq === undefined) {
        seq = this.emitter.nextSeq(publicId)
        seqMap.set(desc.key, seq)
      }
      events.push(
        desc.data !== undefined
          ? { seq, type: desc.type, data: desc.data }
          : { seq, type: desc.type },
      )
    }
    events.sort((a, b) => a.seq - b.seq)
    this.seededHistoryThreads.add(nativeId)
    return events
  }

  private async ensureResumed(rpc: NdjsonRpcProcess, nativeId: string): Promise<void> {
    if (this.resumedThreads.has(nativeId)) return
    const meta = this.sessions.get(nativeId)
    const res = await rpc.request<{ thread?: Record<string, unknown> }>('thread/resume', {
      threadId: nativeId,
      approvalPolicy: 'on-request',
      ...(meta?.model?.model ? { model: meta.model.model } : {}),
    })
    const publicId = formatNamespacedSessionId('codex', nativeId)
    if (isRecord(res?.thread)) {
      this.cacheThread(res.thread)
      if (!this.seededHistoryThreads.has(nativeId) && Array.isArray(res.thread.turns)) {
        this.reconcileThreadTurns(nativeId, publicId, res.thread.turns)
      }
    }
    if (!this.seededHistoryThreads.has(nativeId)) {
      try {
        const readRes = await rpc.request<{ thread?: Record<string, unknown> }>('thread/read', {
          threadId: nativeId,
          includeTurns: true,
        })
        if (isRecord(readRes?.thread)) {
          this.cacheThread(readRes.thread)
          if (Array.isArray(readRes.thread.turns)) {
            this.reconcileThreadTurns(nativeId, publicId, readRes.thread.turns)
          }
        }
      } catch {}
      this.seededHistoryThreads.add(nativeId)
    }
    this.resumedThreads.add(nativeId)
  }

  async followup(sessionId: string, prompt: string, options?: FollowupOptions): Promise<unknown> {
    const nativeId = this.resolveNativeId(sessionId)
    await this.assertSession(sessionId)
    const rpc = await this.ensureRpc()
    await this.ensureResumed(rpc, nativeId)

    const input = buildCodexUserInput(prompt, options)
    const activeTurnId = this.activeTurnByThread.get(nativeId)
    const publicId = formatNamespacedSessionId('codex', nativeId)

    if (options?.mode === 'steer' && activeTurnId) {
      const steerRes = await rpc.request<{ turnId?: string }>('turn/steer', {
        threadId: nativeId,
        expectedTurnId: activeTurnId,
        input,
      })
      this.emitter.emit(publicId, 'user/message', { message: { role: 'user', content: prompt } })
      return { accepted: true, sessionId: publicId, turnId: steerRes?.turnId ?? activeTurnId, mode: 'steer' }
    }

    const meta = this.sessions.get(nativeId)
    const startRes = await rpc.request<{ turn?: { id?: string } }>('turn/start', {
      threadId: nativeId,
      input,
      ...(meta?.cwd ? { cwd: meta.cwd } : {}),
      ...(meta?.model?.model ? { model: meta.model.model } : {}),
      ...(meta?.model?.reasoningEffort ? { effort: meta.model.reasoningEffort } : {}),
      approvalPolicy: 'on-request',
    })
    const turnId = startRes?.turn?.id
    if (turnId) {
      this.activeTurnByThread.set(nativeId, turnId)
    }
    if (meta) {
      meta.status = 'running'
      meta.updatedAtMs = Date.now()
    }
    return { accepted: true, sessionId: publicId, ...(turnId ? { turnId } : {}) }
  }

  async abortTurn(sessionId: string): Promise<unknown> {
    const nativeId = this.resolveNativeId(sessionId)
    await this.assertSession(sessionId)
    const rpc = await this.ensureRpc()
    let turnId = this.activeTurnByThread.get(nativeId)
    if (!turnId) {
      const readRes = await rpc.request<{ thread?: { turns?: Array<{ id?: string; status?: string }> } }>('thread/read', {
        threadId: nativeId,
        includeTurns: true,
      })
      const inProgress = (readRes?.thread?.turns ?? []).find((t) => t.status === 'inProgress' || t.status === 'in_progress')
      turnId = inProgress?.id
    }
    if (!turnId) {
      return { sessionId: formatNamespacedSessionId('codex', nativeId), aborted: false }
    }
    await rpc.request('turn/interrupt', { threadId: nativeId, turnId })
    return { sessionId: formatNamespacedSessionId('codex', nativeId), turnId, aborted: true }
  }

  async respondApproval(callId: string, decision: 'approved' | 'rejected'): Promise<unknown> {
    const pending = this.pendingApprovals.get(callId)
    if (!pending) {
      throw new RemoteProtocolError('INVALID_REQUEST', `unknown codex pending approval '${callId}'`)
    }
    this.pendingApprovals.delete(callId)
    pending.resolve({ decision: decision === 'approved' ? 'accept' : 'decline' })
    this.emitter.emit(pending.sessionId, 'approval.resolved', { callId, decision })
    return { ok: true, callId, decision }
  }

  async respondQuestion(questionId: string, answer: unknown): Promise<unknown> {
    const pending = this.pendingQuestions.get(questionId)
    if (!pending) {
      throw new RemoteProtocolError('INVALID_REQUEST', `unknown codex pending question '${questionId}'`)
    }
    this.pendingQuestions.delete(questionId)
    const answersMap: Record<string, { answers: string[] }> = {}
    const answerRec = isRecord(answer) ? answer : undefined

    if (answerRec && Array.isArray(answerRec.answers)) {
      for (const item of answerRec.answers) {
        if (!isRecord(item) || typeof item.id !== 'string') continue
        const vals: string[] = []
        if (Array.isArray(item.selected)) {
          vals.push(...item.selected.filter((x): x is string => typeof x === 'string'))
        }
        if (typeof item.custom === 'string' && item.custom.trim().length > 0) {
          vals.push(item.custom.trim())
        }
        answersMap[item.id] = { answers: vals }
      }
    } else if (typeof answer === 'string') {
      const firstId = typeof pending.rawQuestions[0]?.id === 'string' ? pending.rawQuestions[0].id : 'q1'
      answersMap[firstId] = { answers: [answer] }
    } else if (answerRec) {
      for (const q of pending.rawQuestions) {
        const qid = typeof q.id === 'string' ? q.id : undefined
        if (!qid) continue
        const val = answerRec[qid]
        if (typeof val === 'string') {
          answersMap[qid] = { answers: [val] }
        } else if (Array.isArray(val)) {
          answersMap[qid] = { answers: val.filter((v): v is string => typeof v === 'string') }
        }
      }
    }

    pending.resolve({ answers: answersMap })
    this.emitter.emit(pending.sessionId, 'question.resolved', { questionId })
    return { ok: true, questionId }
  }

  async listModels(sessionId?: string): Promise<ModelCatalogResult> {
    const rpc = await this.ensureRpc()
    const res = await rpc.request<{ data?: unknown[] }>('model/list', { limit: 100 })
    const rows = Array.isArray(res?.data) ? res.data : []
    const models: ModelOptionRef[] = []
    for (const row of rows) {
      if (!isRecord(row)) continue
      if (row.hidden === true) continue
      const modelId = typeof row.model === 'string' ? row.model : typeof row.id === 'string' ? row.id : undefined
      if (!modelId) continue
      const rawEfforts = Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts : []
      const efforts: ReasoningEffortOption[] = rawEfforts
        .filter((e): e is Record<string, unknown> => isRecord(e) && typeof e.reasoningEffort === 'string')
        .map((e) => ({
          id: e.reasoningEffort as string,
          name: e.reasoningEffort as string,
          ...(typeof e.description === 'string' ? { description: e.description } : {}),
        }))
      models.push({
        provider: 'openai',
        providerName: 'Codex',
        model: modelId,
        name: typeof row.displayName === 'string' ? row.displayName : modelId,
        ...(typeof row.description === 'string' ? { description: row.description } : {}),
        supportsImageInput: true,
        ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
        ...(typeof row.defaultReasoningEffort === 'string' ? { defaultReasoningEffort: row.defaultReasoningEffort } : {}),
      })
    }
    let current: ModelSelectionParams | undefined
    if (sessionId) {
      const nativeId = this.resolveNativeId(sessionId)
      current = this.sessions.get(nativeId)?.model
    }
    return { ...(current !== undefined ? { current } : {}), models }
  }

  async selectModel(sessionId: string, selection: ModelSelectionParams): Promise<unknown> {
    const nativeId = this.resolveNativeId(sessionId)
    await this.assertSession(sessionId)
    const meta = this.sessions.get(nativeId)
    if (meta) {
      meta.model = selection
    }
    if (this.resumedThreads.has(nativeId) && this.rpc?.isAlive()) {
      await this.rpc.request('thread/resume', {
        threadId: nativeId,
        model: selection.model,
        modelProvider: selection.provider,
        excludeTurns: true,
      }).catch(() => {})
    }
    this.emitter.emit(formatNamespacedSessionId('codex', nativeId), 'session.model', selection)
    return { ok: true, sessionId: formatNamespacedSessionId('codex', nativeId), selection }
  }

  async getSessionLiveState(sessionId: string): Promise<SessionLiveStateSnapshot | undefined> {
    const nativeId = this.resolveNativeId(sessionId)
    const meta = this.sessions.get(nativeId)
    if (!meta) return undefined
    const publicId = meta.sessionId
    const pendingApprovals: PendingApprovalSnapshot[] = []
    for (const a of this.pendingApprovals.values()) {
      if (a.sessionId === publicId) {
        pendingApprovals.push({
          callId: a.callId,
          toolName: a.toolName,
          ...(a.reason !== undefined ? { reason: a.reason } : {}),
          ...(a.summary !== undefined ? { summary: a.summary } : {}),
          sessionId: publicId,
        })
      }
    }
    const pendingQuestions: PendingQuestionSnapshot[] = []
    for (const q of this.pendingQuestions.values()) {
      if (q.sessionId === publicId) {
        pendingQuestions.push({
          questionId: q.questionId,
          prompt: q.prompt,
          sessionId: publicId,
        })
      }
    }
    return {
      status: this.activeTurnByThread.has(nativeId) ? 'running' : meta.status,
      ...(meta.model !== undefined ? { model: meta.model } : {}),
      ...(meta.title !== undefined ? { title: meta.title } : {}),
      pendingApprovals,
      pendingQuestions,
      todos: [],
      ...(meta.usage !== undefined ? { usage: meta.usage } : {}),
      oldestSeq: 1,
      latestSeq: this.emitter.currentSeq(publicId) || null,
    }
  }

  async getSessionHistory(params: SessionHistoryParams): Promise<SessionHistoryResult> {
    const nativeId = this.resolveNativeId(params.sessionId)
    const rpc = await this.ensureRpc()
    const res = await rpc.request<{ thread?: Record<string, unknown> }>('thread/read', {
      threadId: nativeId,
      includeTurns: true,
    })
    if (!isRecord(res?.thread)) {
      throw new RemoteProtocolError('INVALID_REQUEST', `codex thread '${nativeId}' not found`)
    }
    this.cacheThread(res.thread)
    const publicId = formatNamespacedSessionId('codex', nativeId)
    const normalized = this.reconcileThreadTurns(nativeId, publicId, res.thread.turns)
    const page = paginateNormalizedTranscriptEvents(normalized, {
      beforeSeq: params.beforeSeq,
      limit: params.limit,
      minTurns: params.minTurns,
    })
    return {
      sessionId: publicId,
      events: page.events,
      hasMore: page.hasMore,
      oldestSeq: page.oldestSeq,
      latestSeq: page.latestSeq,
      source: 'disk',
    }
  }

  async searchSessions(params: SessionSearchParams): Promise<SessionSearchResult> {
    const sources: Array<{
      readonly sessionId: string
      readonly title?: string | undefined
      readonly updatedAt?: string | undefined
      readonly events: readonly NormalizedTranscriptEvent[]
    }> = []

    if (params.sessionId !== undefined) {
      // Scoped search targets the explicit session directly instead of sampling top-N recent threads.
      const nativeId = this.resolveNativeId(params.sessionId)
      const publicId = formatNamespacedSessionId('codex', nativeId)
      const hist = await this.getSessionHistory({ sessionId: publicId, limit: 100 }).catch(() => undefined)
      if (hist) {
        const meta = this.sessions.get(nativeId)
        sources.push({
          sessionId: publicId,
          ...(meta?.title !== undefined ? { title: meta.title } : {}),
          ...(meta?.updatedAtMs !== undefined ? { updatedAt: new Date(meta.updatedAtMs).toISOString() } : {}),
          events: hist.events,
        })
      }
    } else {
      const list = await this.listSessions()
      for (const ref of list.slice(0, 12)) {
        const hist = await this.getSessionHistory({ sessionId: ref.id, limit: 100 }).catch(() => undefined)
        if (!hist) continue
        sources.push({
          sessionId: ref.id,
          ...(ref.title !== undefined ? { title: ref.title } : {}),
          ...(ref.updatedAtMs !== undefined ? { updatedAt: new Date(ref.updatedAtMs).toISOString() } : {}),
          events: hist.events,
        })
      }
    }

    const res = searchSessionCollections({
      query: params.query,
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
      sources,
    })
    return {
      query: params.query,
      hits: res.hits,
      hasMore: res.hasMore,
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
    const params = isRecord(rawParams) ? rawParams : undefined
    if (!params) return
    const nativeId = typeof params.threadId === 'string'
      ? params.threadId
      : isRecord(params.thread) && typeof params.thread.id === 'string'
        ? params.thread.id
        : undefined
    if (!nativeId) return
    const publicId = formatNamespacedSessionId('codex', nativeId)

    if (method === 'thread/started' && isRecord(params.thread)) {
      this.cacheThread(params.thread)
      return
    }
    if (method === 'thread/name/updated' && typeof params.threadName === 'string') {
      const meta = this.sessions.get(nativeId)
      if (meta) meta.title = params.threadName
      this.emitter.emit(publicId, 'session/title', { title: params.threadName })
      return
    }
    if (method === 'turn/started') {
      const turnRec = isRecord(params.turn) ? params.turn : undefined
      const turnId = typeof turnRec?.id === 'string' && turnRec.id.length > 0 ? turnRec.id : undefined
      if (turnId) this.activeTurnByThread.set(nativeId, turnId)
      const meta = this.sessions.get(nativeId)
      if (meta) meta.status = 'running'
      this.emitCanonicalEvent(
        nativeId,
        publicId,
        turnId !== undefined ? `turn:id:${turnId}:start` : undefined,
        'turn/start',
        turnId ? { turnId } : {},
      )
      return
    }
    if (method === 'turn/completed') {
      const turnRec = isRecord(params.turn) ? params.turn : undefined
      const turnId = typeof turnRec?.id === 'string' && turnRec.id.length > 0
        ? turnRec.id
        : this.activeTurnByThread.get(nativeId)
      this.activeTurnByThread.delete(nativeId)
      if (turnId) {
        this.liveItemIndexByTurn.delete(`${nativeId}:id:${turnId}`)
      }
      const meta = this.sessions.get(nativeId)
      if (meta) {
        meta.status = 'idle'
        meta.updatedAtMs = Date.now()
      }
      this.emitCanonicalEvent(
        nativeId,
        publicId,
        turnId !== undefined ? `turn:id:${turnId}:end` : undefined,
        'turn/end',
        {
          ...(typeof turnRec?.id === 'string' ? { turnId: turnRec.id } : {}),
          status: turnRec?.status ?? 'completed',
        },
      )
      return
    }
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      this.emitter.emit(publicId, 'assistant/chunk', {
        text: params.delta,
        chunk: { type: 'text-delta', text: params.delta },
        ...(params.itemId !== undefined ? { itemId: params.itemId } : {}),
      })
      return
    }
    if (
      (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta')
      && typeof params.delta === 'string'
    ) {
      this.emitter.emit(publicId, 'assistant/chunk', {
        text: params.delta,
        chunk: { type: 'reasoning-delta', text: params.delta },
        ...(params.itemId !== undefined ? { itemId: params.itemId } : {}),
      })
      return
    }
    if (method === 'item/commandExecution/outputDelta' && typeof params.delta === 'string') {
      this.emitter.emit(publicId, 'tool/output', { callId: params.itemId, delta: params.delta })
      return
    }
    if (method === 'turn/diff/updated' && typeof params.diff === 'string') {
      this.emitter.emit(publicId, 'workspace/diff', { turnId: params.turnId, diff: params.diff })
      return
    }
    if (method === 'thread/tokenUsage/updated' && isRecord(params.tokenUsage)) {
      const total = isRecord(params.tokenUsage.total) ? params.tokenUsage.total : params.tokenUsage
      const inputTokens = Number(total.inputTokens ?? 0) || 0
      const outputTokens = Number(total.outputTokens ?? 0) || 0
      const totalTokens = Number(total.totalTokens ?? inputTokens + outputTokens) || 0
      const meta = this.sessions.get(nativeId)
      if (meta) {
        meta.usage = {
          inputTokens,
          outputTokens,
          totalTokens,
          turns: (meta.usage?.turns ?? 0) + 1,
        }
      }
      this.emitter.emit(publicId, 'session/usage', { inputTokens, outputTokens, totalTokens })
      return
    }
    if (method === 'item/completed' && isRecord(params.item)) {
      const turnId = typeof params.turnId === 'string' && params.turnId.length > 0
        ? params.turnId
        : this.activeTurnByThread.get(nativeId)
      const turnKey = turnId !== undefined ? `id:${turnId}` : 'live'
      const itemIndex = this.nextLiveItemIndex(nativeId, turnKey)
      const converted = buildCodexItemDescriptors(params.item, turnKey, itemIndex)
      for (const ev of converted) {
        this.emitCanonicalEvent(
          nativeId,
          publicId,
          turnId !== undefined ? ev.key : undefined,
          ev.type,
          ev.data,
        )
      }
    }
  }

  private async handleServerRequest(method: string, rawParams: unknown): Promise<unknown> {
    const params = isRecord(rawParams) ? rawParams : {}
    const nativeId = typeof params.threadId === 'string' ? params.threadId : ''
    const publicId = nativeId ? formatNamespacedSessionId('codex', nativeId) : formatNamespacedSessionId('codex', 'unknown')

    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const callId = `codex-apr-${randomUUID()}`
      const isCmd = method === 'item/commandExecution/requestApproval'
      const toolName = isCmd ? 'bash' : 'file_change'
      const summary = isCmd && typeof params.command === 'string'
        ? params.command
        : typeof params.reason === 'string'
          ? params.reason
          : toolName
      const reason = typeof params.reason === 'string' ? params.reason : undefined

      return await new Promise((resolve, reject) => {
        this.pendingApprovals.set(callId, {
          callId,
          sessionId: publicId,
          toolName,
          reason,
          summary,
          resolve,
          reject,
        })
        this.emitter.emit(publicId, 'approval.request', {
          callId,
          toolName,
          ...(reason !== undefined ? { reason } : {}),
          summary,
          args: isCmd ? { command: params.command, cwd: params.cwd } : { grantRoot: params.grantRoot },
        })
      })
    }

    if (method === 'item/tool/requestUserInput') {
      const questionId = `codex-q-${randomUUID()}`
      const rawQuestions = Array.isArray(params.questions)
        ? params.questions.filter((q): q is Record<string, unknown> => isRecord(q))
        : []
      const firstPrompt = typeof rawQuestions[0]?.question === 'string'
        ? rawQuestions[0].question
        : 'Codex requested additional input'

      return await new Promise((resolve, reject) => {
        this.pendingQuestions.set(questionId, {
          questionId,
          sessionId: publicId,
          prompt: firstPrompt,
          rawQuestions,
          resolve,
          reject,
        })
        this.emitter.emit(publicId, 'question.request', {
          questionId,
          prompt: firstPrompt,
          questions: rawQuestions,
        })
      })
    }

    throw new Error(`Unsupported Codex server request: ${method}`)
  }
}
