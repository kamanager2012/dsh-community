import { createRequire } from 'node:module'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { AndroidProcessInspector } from './android-process-inspector.mjs'
import { AndroidTerminalHandle } from './android-terminal-handle.mjs'

const requireFromHere = createRequire(import.meta.url)
const localProviderPackage = requireFromHere.resolve('@deepseek-ai/dsh-subprocess-local/package.json')
const requireFromLocalProvider = createRequire(localProviderPackage)
const nodePty = requireFromLocalProvider('node-pty')

const ROOT_IDENTITY_WAIT_MS = 1000
const ROOT_IDENTITY_POLL_MS = 10

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function childEnv(explicit) {
  const env = scrubbedParentEnv()
  for (const [key, value] of Object.entries(explicit ?? {})) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

async function waitForRootSession(inspector, pid, signal) {
  const deadline = Date.now() + ROOT_IDENTITY_WAIT_MS
  for (;;) {
    signal?.throwIfAborted()
    const root = inspector.rootIdentity(pid)
    if (root !== undefined) return root
    if (Date.now() >= deadline) {
      throw new Error(`android-subprocess: /proc identity did not appear for PTY pid ${pid}`)
    }
    await delay(Math.min(ROOT_IDENTITY_POLL_MS, Math.max(1, deadline - Date.now())))
  }
}

export class AndroidSubprocessRuntime extends LocalSubprocessRuntime {
  constructor(ctx) {
    super(ctx)
    this.androidTerminals = new Set()

    ctx.effect(() => {
      const onHostExit = () => {
        for (const terminal of this.androidTerminals) {
          try {
            terminal.terminateForHostExit()
          } catch {
            // One terminal must not prevent the remaining identity-fenced kills.
          }
        }
      }

      process.prependListener('exit', onHostExit)
      return async () => {
        process.off('exit', onHostExit)
        const outcomes = await Promise.allSettled(
          [...this.androidTerminals].map(terminal => terminal.terminate()),
        )
        this.androidTerminals.clear()
        const failures = outcomes.flatMap(result =>
          result.status === 'rejected' ? [result.reason] : [])
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) {
          throw new AggregateError(failures, 'android-subprocess: terminal teardown failed')
        }
      }
    }, 'android subprocess terminal teardown')
  }

  async spawnTerminal(spec) {
    const file = spec.argv[0]
    if (file === undefined || file.length === 0) {
      throw new Error('android-subprocess: terminal argv must contain a program')
    }
    spec.signal?.throwIfAborted()

    const terminal = nodePty.spawn(file, [...spec.argv.slice(1)], {
      name: 'dumb',
      rows: spec.rows,
      cols: spec.cols,
      cwd: spec.cwd,
      env: childEnv(spec.env),
    })

    const inspector = new AndroidProcessInspector()
    let root
    try {
      root = await waitForRootSession(inspector, terminal.pid, spec.signal)
      if (root.sessionId !== terminal.pid) {
        throw new Error(
          `android-subprocess: PTY pid ${terminal.pid} is not its POSIX session leader (sid=${root.sessionId})`,
        )
      }
    } catch (error) {
      try {
        terminal.kill('SIGKILL')
      } catch {
        // Allocation rollback is best-effort after the process identity failed.
      }
      throw error
    }

    const handle = new AndroidTerminalHandle(
      terminal,
      inspector,
      spec.graceMs,
      root.identity,
      root.sessionId,
    )
    this.androidTerminals.add(handle)

    const release = async () => {
      try {
        await handle.terminate()
      } finally {
        this.androidTerminals.delete(handle)
      }
    }
    void handle.done.then(release, release).catch(() => {})
    return handle
  }
}

export default AndroidSubprocessRuntime
