import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { accessSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import type {
  AgentEngineId,
  AgentHostBackend,
  EngineDescriptor,
  OfficialSessionEvent,
  SessionRef,
} from '../protocol.js'
import { isSafeSessionId } from '../session-transcript.js'

const execFileAsync = promisify(execFile)

/** Host-only env secrets that must never leak to spawned agent subprocesses. */
const SCRUBBED_SUBPROCESS_ENV_KEYS = [
  'DSH_REMOTE_CONTROL_TOKEN',
  'DSH_REMOTE_RELAY_HOST_SECRET',
  'DSH_REMOTE_RELAY_CLIENT_TOKEN',
  'DSH_REMOTE_SIGNALING_HOST_SECRET',
  'DSH_REMOTE_SIGNALING_JOIN_TOKEN',
] as const

export interface ManagedAgentBackend extends AgentHostBackend {
  readonly engineId: AgentEngineId
  readonly displayName: string
  probe(): Promise<EngineDescriptor>
  start?(): Promise<void>
  stop?(): Promise<void>
  onEvent?(listener: (sessionId: string, events: readonly OfficialSessionEvent[]) => void): () => void
  getSessionCwd?(sessionId: string): Promise<string | undefined>
}

export function sanitizeSubprocessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...baseEnv }
  for (const key of SCRUBBED_SUBPROCESS_ENV_KEYS) {
    delete sanitized[key]
  }
  return sanitized
}

const KNOWN_PREFIXES: ReadonlyArray<readonly [AgentEngineId, string]> = [
  ['claude', 'claude--'],
  ['codex', 'codex--'],
  ['opencode', 'opencode--'],
  ['acp', 'acp--'],
  ['dsh', 'dsh--'],
]

export function formatNamespacedSessionId(engine: AgentEngineId, nativeId: string): string {
  const safeNative = nativeId.trim()
  if (!isSafeSessionId(safeNative)) {
    throw new Error(`unsafe native session ID for engine '${engine}'`)
  }
  if (engine === 'dsh') return safeNative
  const prefix = `${engine}--`
  return safeNative.startsWith(prefix) ? safeNative : `${prefix}${safeNative}`
}

export function parseNamespacedSessionId(
  sessionId: string,
): { readonly engine?: AgentEngineId | undefined; readonly nativeId: string } {
  for (const [engine, prefix] of KNOWN_PREFIXES) {
    if (sessionId.startsWith(prefix)) {
      const nativeId = sessionId.slice(prefix.length)
      if (nativeId.length > 0) {
        return { engine, nativeId }
      }
    }
  }
  const customIdx = sessionId.indexOf('--')
  if (customIdx > 0) {
    const rawPrefix = sessionId.slice(0, customIdx)
    const nativeId = sessionId.slice(customIdx + 2)
    if (/^[a-z0-9_-]{1,32}$/u.test(rawPrefix) && nativeId.length > 0) {
      return { engine: rawPrefix as AgentEngineId, nativeId }
    }
  }
  return { nativeId: sessionId }
}

function isExecutableFile(candidate: string): boolean {
  try {
    const st = statSync(candidate)
    if (!st.isFile()) return false
    if (process.platform !== 'win32') {
      accessSync(candidate, fsConstants.X_OK)
    }
    return true
  } catch {
    return false
  }
}

export function findBinaryOnPath(
  binaryName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const trimmed = binaryName.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return isExecutableFile(trimmed) ? trimmed : undefined
  }
  const pathRaw = env.PATH ?? env.Path ?? ''
  if (!pathRaw) return undefined
  const pathextRaw =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
      : ''
  const extensions =
    process.platform === 'win32'
      ? pathextRaw.split(';').filter((ext) => ext.length > 0)
      : ['']

  for (const dir of pathRaw.split(delimiter)) {
    if (!dir) continue
    for (const ext of extensions) {
      const full = join(dir, `${trimmed}${ext}`)
      if (isExecutableFile(full)) {
        return full
      }
    }
  }
  return undefined
}

export async function probeBinaryVersion(
  binaryPath: string,
  args: readonly string[] = ['--version'],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, [...args], {
      env: sanitizeSubprocessEnv(env),
      timeout: 3000,
      maxBuffer: 16 * 1024,
      windowsHide: true,
    })
    const line = `${stdout}\n${stderr}`
      .split(/\r?\n/u)
      .map((s) => s.trim())
      .find((s) => s.length > 0)
    return line ? line.slice(0, 120) : undefined
  } catch {
    return undefined
  }
}

export class MonotonicSessionEventEmitter {
  private readonly seqBySession = new Map<string, number>()
  private readonly listeners = new Set<
    (sessionId: string, events: readonly OfficialSessionEvent[]) => void
  >()

  subscribe(
    listener: (sessionId: string, events: readonly OfficialSessionEvent[]) => void,
  ): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  currentSeq(sessionId: string): number {
    return this.seqBySession.get(sessionId) ?? 0
  }

