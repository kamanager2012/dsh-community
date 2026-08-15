import { createWebSupervisor, type WebSupervisor } from './supervisor.js'
import type { HostChild } from './spawn-web.js'

const MAX_LOG_CHARS = 16_384

export type HostPhase = 'idle' | 'starting' | 'ready' | 'failed' | 'stopped'

export type HostSnapshot =
  | { readonly phase: 'idle'; readonly generation: 0 }
  | { readonly phase: 'starting'; readonly generation: number }
  | { readonly phase: 'ready'; readonly generation: number; readonly origin: string; readonly pid?: number }
  | { readonly phase: 'failed'; readonly generation: number; readonly error: string }
  | { readonly phase: 'stopped'; readonly generation: number }

export interface OfficialHostOptions {
  readonly spawn: () => HostChild
  readonly readinessTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  readonly onLog?: (chunk: string) => void
}

export interface OfficialHost {
  snapshot(): HostSnapshot
  logs(): string
  start(): Promise<string>
  restart(): Promise<string>
  shutdown(): Promise<void>
  onChange(listener: (snapshot: HostSnapshot) => void): () => void
}

/**
 * Restartable owner of official `dsh web` generations.
 * Snapshot is lifecycle only (phase, origin/port, pid). logs() is diagnostics.
 * Do not extend this with agent/tool/session business fields.
 */
export function createOfficialHost(options: OfficialHostOptions): OfficialHost {
  const listeners = new Set<(snapshot: HostSnapshot) => void>()
  let snapshot: HostSnapshot = { phase: 'idle', generation: 0 }
  let generation = 0
  let supervisor: WebSupervisor | undefined
  let lastPid: number | undefined
  let log = ''
  let startInFlight: Promise<string> | undefined
  let restartInFlight: Promise<string> | undefined
  let stopped = false

  const emit = (next: HostSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener(next)
  }

  const appendLog = (chunk: string): void => {
    log = `${log}${chunk}`.slice(-MAX_LOG_CHARS)
    options.onLog?.(chunk)
  }

  const spawnTracked = (): HostChild => {
    const child = options.spawn()
    lastPid = child.pid
    return child
  }

  const startGeneration = async (): Promise<string> => {
    if (stopped) throw new Error('official host is stopped')
    if (snapshot.phase === 'ready' && supervisor !== undefined) return snapshot.origin
    if (startInFlight !== undefined) return startInFlight

    generation += 1
    emit({ phase: 'starting', generation })
    const current = createWebSupervisor({
      spawnHost: spawnTracked,
      ...(options.readinessTimeoutMs === undefined
        ? {}
        : { readinessTimeoutMs: options.readinessTimeoutMs }),
      ...(options.shutdownTimeoutMs === undefined
        ? {}
        : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
      log: appendLog,
      onUnexpectedExit: ({ code, signal }) => {
        if (stopped) return
        emit({
          phase: 'failed',
          generation,
          error: `official dsh web exited unexpectedly (code ${String(code)}, signal ${String(signal)})`,
        })
      },
    })
    supervisor = current

    startInFlight = current.start().then(
      (origin) => {
        if (supervisor !== current) return origin
        startInFlight = undefined
        emit({
          phase: 'ready',
          generation,
          origin,
          ...(lastPid === undefined ? {} : { pid: lastPid }),
        })
        return origin
      },
      (error: unknown) => {
        if (supervisor !== current) throw error
        startInFlight = undefined
        const message = error instanceof Error ? error.message : String(error)
        emit({ phase: 'failed', generation, error: message })
        throw error
      },
    )
    return startInFlight
  }

  const shutdownCurrent = async (): Promise<void> => {
    const current = supervisor
    supervisor = undefined
    startInFlight = undefined
    if (current !== undefined) await current.shutdown()
  }

  return {
    snapshot: () => snapshot,
    logs: () => log,
    start: () => startGeneration(),
    async restart() {
      if (restartInFlight !== undefined) return restartInFlight
      restartInFlight = (async () => {
        stopped = false
        await shutdownCurrent()
        return startGeneration()
      })()
      try {
        return await restartInFlight
      } finally {
        restartInFlight = undefined
      }
    },
    async shutdown() {
      stopped = true
      await shutdownCurrent()
      emit({ phase: 'stopped', generation: snapshot.generation })
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
