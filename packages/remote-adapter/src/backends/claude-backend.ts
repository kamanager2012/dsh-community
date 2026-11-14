import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { RemoteProtocolError } from '../errors.js'
import type {
  AgentEngineId,
  CreateSessionParams,
  EngineDescriptor,
  FollowupOptions,
  ModelCatalogResult,
  ModelSelectionParams,
  OfficialSessionEvent,
  PendingApprovalSnapshot,
  PendingQuestionSnapshot,
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
import {
  isSafeSessionId,
  paginateNormalizedTranscriptEvents,
  searchSessionCollections,
  type NormalizedTranscriptEvent,
} from '../session-transcript.js'
import { inspectWorkspaceGitDiff, inspectWorkspaceGitStatus } from './git-review.js'
import {
  extractTextSnippet,
  findBinaryOnPath,
  formatNamespacedSessionId,
  isRecord,
  MonotonicSessionEventEmitter,
  parseNamespacedSessionId,
  probeBinaryVersion,
  sanitizeSubprocessEnv,
  type ManagedAgentBackend,
} from './types.js'

export interface ClaudeBackendOptions {
  readonly command?: string | undefined
  readonly defaultCwd?: string | undefined
  readonly projectsDir?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly spawnFn?: typeof spawn | undefined
}

interface DiscoveredClaudeSession {
  readonly nativeId: string
  readonly sessionId: string
  readonly filePath?: string | undefined
  title?: string | undefined
  cwd?: string | undefined
  preview?: string | undefined
  updatedAtMs: number
  model?: ModelSelectionParams | undefined
  readonly createdNew: boolean
  hasLaunchedWorker?: boolean | undefined
}

function modelsMatch(a?: ModelSelectionParams, b?: ModelSelectionParams): boolean {
  return (a?.provider ?? undefined) === (b?.provider ?? undefined)
    && (a?.model ?? undefined) === (b?.model ?? undefined)
    && (a?.reasoningEffort ?? undefined) === (b?.reasoningEffort ?? undefined)
}

interface PendingClaudeApproval {
  readonly callId: string
  readonly sessionId: string
  readonly toolName: string
  readonly reason?: string | undefined
  readonly input: Record<string, unknown>
  readonly requestId: string
  readonly worker: ClaudeLiveWorker
}

interface PendingClaudeQuestion {
  readonly questionId: string
  readonly sessionId: string
  readonly prompt: string
  readonly input: Record<string, unknown>
  readonly requestId: string
  readonly worker: ClaudeLiveWorker
}

interface ClaudeLiveWorker {
  readonly nativeId: string
  readonly sessionId: string
  readonly child: ChildProcess
  running: boolean
  needsResumeArg: boolean
  model?: ModelSelectionParams | undefined
}

const MAX_SCAN_FILE_BYTES = 32 * 1024 * 1024
const HEAD_SLICE_BYTES = 24 * 1024
const TAIL_SLICE_BYTES = 48 * 1024

function readHeadAndTailText(filePath: string): { head: string; tail: string; mtimeMs: number; size: number } {
  let fd: number | undefined
  try {
    fd = openSync(filePath, 'r')
    const st = fstatSync(fd)
    const size = st.size
    const headLen = Math.min(size, HEAD_SLICE_BYTES)
    const headBuf = Buffer.allocUnsafe(headLen)
    if (headLen > 0) readSync(fd, headBuf, 0, headLen, 0)
    const tailOffset = Math.max(0, size - TAIL_SLICE_BYTES)
    const tailLen = size - tailOffset
    const tailBuf = Buffer.allocUnsafe(tailLen)
    if (tailLen > 0) readSync(fd, tailBuf, 0, tailLen, tailOffset)
    return {
      head: headBuf.toString('utf8'),
      tail: tailBuf.toString('utf8'),
      mtimeMs: st.mtimeMs,
      size,
    }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

function summarizeClaudeSessionFile(
  filePath: string,
  fallbackId: string,
): DiscoveredClaudeSession | undefined {
  let slice: { head: string; tail: string; mtimeMs: number; size: number }
  try {
    slice = readHeadAndTailText(filePath)
  } catch {
    return undefined
  }
  let nativeId = fallbackId
  let cwd: string | undefined
  let title: string | undefined
  let preview: string | undefined
  let latestTs = slice.mtimeMs
  let modelName: string | undefined

  const inspectLines = (raw: string, dropPartialEnds: boolean): void => {
    const lines = raw.split('\n')
    const start = dropPartialEnds ? 1 : 0
    const end = dropPartialEnds ? Math.max(start, lines.length - 1) : lines.length
    for (let i = start; i < end; i += 1) {
      const line = lines[i]?.trim()
      if (!line || !line.startsWith('{')) continue
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        if (typeof obj.sessionId === 'string' && isSafeSessionId(obj.sessionId)) {
          nativeId = obj.sessionId
        }
        if (typeof obj.cwd === 'string' && obj.cwd.length > 0 && !cwd) {
          cwd = obj.cwd
        }
        if (typeof obj.timestamp === 'string') {
          const parsed = Date.parse(obj.timestamp)
          if (Number.isFinite(parsed)) latestTs = Math.max(latestTs, parsed)
        }
        if (obj.type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle.trim()) {
          title = obj.customTitle.trim()
        }
        if (obj.type === 'summary' && typeof obj.summary === 'string' && obj.summary.trim() && !title) {
          title = obj.summary.trim()
        }
        if (obj.type === 'last-prompt' && typeof obj.lastPrompt === 'string' && !preview) {
          preview = extractTextSnippet(obj.lastPrompt, 140)
        }
        if ((obj.type === 'user' || obj.type === 'assistant') && isRecord(obj.message)) {
          const text = extractMessageText(obj.message.content)
          const snippet = text ? extractTextSnippet(text, 140) : undefined
          if (obj.type === 'user' && snippet && !title) title = snippet
          if (snippet) preview = snippet
          if (obj.type === 'assistant' && typeof obj.message.model === 'string') {
            modelName = obj.message.model
          }
        }
      } catch {}
    }
  }

  inspectLines(slice.head, false)
  inspectLines(slice.tail, slice.size > TAIL_SLICE_BYTES)

  if (!isSafeSessionId(nativeId)) return undefined
  return {
    nativeId,
    sessionId: formatNamespacedSessionId('claude', nativeId),
    filePath,
    ...(title !== undefined ? { title } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(preview !== undefined ? { preview } : {}),
    updatedAtMs: latestTs,
    ...(modelName !== undefined ? { model: { provider: 'anthropic', model: modelName } } : {}),
    createdNew: false,
  }
}

function parseClaudeTranscriptFile(filePath: string): NormalizedTranscriptEvent[] {
  const st = statSync(filePath)
  if (st.size > MAX_SCAN_FILE_BYTES) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'claude transcript exceeds max readable size')
  }
  const raw = readFileSync(filePath, 'utf8')
  const events: NormalizedTranscriptEvent[] = []
  let seq = 0
  const push = (type: string, data?: unknown, time?: number): void => {
    seq += 1
    events.push({
      seq,
      type,
      ...(time !== undefined ? { time } : {}),
      ...(data !== undefined ? { data } : {}),
    })
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith('{')) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    const time = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : undefined
    const validTime = time !== undefined && Number.isFinite(time) ? time : undefined

    if (obj.type === 'user' && isRecord(obj.message)) {
      const content = obj.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block)) continue
          if (block.type === 'tool_result') {
            push('tool/result', {
              callId: block.tool_use_id,
              result: block.content,
              isError: block.is_error === true,
            }, validTime)
          }
        }
      }
      const text = extractMessageText(content)
      if (text.trim().length > 0) {
        push('user/message', { message: { role: 'user', content: text } }, validTime)
      }
    } else if (obj.type === 'assistant' && isRecord(obj.message)) {
      const content = obj.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block)) continue
          if (block.type === 'thinking' && typeof block.thinking === 'string') {
            push('thinking/message', { text: block.thinking }, validTime)
          } else if (block.type === 'tool_use') {
            push('tool/call', {
              callId: block.id,
              toolName: block.name ?? 'tool',
              args: block.input,
            }, validTime)
          }
        }
      }
      const text = extractMessageText(content)
      if (text.trim().length > 0) {
        push('assistant/message', {
          message: { role: 'assistant', content: text, usage: obj.message.usage },
        }, validTime)
      }
    }
  }
  return events
}

