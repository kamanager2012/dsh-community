import {
  createReadinessParser,
  DEFAULT_READINESS_TIMEOUT_MS,
} from './readiness.js'
import type { HostChild } from './spawn-web.js'

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const MAX_STARTUP_OUTPUT_CHARS = 32_768

export interface WebSupervisorOptions {
  readonly spawnHost: () => HostChild
  readonly readinessTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
  readonly log?: (line: string) => void
  readonly onUnexpectedExit?: (detail: { code: number | null; signal: NodeJS.Signals | null }) => void
}

export interface WebSupervisor {
  start(): Promise<string>
  shutdown(): Promise<void>
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

/** Single-owner supervisor for one official `dsh web` child. */
export function createWebSupervisor(options: WebSupervisorOptions): WebSupervisor {
  const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  let child: HostChild | undefined
  let startPromise: Promise<string> | undefined
  let shutdownPromise: Promise<void> | undefined
  let exited: Promise<void> | undefined
  let ready = false
  let shuttingDown = false
  let output = ''

  const appendOutput = (chunk: string): void => {
    output = `${output}${chunk}`.slice(-MAX_STARTUP_OUTPUT_CHARS)
    options.log?.(chunk)
  }

  const start = (): Promise<string> => {
    if (startPromise !== undefined) return startPromise
    if (shutdownPromise !== undefined) {
      return Promise.reject(new Error('official dsh web cannot start after shutdown'))
    }

    startPromise = new Promise<string>((resolve, reject) => {
      const parser = createReadinessParser()
      const spawned = options.spawnHost()
      child = spawned
      const exitResult = deferred<void>()
      exited = exitResult.promise
      let settled = false
      const startupCleanups: Array<() => void> = []

      const cleanupStartup = (): void => {
        clearTimeout(timer)
        for (const dispose of startupCleanups.splice(0)) dispose()
      }
      // Failure must not surface until the doomed child is confirmed dead,
      // or the next generation could start while this one is still alive.
      const failAfterChildExit = async (error: unknown): Promise<void> => {
        if (settled) return
        settled = true
        cleanupStartup()
        spawned.kill('SIGTERM')
        let timer: ReturnType<typeof setTimeout> | undefined
        const outcome = await Promise.race([
          exitResult.promise.then(() => 'closed' as const),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => {
              resolve('timeout')
            }, shutdownTimeoutMs)
          }),
        ])
        if (timer !== undefined) clearTimeout(timer)
        if (outcome === 'timeout') {
          spawned.kill('SIGKILL')
          await exitResult.promise
        }
        const diagnostic = output === '' ? '' : `\nHost output:\n${output}`
        reject(new Error(`${error instanceof Error ? error.message : String(error)}${diagnostic}`))
      }
      const acceptChunk = (chunk: string): void => {
        appendOutput(chunk)
        try {
          const url = parser.push(chunk)
          if (url === undefined || settled) return
          settled = true
          ready = true
          cleanupStartup()
          resolve(url)
        } catch (error) {
          void failAfterChildExit(error)
        }
      }

      const timer = setTimeout(() => {
        void failAfterChildExit(
          new Error(`official dsh web readiness timed out after ${String(readinessTimeoutMs)}ms`),
        )
      }, readinessTimeoutMs)

      startupCleanups.push(spawned.stdout.onData(acceptChunk))
      startupCleanups.push(spawned.stderr.onData(appendOutput))
      spawned.onError((error) => {
        exitResult.resolve()
        void failAfterChildExit(new Error(`official dsh web failed to spawn: ${error.message}`))
      })
      spawned.onExit((code, signal) => {
        exitResult.resolve()
        if (ready) {
          if (!shuttingDown) options.onUnexpectedExit?.({ code, signal })
          return
        }
        void failAfterChildExit(
          new Error(`official dsh web exited before readiness (code ${String(code)}, signal ${String(signal)})`),
        )
      })
    })
    return startPromise
  }

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise
    shutdownPromise = (async () => {
      const spawned = child
      if (spawned === undefined) return
      shuttingDown = true
      spawned.kill('SIGTERM')
      const closed = exited ?? Promise.resolve()
      let timer: ReturnType<typeof setTimeout> | undefined
      const outcome = await Promise.race([
        closed.then(() => 'closed' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => {
            resolve('timeout')
          }, shutdownTimeoutMs)
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
      if (outcome === 'timeout') {
        spawned.kill('SIGKILL')
        await closed
      }
    })()
    return shutdownPromise
  }

  return { start, shutdown }
}
