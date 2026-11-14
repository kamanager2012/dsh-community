import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { sanitizeSubprocessEnv, isRecord } from './types.js'

export interface NdjsonRpcClientOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly defaultRequestTimeoutMs?: number | undefined
  readonly includeJsonRpcHeader?: boolean | undefined
  readonly spawnFn?: typeof spawn | undefined
  readonly onNotification?: ((method: string, params: unknown) => void) | undefined
  readonly onServerRequest?: ((method: string, params: unknown, id: string | number) => Promise<unknown>) | undefined
  readonly onStderrLine?: ((line: string) => void) | undefined
  readonly onExit?: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
}

interface PendingRpcCall {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: Error) => void
  readonly timer: NodeJS.Timeout
}

/**
 * Bidirectional NDJSON JSON-RPC client over subprocess stdio.
 * Tolerates servers that omit `"jsonrpc": "2.0"` on replies/notifications (e.g. Codex app-server).
 */
export class NdjsonRpcProcess {
  private readonly child: ChildProcess
  private readonly pending = new Map<string | number, PendingRpcCall>()
  private nextRequestId = 1
  private closed = false
  private readonly includeJsonRpcHeader: boolean
  private readonly defaultRequestTimeoutMs: number

  constructor(private readonly options: NdjsonRpcClientOptions) {
    this.includeJsonRpcHeader = options.includeJsonRpcHeader ?? true
    this.defaultRequestTimeoutMs = options.defaultRequestTimeoutMs ?? 30_000
    const spawnImpl = options.spawnFn ?? spawn
    this.child = spawnImpl(options.command, [...options.args], {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: sanitizeSubprocessEnv(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const stdoutDecoder = new StringDecoder('utf8')
    let stdoutBuf = ''
    this.child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutBuf += typeof chunk === 'string' ? chunk : stdoutDecoder.write(chunk)
      for (;;) {
        const nl = stdoutBuf.indexOf('\n')
        if (nl === -1) break
        const line = stdoutBuf.slice(0, nl).replace(/\r$/u, '')
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (line.trim().length > 0) this.handleLine(line)
      }
    })
    this.child.stdout?.on('close', () => {
      stdoutBuf += stdoutDecoder.end()
      const tail = stdoutBuf.replace(/\r$/u, '').trim()
      stdoutBuf = ''
      if (tail.length > 0) this.handleLine(tail)
    })

    if (options.onStderrLine) {
      const stderrDecoder = new StringDecoder('utf8')
      let stderrBuf = ''
      this.child.stderr?.on('data', (chunk: Buffer | string) => {
        stderrBuf += typeof chunk === 'string' ? chunk : stderrDecoder.write(chunk)
        for (;;) {
          const nl = stderrBuf.indexOf('\n')
          if (nl === -1) break
          const line = stderrBuf.slice(0, nl).replace(/\r$/u, '')
          stderrBuf = stderrBuf.slice(nl + 1)
          if (line.length > 0) options.onStderrLine?.(line)
        }
      })
      this.child.stderr?.on('close', () => {
        stderrBuf += stderrDecoder.end()
        const tail = stderrBuf.replace(/\r$/u, '')
        stderrBuf = ''
        if (tail.length > 0) options.onStderrLine?.(tail)
      })
    } else {
      this.child.stderr?.resume()
    }

    this.child.once('error', (err) => {
      this.rejectAll(err instanceof Error ? err : new Error(String(err)))
    })

    this.child.once('exit', (code, signal) => {
      this.closed = true
      this.rejectAll(
        new Error(
          `${options.command} exited (code=${String(code)}, signal=${String(signal)})`,
        ),
      )
      options.onExit?.(code, signal)
    })
  }

  isAlive(): boolean {
    return !this.closed && this.child.exitCode === null && !this.child.killed
  }

  async request<TResult = unknown>(
    method: string,
    params?: unknown,
    timeoutMs: number = this.defaultRequestTimeoutMs,
  ): Promise<TResult> {
    if (!this.isAlive() || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error(`${this.options.command} process is not running`)
    }
    const id = this.nextRequestId
    this.nextRequestId += 1

    const payload: Record<string, unknown> = {
      ...(this.includeJsonRpcHeader ? { jsonrpc: '2.0' } : {}),
      id,
      method,
      params: params ?? {},
    }

    return await new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`RPC timeout after ${String(timeoutMs)}ms for ${method}`))
      }, timeoutMs)
      timer.unref()

      this.pending.set(id, {
        method,
        resolve: (v) => resolve(v as TResult),
        reject,
        timer,
      })

      try {
        this.writeFrame(payload)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    if (!this.isAlive() || !this.child.stdin || this.child.stdin.destroyed) return
    const payload: Record<string, unknown> = {
      ...(this.includeJsonRpcHeader ? { jsonrpc: '2.0' } : {}),
      method,
      params: params ?? {},
    }
    this.writeFrame(payload)
  }

  sendRaw(payload: unknown): void {
    if (!this.isAlive() || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error(`${this.options.command} process stdin is not writable`)
    }
    this.writeFrame(payload)
  }

  async stop(graceMs = 2000): Promise<void> {
    if (this.closed || this.child.exitCode !== null) {
      this.closed = true
      this.rejectAll(new Error(`${this.options.command} stopped`))
      return
    }
    this.closed = true
    this.rejectAll(new Error(`${this.options.command} stopping`))

    const exited = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null) {
        resolve()
        return
      }
      const killTimer = setTimeout(() => {
        if (this.child.exitCode === null) {
          this.child.kill('SIGKILL')
        }
        resolve()
      }, graceMs)
      killTimer.unref()
      this.child.once('exit', () => {
        clearTimeout(killTimer)
        resolve()
      })
    })

    try {
      this.child.stdin?.end()
    } catch {}
    if (this.child.exitCode === null) {
      this.child.kill('SIGTERM')
    }
    await exited
  }

  private writeFrame(payload: unknown): void {
    const stdin = this.child.stdin
    if (!stdin || stdin.destroyed) {
      throw new Error(`${this.options.command} stdin is closed`)
    }
    stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    if (!isRecord(parsed)) return

    const hasId =
      Object.prototype.hasOwnProperty.call(parsed, 'id')
      && (typeof parsed.id === 'number' || typeof parsed.id === 'string')
    const hasMethod = typeof parsed.method === 'string' && parsed.method.length > 0

    if (hasId && !hasMethod) {
      const pending = this.pending.get(parsed.id as string | number)
      if (!pending) return
      this.pending.delete(parsed.id as string | number)
      clearTimeout(pending.timer)
      if (parsed.error !== undefined) {
        const errRec = isRecord(parsed.error) ? parsed.error : undefined
        const msg =
          typeof errRec?.message === 'string'
            ? errRec.message
            : JSON.stringify(parsed.error)
        pending.reject(new Error(`${pending.method} failed: ${msg}`))
      } else {
        pending.resolve(parsed.result)
      }
      return
    }

    if (hasId && hasMethod) {
      const reqId = parsed.id as string | number
      const method = parsed.method as string
      if (!this.options.onServerRequest) {
        this.safeReplyError(reqId, -32601, `Method '${method}' is not handled`)
        return
      }
      void this.options
        .onServerRequest(method, parsed.params, reqId)
        .then((result) => {
          if (!this.isAlive()) return
          this.writeFrame({
            ...(this.includeJsonRpcHeader ? { jsonrpc: '2.0' } : {}),
            id: reqId,
            result: result ?? null,
          })
        })
        .catch((err) => {
          this.safeReplyError(
            reqId,
            -32000,
            err instanceof Error ? err.message : String(err),
          )
        })
      return
    }

    if (hasMethod) {
      this.options.onNotification?.(parsed.method as string, parsed.params)
    }
  }

  private safeReplyError(id: string | number, code: number, message: string): void {
    if (!this.isAlive()) return
    try {
      this.writeFrame({
        ...(this.includeJsonRpcHeader ? { jsonrpc: '2.0' } : {}),
        id,
        error: { code, message },
      })
    } catch {}
  }

  private rejectAll(err: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reject(err)
    }
  }
}