  seedSeq(sessionId: string, seq: number): void {
    const prev = this.seqBySession.get(sessionId) ?? 0
    if (seq > prev) {
      this.seqBySession.set(sessionId, seq)
    }
  }

  /** Allocates the next monotonic positive integer sequence number without emitting. */
  nextSeq(sessionId: string): number {
    const seq = (this.seqBySession.get(sessionId) ?? 0) + 1
    this.seqBySession.set(sessionId, seq)
    return seq
  }

  emit(sessionId: string, type: string, data?: unknown): OfficialSessionEvent {
    const seq = this.nextSeq(sessionId)
    const event: OfficialSessionEvent =
      data !== undefined ? { seq, type, data } : { seq, type }
    for (const listener of this.listeners) {
      try {
        listener(sessionId, [event])
      } catch {
        // Isolate failing subscriber from interrupting live stream ingestion.
      }
    }
    return event
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function extractTextSnippet(text: string, maxChars = 120): string | undefined {
  const collapsed = text.trim().replace(/\s+/gu, ' ')
  if (!collapsed) return undefined
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed
}

export const MAX_SESSION_LIST_BYTES = 44 * 1024

function trimSessionRefFields(
  ref: SessionRef,
  level: 'strip-preview' | 'strip-verbose' | 'minimal',
): SessionRef {
  if (level === 'strip-preview') {
    const { preview: _p, ...rest } = ref
    return rest
  }
  if (level === 'minimal') {
    return {
      id: ref.id,
      ...(ref.engine !== undefined ? { engine: ref.engine } : {}),
      ...(ref.title !== undefined ? { title: ref.title } : {}),
      ...(ref.updatedAtMs !== undefined ? { updatedAtMs: ref.updatedAtMs } : {}),
      ...(ref.status !== undefined ? { status: ref.status } : {}),
      ...(ref.pendingApprovals !== undefined ? { pendingApprovals: ref.pendingApprovals } : {}),
      ...(ref.pendingQuestions !== undefined ? { pendingQuestions: ref.pendingQuestions } : {}),
    }
  }
  const { preview: _p, cwd: _c, workspace: _w, ...rest } = ref
  return rest
}

/**
 * Ensures serialized `session.list` payloads stay within carrier frame budgets while
 * keeping active sessions and compact workspace grouping metadata intact as long as possible.
 */
export function boundSessionListPayload(
  items: readonly SessionRef[],
  activeIds: ReadonlySet<string>,
  maxBytes = MAX_SESSION_LIST_BYTES,
): readonly SessionRef[] {
  if (items.length === 0 || Buffer.byteLength(JSON.stringify(items), 'utf8') <= maxBytes) {
    return Object.freeze([...items])
  }
  let current = items.map((item) =>
    activeIds.has(item.id) ? item : trimSessionRefFields(item, 'strip-preview'),
  )
  if (Buffer.byteLength(JSON.stringify(current), 'utf8') <= maxBytes) {
    return Object.freeze(current)
  }
  current = items.map((item) =>
    activeIds.has(item.id)
      ? trimSessionRefFields(item, 'strip-preview')
      : trimSessionRefFields(item, 'strip-verbose'),
  )
  if (Buffer.byteLength(JSON.stringify(current), 'utf8') <= maxBytes) {
    return Object.freeze(current)
  }
  current = current.map((item) =>
    activeIds.has(item.id)
      ? trimSessionRefFields(item, 'strip-verbose')
      : trimSessionRefFields(item, 'minimal'),
  )
  if (Buffer.byteLength(JSON.stringify(current), 'utf8') <= maxBytes) {
    return Object.freeze(current)
  }
  const minimal = current.map((item) => trimSessionRefFields(item, 'minimal'))
  const itemByteLengths = minimal.map((item) => Buffer.byteLength(JSON.stringify(item), 'utf8'))
  let totalBytes = 2 + itemByteLengths.reduce((sum, n) => sum + n, 0) + Math.max(0, minimal.length - 1)
  if (totalBytes <= maxBytes) {
    return Object.freeze(minimal)
  }

  const dropped = new Array<boolean>(minimal.length).fill(false)
  let kept = minimal.length

  // Shed rightmost inactive sessions first so active (running / awaiting approval/question) entries survive truncation.
  for (let i = minimal.length - 1; i >= 0 && kept > 1 && totalBytes > maxBytes; i -= 1) {
    const item = minimal[i]!
    if (activeIds.has(item.id)) continue
    dropped[i] = true
    kept -= 1
    totalBytes -= itemByteLengths[i]! + 1
  }

  for (let i = minimal.length - 1; i >= 0 && kept > 1 && totalBytes > maxBytes; i -= 1) {
    if (dropped[i]) continue
    dropped[i] = true
    kept -= 1
    totalBytes -= itemByteLengths[i]! + 1
  }

  return Object.freeze(minimal.filter((_, i) => !dropped[i]))
}