/**
 * Multi-agent backend integrating Claude Code CLI (`--print --input-format stream-json --output-format stream-json`)
 * and local `~/.claude/projects` transcript discovery.
 */
export class ClaudeAgentBackend implements ManagedAgentBackend {
  readonly engineId: AgentEngineId = 'claude'
  readonly displayName = 'Claude Code'

  private readonly command: string
  private readonly defaultCwd: string
  private readonly projectsDir: string
  private readonly env: NodeJS.ProcessEnv
  private readonly emitter = new MonotonicSessionEventEmitter()

  private readonly sessions = new Map<string, DiscoveredClaudeSession>()
  private readonly workers = new Map<string, ClaudeLiveWorker>()
  private readonly pendingApprovals = new Map<string, PendingClaudeApproval>()
  private readonly pendingQuestions = new Map<string, PendingClaudeQuestion>()

  constructor(private readonly options: ClaudeBackendOptions = {}) {
    this.command = options.command ?? 'claude'
    this.defaultCwd = options.defaultCwd ?? process.cwd()
    this.projectsDir = options.projectsDir ?? join(homedir(), '.claude', 'projects')
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
      available: Boolean(binaryPath) || existsSync(this.projectsDir),
      running: this.workers.size > 0,
      ...(binaryPath !== undefined ? { binaryPath } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(binaryPath === undefined ? { error: `'${this.command}' binary not found on PATH` } : {}),
      capabilities: {
        createSession: Boolean(binaryPath),
        listSessions: true,
        history: true,
        abortTurn: Boolean(binaryPath),
        approvals: Boolean(binaryPath),
        questions: Boolean(binaryPath),
        streaming: Boolean(binaryPath),
        models: true,
        gitReview: true,
      },
    }
  }

