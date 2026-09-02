import * as nodePty from 'node-pty'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { createAndroidProcessInspector } from './android-process-inspector.mjs'
import { AndroidTerminalHandle } from './android-terminal-handle.mjs'

export const name = 'android-subprocess'

function terminalEnv(explicit) {
  const env = scrubbedParentEnv()
  for (const [key, value] of Object.entries(explicit ?? {})) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

export class AndroidSubprocessRuntime extends LocalSubprocessRuntime {
  constructor(ctx) {
    if (process.platform !== 'android') {
      throw new Error(`android-subprocess: expected process.platform=android, observed ${process.platform}`)
    }
    super(ctx)
    this.androidTerminals = new Set()

    ctx.effect(() => {
      const onHostExit = () => {
        for (const terminal of this.androidTerminals) {
          try {
            terminal.terminateForHostExit()
          } catch {
            // Continue force-stopping every owned terminal.
          }
        }
      }

      process.prependListener('exit', onHostExit)
      return async () => {
        try {
          const outcomes = await Promise.allSettled(
            [...this.androidTerminals].map(terminal => terminal.terminate()),
          )
          const failures = outcomes.flatMap(outcome =>
            outcome.status === 'rejected' ? [outcome.reason] : [],
          )
          this.androidTerminals.clear()
          if (failures.length === 1) throw failures[0]
          if (failures.length > 1) {
            throw new AggregateError(failures, 'android subprocess terminal teardown failed')
          }
        } finally {
          process.off('exit', onHostExit)
        }
      }
    }, 'android subprocess terminal teardown')
  }

  async spawnTerminal(spec) {
    const file = spec.argv[0]
    if (file === undefined || file.length === 0) {
      throw new Error('android-subprocess: terminal argv must contain a program')
    }

    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
    spec.signal?.throwIfAborted()

    const terminal = nodePty.spawn(file, [...spec.argv.slice(1)], {
      name: 'dumb',
      rows: spec.rows,
      cols: spec.cols,
      cwd: spec.cwd,
      env: terminalEnv(spec.env),
    })

    const handle = new AndroidTerminalHandle(
      terminal,
      createAndroidProcessInspector(),
      spec.graceMs,
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
