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

  emit(sessionId: string, type: string, data?: unknown): OfficialSessionEvent {
    const seq = (this.seqBySession.get(sessionId) ?? 0) + 1
    this.seqBySession.set(sessionId, seq)
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