  private clearWorkerPendingInteractions(worker: ClaudeLiveWorker, reason: string): void {
    for (const [callId, pending] of this.pendingApprovals.entries()) {
      if (pending.worker !== worker) continue
      this.pendingApprovals.delete(callId)
      this.emitter.emit(pending.sessionId, 'approval.resolved', {
        callId,
        decision: 'rejected',
        cancelled: true,
        reason,
      })
    }
    for (const [questionId, pending] of this.pendingQuestions.entries()) {
      if (pending.worker !== worker) continue
      this.pendingQuestions.delete(questionId)
      this.emitter.emit(pending.sessionId, 'question.resolved', {
        questionId,
        cancelled: true,
        reason,
      })
    }
  }

  private retireWorker(nativeId: string, worker: ClaudeLiveWorker, reason: string): void {
    worker.running = false
    if (this.workers.get(nativeId) === worker) {
      this.workers.delete(nativeId)
    }
    this.clearWorkerPendingInteractions(worker, reason)
    if (worker.child.exitCode === null) {
      try {
        worker.child.stdin?.end()
      } catch {}
      try {
        worker.child.kill('SIGTERM')
      } catch {}
    }
  }

  async stop(): Promise<void> {
    for (const [id, pending] of this.pendingApprovals.entries()) {
      this.pendingApprovals.delete(id)
      this.sendControlResponse(pending.worker, pending.requestId, {
        behavior: 'deny',
        message: 'Host shutting down',
      })
      this.emitter.emit(pending.sessionId, 'approval.resolved', {
        callId: id,
        decision: 'rejected',
        cancelled: true,
        reason: 'host_stopped',
      })
    }
    for (const [id, pending] of this.pendingQuestions.entries()) {
      this.pendingQuestions.delete(id)
      this.sendControlResponse(pending.worker, pending.requestId, {
        behavior: 'deny',
        message: 'Host shutting down',
      })
      this.emitter.emit(pending.sessionId, 'question.resolved', {
        questionId: id,
        cancelled: true,
        reason: 'host_stopped',
      })
    }
    const stops = [...this.workers.values()].map(async (worker) => {
      if (worker.child.exitCode === null) {
        try {
          worker.child.stdin?.end()
        } catch {}
        worker.child.kill('SIGTERM')
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (worker.child.exitCode === null) worker.child.kill('SIGKILL')
            resolve()
          }, 1500)
          timer.unref()
          worker.child.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
    })
    this.workers.clear()
    await Promise.allSettled(stops)
  }

  private resolveNativeId(sessionId: string): string {
    const parsed = parseNamespacedSessionId(sessionId)
    if (parsed.engine !== undefined && parsed.engine !== 'claude') {
      throw new RemoteProtocolError('INVALID_REQUEST', `session '${sessionId}' does not belong to claude`)
    }
    return parsed.nativeId
  }

  private scanDiskSessions(): void {
    if (!existsSync(this.projectsDir)) return
    let projectDirs: Array<{ name: string; isDirectory(): boolean }>
    try {
      projectDirs = readdirSync(this.projectsDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue
      const dirPath = join(this.projectsDir, dir.name)
      let entries: Array<{ name: string; isFile(): boolean }>
      try {
        entries = readdirSync(dirPath, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const stem = basename(entry.name, '.jsonl')
        if (!isSafeSessionId(stem)) continue
        const fullPath = join(dirPath, entry.name)
        const existing = this.sessions.get(stem)
        try {
          const st = statSync(fullPath)
          if (existing && existing.updatedAtMs >= st.mtimeMs && existing.filePath === fullPath) {
            continue
          }
        } catch {
          continue
        }
        const summary = summarizeClaudeSessionFile(fullPath, stem)
        if (summary) {
          this.sessions.set(summary.nativeId, {
            ...summary,
            ...(existing?.title && !summary.title ? { title: existing.title } : {}),
            ...(existing?.model ? { model: existing.model } : {}),
          })
        }
      }
    }
  }

  private toSessionRef(meta: DiscoveredClaudeSession): SessionRef {
    const worker = this.workers.get(meta.nativeId)
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
      engine: 'claude',
      nativeSessionId: meta.nativeId,
      ...(meta.title !== undefined ? { title: meta.title } : {}),
      updatedAtMs: meta.updatedAtMs,
      ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
      status: worker?.running ? 'running' : 'idle',
      ...(meta.preview !== undefined ? { preview: meta.preview } : {}),
      ...(meta.model !== undefined ? { model: meta.model } : {}),
      ...(pendingApprovals > 0 ? { pendingApprovals } : {}),
      ...(pendingQuestions > 0 ? { pendingQuestions } : {}),
    }
  }

  async listSessions(): Promise<readonly SessionRef[]> {
    this.scanDiskSessions()
    const refs = [...this.sessions.values()].map((m) => this.toSessionRef(m))
    refs.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0))
    return refs.slice(0, 100)
  }

  async assertSession(sessionId: string): Promise<void> {
    const nativeId = this.resolveNativeId(sessionId)
    if (this.sessions.has(nativeId)) return
    this.scanDiskSessions()
    if (this.sessions.has(nativeId)) return
    throw new RemoteProtocolError('INVALID_REQUEST', `claude session '${nativeId}' not found`)
  }

  async createSession(options?: CreateSessionParams): Promise<SessionRef> {
    const nativeId = options?.sessionId ? this.resolveNativeId(options.sessionId) : randomUUID()
    const meta: DiscoveredClaudeSession = {
      nativeId,
      sessionId: formatNamespacedSessionId('claude', nativeId),
      title: options?.title ?? 'Claude Session',
      cwd: options?.cwd ?? this.defaultCwd,
      updatedAtMs: Date.now(),
      ...(options?.model !== undefined ? { model: options.model } : {}),
      createdNew: true,
    }
    this.sessions.set(nativeId, meta)
    return this.toSessionRef(meta)
  }

  async renameSession(sessionId: string, title: string): Promise<SessionRef> {
    const nativeId = this.resolveNativeId(sessionId)
    await this.assertSession(sessionId)
    const meta = this.sessions.get(nativeId)!
    meta.title = title
    meta.updatedAtMs = Date.now()
    this.emitter.emit(meta.sessionId, 'session/title', { title })
    return this.toSessionRef(meta)
  }

  private ensureWorker(meta: DiscoveredClaudeSession): ClaudeLiveWorker {
    const existing = this.workers.get(meta.nativeId)
    if (existing && existing.child.exitCode === null && !existing.child.killed) {
      if (modelsMatch(existing.model, meta.model)) {
        return existing
      }
      // Respawn with --resume --model when the selected model differs from the launched subprocess.
      this.retireWorker(meta.nativeId, existing, 'model_changed')
    }

    const binaryPath = findBinaryOnPath(this.command, this.env)
    if (!binaryPath && !this.options.spawnFn) {
      throw new RemoteProtocolError(
        'INVALID_REQUEST',
        `Claude Code CLI '${this.command}' is not installed on PATH`,
      )
    }

    const spawnImpl = this.options.spawnFn ?? spawn
    const sessionCwd = meta.cwd ?? this.defaultCwd
    const useFreshSessionId = meta.createdNew && !meta.hasLaunchedWorker && meta.filePath === undefined
    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompts', 'host',
      ...(useFreshSessionId
        ? ['--session-id', meta.nativeId]
        : ['--resume', meta.nativeId]),
      ...(meta.model?.model ? ['--model', meta.model.model] : []),
    ]

    const child = spawnImpl(binaryPath ?? this.command, args, {
      cwd: existsSync(sessionCwd) ? sessionCwd : this.defaultCwd,
      env: sanitizeSubprocessEnv(this.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    meta.hasLaunchedWorker = true

    const worker: ClaudeLiveWorker = {
      nativeId: meta.nativeId,
      sessionId: meta.sessionId,
      child,
      running: false,
      needsResumeArg: true,
      model: meta.model,
    }
    this.workers.set(meta.nativeId, worker)

    const decoder = new StringDecoder('utf8')
    let buf = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      buf += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      for (;;) {
        const nl = buf.indexOf('\n')
        if (nl === -1) break
        const line = buf.slice(0, nl).replace(/\r$/u, '')
        buf = buf.slice(nl + 1)
        if (line.trim()) this.handleWorkerLine(worker, meta, line)
      }
    })
    child.stdout?.on('close', () => {
      buf += decoder.end()
      const tail = buf.replace(/\r$/u, '').trim()
      if (tail) this.handleWorkerLine(worker, meta, tail)
    })
    child.stderr?.resume()
    child.once('exit', () => {
      worker.running = false
      const wasActive = this.workers.get(meta.nativeId) === worker
      if (wasActive) {
        this.workers.delete(meta.nativeId)
      }
      this.clearWorkerPendingInteractions(worker, 'worker_exited')
      if (wasActive) {
        this.emitter.emit(meta.sessionId, 'agent/status', { status: 'idle' })
      }
    })

    return worker
  }

  async followup(sessionId: string, prompt: string, options?: FollowupOptions): Promise<unknown> {
    const nativeId = this.resolveNativeId(sessionId)
    await this.assertSession(sessionId)
    const meta = this.sessions.get(nativeId)!
    const worker = this.ensureWorker(meta)
    if (!worker.child.stdin || worker.child.stdin.destroyed) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'claude worker stdin is unavailable')
    }

    const contentBlocks: Array<Record<string, unknown>> = []
    if (prompt.length > 0) {
      contentBlocks.push({ type: 'text', text: prompt })
    }
    for (const att of options?.attachments ?? []) {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: att.mediaType,
          data: att.dataBase64,
        },
      })
    }

    const userFrame = {
      type: 'user',
      message: {
        role: 'user',
        content: contentBlocks.length === 1 && contentBlocks[0]?.type === 'text' ? prompt : contentBlocks,
      },
    }

    worker.running = true
    meta.updatedAtMs = Date.now()
    this.emitter.emit(meta.sessionId, 'turn/start', {})
    this.emitter.emit(meta.sessionId, 'user/message', { message: { role: 'user', content: prompt } })
    worker.child.stdin.write(`${JSON.stringify(userFrame)}\n`)
    return { accepted: true, sessionId: meta.sessionId }
  }

  async abortTurn(sessionId: string): Promise<unknown> {
    const nativeId = this.resolveNativeId(sessionId)
    await this.assertSession(sessionId)
    const worker = this.workers.get(nativeId)
    if (!worker || worker.child.exitCode !== null) {
      return { sessionId: formatNamespacedSessionId('claude', nativeId), aborted: false }
    }
    worker.child.kill('SIGINT')
    worker.running = false
    this.emitter.emit(worker.sessionId, 'turn/end', { interrupted: true })
    return { sessionId: worker.sessionId, aborted: true }
  }

  async respondApproval(callId: string, decision: 'approved' | 'rejected'): Promise<unknown> {
    const pending = this.pendingApprovals.get(callId)
    if (!pending) {
      throw new RemoteProtocolError('INVALID_REQUEST', `unknown claude pending approval '${callId}'`)
    }
    this.pendingApprovals.delete(callId)
    this.sendControlResponse(
      pending.worker,
      pending.requestId,
      decision === 'approved'
        ? { behavior: 'allow', updatedInput: pending.input }
        : { behavior: 'deny', message: 'Rejected by remote operator' },
    )
    this.emitter.emit(pending.sessionId, 'approval.resolved', { callId, decision })
    return { ok: true, callId, decision }
  }

  async respondQuestion(questionId: string, answer: unknown): Promise<unknown> {
    const pending = this.pendingQuestions.get(questionId)
    if (!pending) {
      throw new RemoteProtocolError('INVALID_REQUEST', `unknown claude pending question '${questionId}'`)
    }
    this.pendingQuestions.delete(questionId)
    const answersPayload: Record<string, string> = {}
    const answerRec = isRecord(answer) ? answer : undefined
    if (answerRec && Array.isArray(answerRec.answers)) {
      for (const item of answerRec.answers) {
        if (!isRecord(item) || typeof item.id !== 'string') continue
        const sel = Array.isArray(item.selected) ? item.selected.filter((x): x is string => typeof x === 'string') : []
        const custom = typeof item.custom === 'string' && item.custom ? [item.custom] : []
        answersPayload[item.id] = [...sel, ...custom].join(', ')
      }
    } else if (typeof answer === 'string') {
      answersPayload.answer = answer
    } else if (answerRec) {
      for (const [k, v] of Object.entries(answerRec)) {
        if (typeof v === 'string') answersPayload[k] = v
      }
    }
    this.sendControlResponse(pending.worker, pending.requestId, {
      behavior: 'allow',
      updatedInput: {
        ...pending.input,
        answers: answersPayload,
      },
    })
    this.emitter.emit(pending.sessionId, 'question.resolved', { questionId })
    return { ok: true, questionId }
  }

  async listModels(sessionId?: string): Promise<ModelCatalogResult> {
    let current: ModelSelectionParams | undefined
    if (sessionId) {
      const nativeId = this.resolveNativeId(sessionId)
      current = this.sessions.get(nativeId)?.model
    }
    return {
      ...(current !== undefined ? { current } : {}),
      models: [
        { provider: 'anthropic', providerName: 'Anthropic', model: 'sonnet', name: 'Claude Sonnet', supportsImageInput: true },
        { provider: 'anthropic', providerName: 'Anthropic', model: 'opus', name: 'Claude Opus', supportsImageInput: true },
        { provider: 'anthropic', providerName: 'Anthropic', model: 'haiku', name: 'Claude Haiku', supportsImageInput: true },
      ],
    }
  }

  async selectModel(sessionId: string, selection: ModelSelectionParams): Promise<unknown> {
    const nativeId = this.resolveNativeId(sessionId)
    await this.assertSession(sessionId)
    const meta = this.sessions.get(nativeId)!
    meta.model = selection
    const worker = this.workers.get(nativeId)
    if (worker && !modelsMatch(worker.model, selection) && !worker.running) {
      // Idle worker still runs old --model; retire now so next prompt spawns with updated --model.
      this.retireWorker(nativeId, worker, 'model_changed')
    }
    this.emitter.emit(meta.sessionId, 'session.model', selection)
    return { ok: true, sessionId: meta.sessionId, selection }
  }

  async getSessionLiveState(sessionId: string): Promise<SessionLiveStateSnapshot | undefined> {
    const nativeId = this.resolveNativeId(sessionId)
    const meta = this.sessions.get(nativeId)
    if (!meta) return undefined
    const worker = this.workers.get(nativeId)
    const pendingApprovals: PendingApprovalSnapshot[] = []
    for (const a of this.pendingApprovals.values()) {
      if (a.sessionId === meta.sessionId) {
        pendingApprovals.push({
          callId: a.callId,
          toolName: a.toolName,
          ...(a.reason !== undefined ? { reason: a.reason } : {}),
          sessionId: meta.sessionId,
        })
      }
    }
    const pendingQuestions: PendingQuestionSnapshot[] = []
    for (const q of this.pendingQuestions.values()) {
      if (q.sessionId === meta.sessionId) {
        pendingQuestions.push({
          questionId: q.questionId,
          prompt: q.prompt,
          sessionId: meta.sessionId,
        })
      }
    }
    return {
      status: worker?.running ? 'running' : 'idle',
      ...(meta.model !== undefined ? { model: meta.model } : {}),
      ...(meta.title !== undefined ? { title: meta.title } : {}),
      pendingApprovals,
      pendingQuestions,
      todos: [],
      oldestSeq: 1,
      latestSeq: this.emitter.currentSeq(meta.sessionId) || null,
    }
  }

  async getSessionHistory(params: SessionHistoryParams): Promise<SessionHistoryResult> {
    const nativeId = this.resolveNativeId(params.sessionId)
    await this.assertSession(params.sessionId)
    const meta = this.sessions.get(nativeId)!
    const events = meta.filePath && existsSync(meta.filePath)
      ? parseClaudeTranscriptFile(meta.filePath)
      : []
    const page = paginateNormalizedTranscriptEvents(events, {
      beforeSeq: params.beforeSeq,
      limit: params.limit,
      minTurns: params.minTurns,
    })
    if (page.latestSeq !== null) {
      this.emitter.seedSeq(meta.sessionId, page.latestSeq)
    }
    return {
      sessionId: meta.sessionId,
      events: page.events,
      hasMore: page.hasMore,
      oldestSeq: page.oldestSeq,
      latestSeq: page.latestSeq,
      source: 'disk',
    }
  }

  async searchSessions(params: SessionSearchParams): Promise<SessionSearchResult> {
    this.scanDiskSessions()
    const sources: Array<{
      readonly sessionId: string
      readonly title?: string | undefined
      readonly updatedAt?: string | undefined
      readonly events: readonly NormalizedTranscriptEvent[]
    }> = []
    for (const meta of this.sessions.values()) {
      if (params.sessionId !== undefined && meta.sessionId !== params.sessionId) continue
      if (!meta.filePath || !existsSync(meta.filePath)) continue
      try {
        sources.push({
          sessionId: meta.sessionId,
          ...(meta.title !== undefined ? { title: meta.title } : {}),
          updatedAt: new Date(meta.updatedAtMs).toISOString(),
          events: parseClaudeTranscriptFile(meta.filePath),
        })
      } catch {}
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

  private sendControlResponse(
    worker: ClaudeLiveWorker,
    requestId: string,
    responsePayload: Record<string, unknown>,
  ): void {
    if (!worker.child.stdin || worker.child.stdin.destroyed) return
    const frame = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: responsePayload,
      },
    }
    worker.child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  private handleWorkerLine(
    worker: ClaudeLiveWorker,
    meta: DiscoveredClaudeSession,
    line: string,
  ): void {
    let obj: Record<string, unknown>
    try {
      const parsed = JSON.parse(line)
      if (!isRecord(parsed)) return
      obj = parsed
    } catch {
      return
    }

    if (obj.type === 'system' && isRecord(obj)) {
      if (typeof obj.model === 'string') {
        meta.model = { provider: 'anthropic', model: obj.model }
      }
      return
    }

    if (obj.type === 'stream_event' && isRecord(obj.event)) {
      const ev = obj.event
      if (ev.type === 'content_block_delta' && isRecord(ev.delta)) {
        if (ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
          this.emitter.emit(meta.sessionId, 'assistant/chunk', {
            text: ev.delta.text,
            chunk: { type: 'text-delta', text: ev.delta.text },
          })
        } else if (ev.delta.type === 'thinking_delta' && typeof ev.delta.thinking === 'string') {
          this.emitter.emit(meta.sessionId, 'assistant/chunk', {
            text: ev.delta.thinking,
            chunk: { type: 'reasoning-delta', text: ev.delta.thinking },
          })
        }
      }
      return
    }

    if (obj.type === 'assistant' && isRecord(obj.message)) {
      const content = obj.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block)) continue
          if (block.type === 'tool_use') {
            this.emitter.emit(meta.sessionId, 'tool/call', {
              callId: block.id,
              toolName: block.name ?? 'tool',
              args: block.input,
            })
          }
        }
      }
      const text = extractMessageText(content)
      if (text) {
        meta.preview = extractTextSnippet(text, 140)
        this.emitter.emit(meta.sessionId, 'assistant/message', {
          message: { role: 'assistant', content: text, usage: obj.message.usage },
        })
      }
      return
    }

    if (obj.type === 'user' && isRecord(obj.message)) {
      const content = obj.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block) || block.type !== 'tool_result') continue
          this.emitter.emit(meta.sessionId, 'tool/result', {
            callId: block.tool_use_id,
            result: block.content,
            isError: block.is_error === true,
          })
        }
      }
      return
    }

    if (obj.type === 'result') {
      worker.running = false
      meta.updatedAtMs = Date.now()
      this.emitter.emit(meta.sessionId, 'turn/end', {
        isError: obj.is_error === true,
        usage: obj.usage,
        totalCostUsd: obj.total_cost_usd,
      })
      return
    }

    if (obj.type === 'control_request' && isRecord(obj.request) && typeof obj.request_id === 'string') {
      const req = obj.request
      if (req.subtype === 'can_use_tool') {
        const toolName = typeof req.tool_name === 'string' ? req.tool_name : 'tool'
        const input = isRecord(req.input) ? req.input : {}
        if (toolName === 'AskUserQuestion') {
          const questionId = `claude-q-${randomUUID()}`
          const qs = Array.isArray(input.questions) ? input.questions : []
          const firstPrompt = isRecord(qs[0]) && typeof qs[0].question === 'string'
            ? qs[0].question
            : 'Claude Code requested input'
          this.pendingQuestions.set(questionId, {
            questionId,
            sessionId: meta.sessionId,
            prompt: firstPrompt,
            input,
            requestId: obj.request_id,
            worker,
          })
          this.emitter.emit(meta.sessionId, 'question.request', {
            questionId,
            prompt: firstPrompt,
            questions: qs,
          })
          return
        }

        const callId = `claude-apr-${randomUUID()}`
        const reason = typeof req.decision_reason === 'string' ? req.decision_reason : undefined
        this.pendingApprovals.set(callId, {
          callId,
          sessionId: meta.sessionId,
          toolName,
          reason,
          input,
          requestId: obj.request_id,
          worker,
        })
        this.emitter.emit(meta.sessionId, 'approval.request', {
          callId,
          toolName,
          ...(reason !== undefined ? { reason } : {}),
          args: input,
        })
      }
    }
  }
}
