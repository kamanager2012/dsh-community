import { spawn, type ChildProcess } from 'node:child_process'
import type { OfficialWebBind } from '@dsh-community/shared-types'

export interface HostChild {
  readonly pid?: number
  readonly stdout: { onData(listener: (chunk: string) => void): () => void }
  readonly stderr: { onData(listener: (chunk: string) => void): () => void }
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void
  onError(listener: (error: Error) => void): () => void
  kill(signal: 'SIGTERM' | 'SIGKILL'): void
}

export interface SpawnOfficialWebOptions {
  readonly nodeExecutable: string
  readonly cliEntry: string
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly bind?: OfficialWebBind
  /** When the Node executable is Electron itself. */
  readonly electronRunAsNode?: boolean
  /**
   * Node flags prepended to the official CLI entry.
   *
   * Electron-as-node does not expose the internals that upstream
   * `cordis-plugin-hmr` probes; without `--expose-internals` the plugin tree
   * aborts while the same closure boots fine under plain node. Callers pass
   * this on the Electron-as-node fallback path.
   */
  readonly execArgv?: readonly string[]
}

function streamAdapter(stream: NodeJS.ReadableStream): HostChild['stdout'] {
  return {
    onData(listener) {
      const accept = (chunk: string | Buffer): void => {
        listener(chunk.toString())
      }
      stream.on('data', accept)
      return () => {
        stream.off('data', accept)
      }
    },
  }
}

export function adaptNodeChild(child: ChildProcess): HostChild {
  if (child.stdout === null || child.stderr === null) {
    throw new Error('official dsh web must be spawned with piped stdout and stderr')
  }
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    stdout: streamAdapter(child.stdout),
    stderr: streamAdapter(child.stderr),
    onExit(listener) {
      child.on('exit', listener)
      return () => {
        child.off('exit', listener)
      }
    },
    onError(listener) {
      child.on('error', listener)
      return () => {
        child.off('error', listener)
      }
    },
    kill(signal) {
      child.kill(signal)
    },
  }
}

/**
 * Spawn published `dsh web`. Bind stays loopback. Port `0` is the official
 * "OS picks a free port" flag — Desktop uses that so it does not fight a
 * browser already on 3080.
 */
/** Launcher argv the contract tests lock. */
export function officialWebArgv(bind: OfficialWebBind = { host: '127.0.0.1', port: 0 }): readonly string[] {
  return ['web', '--host', bind.host, '--port', String(bind.port)]
}

/** Full child argv: optional Node flags, then the official CLI entry. */
export function officialHostArgs(input: {
  readonly cliEntry: string
  readonly bind?: OfficialWebBind
  readonly execArgv?: readonly string[]
}): readonly string[] {
  const host = input.bind?.host ?? '127.0.0.1'
  const port = input.bind?.port ?? 0
  return [
    ...(input.execArgv ?? []),
    input.cliEntry,
    'web',
    '--host',
    host,
    '--port',
    String(port),
  ]
}

export function spawnOfficialWeb(options: SpawnOfficialWebOptions): HostChild {
  const env = options.electronRunAsNode
    ? { ...options.env, ELECTRON_RUN_AS_NODE: '1' }
    : { ...options.env }
  const child = spawn(
    options.nodeExecutable,
    [...officialHostArgs({
      cliEntry: options.cliEntry,
      ...(options.bind === undefined ? {} : { bind: options.bind }),
      ...(options.execArgv === undefined ? {} : { execArgv: options.execArgv }),
    })],
    {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  return adaptNodeChild(child)
}
