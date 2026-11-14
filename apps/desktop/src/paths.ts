import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { resolveOfficialDsh, type OfficialDshInstall } from '@dsh-community/dsh-bridge'

export const MINIMUM_DESKTOP_NODE_VERSION: readonly [number, number, number] = [22, 15, 0]

export function parseNodeSemver(raw: string): readonly [number, number, number] | undefined {
  const match = raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/u)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function isCompatibleNodeVersion(
  raw: string,
  minimum: readonly [number, number, number] = MINIMUM_DESKTOP_NODE_VERSION,
): boolean {
  const parsed = parseNodeSemver(raw)
  if (parsed === undefined) return false
  for (let i = 0; i < 3; i += 1) {
    if (parsed[i]! > minimum[i]!) return true
    if (parsed[i]! < minimum[i]!) return false
  }
  return true
}

export interface HostLaunchPaths {
  readonly nodeExecutable: string
  readonly cliEntry: string
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly electronRunAsNode: boolean
}

export interface ResolveHostLaunchInput {
  readonly isPackaged: boolean
  readonly from: string
  readonly env: NodeJS.ProcessEnv
  readonly execPath: string
  readonly resourcesPath: string
  readonly homedir: string
  readonly cwd: string
  readonly probeNodeVersion?: ((env: NodeJS.ProcessEnv) => string | undefined) | undefined
}

function devNodeExecutable(input: ResolveHostLaunchInput): string {
  const override = input.env.DSH_DESKTOP_NODE_EXECUTABLE
  if (override !== undefined && override !== '') return override
  const npmNode = input.env.npm_node_execpath
  if (npmNode !== undefined && npmNode !== '' && existsSync(npmNode)) return npmNode
  return 'node'
}

function defaultProbeNodeVersion(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const probe = spawnSync('node', ['--version'], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })
    return probe.status === 0 ? probe.stdout : undefined
  } catch {
    return undefined
  }
}

/**
 * Packaged builds prefer a compatible real Node (>= 22.15.0) over Electron-as-node.
 * The official web server does not reliably bind its socket when launched through
 * Electron-as-node, so a compatible system Node is the stable path; Electron-as-node
 * stays as the last resort for machines without Node or with an older distro Node.
 */
function packagedNodeExecutable(input: ResolveHostLaunchInput): string {
  const override = input.env.DSH_DESKTOP_NODE_EXECUTABLE
  if (override !== undefined && override !== '' && existsSync(override)) return override
  const versionOutput = (input.probeNodeVersion ?? defaultProbeNodeVersion)(input.env)
  if (versionOutput !== undefined && isCompatibleNodeVersion(versionOutput)) {
    return 'node'
  }
  return input.execPath
}

function stagedOfficialBin(resourcesPath: string): string {
  return join(resourcesPath, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function nodePathForCli(cliEntry: string, resourcesPath: string): string {
  const unpacked = join(resourcesPath, 'host', 'node_modules')
  if (existsSync(unpacked)) return unpacked
  return join(cliEntry, '..', '..', '..', '..')
}

export function resolveOfficialInstall(from: string): OfficialDshInstall {
  return resolveOfficialDsh({ from })
}

/**
 * Packaged builds run Electron as Node against the staged published CLI.
 * Development must spawn a real Node — `process.execPath` inside Electron is
 * the Electron binary, not Node.
 *
 * DSH_HOME is not rewritten here. Official `~/.dsh` stays the session store
 * unless the caller already isolated the env.
 */
export function resolveHostLaunchPaths(input: ResolveHostLaunchInput): HostLaunchPaths {
  if (!input.isPackaged) {
    const install = resolveOfficialDsh({ from: input.from, env: input.env })
    return {
      nodeExecutable: devNodeExecutable(input),
      cliEntry: install.binPath,
      cwd: input.env.DSH_DESKTOP_CWD ?? input.cwd,
      env: input.env,
      electronRunAsNode: false,
    }
  }

  const staged = stagedOfficialBin(input.resourcesPath)
  const cliEntry = existsSync(staged)
    ? staged
    : resolveOfficialDsh({ from: input.from, env: input.env }).binPath
  const nodeExecutable = packagedNodeExecutable(input)
  const nodePath = nodePathForCli(cliEntry, input.resourcesPath)
  const delimiter = process.platform === 'win32' ? ';' : ':'
  const nodePathValue = input.env.NODE_PATH === undefined || input.env.NODE_PATH === ''
    ? nodePath
    : `${nodePath}${delimiter}${input.env.NODE_PATH}`
  return {
    nodeExecutable,
    cliEntry,
    cwd: input.env.DSH_DESKTOP_CWD ?? input.homedir,
    env: {
      ...input.env,
      NODE_PATH: nodePathValue,
    },
    electronRunAsNode: nodeExecutable === input.execPath,
  }
}

export function assertHostLaunchPaths(paths: HostLaunchPaths): void {
  if (paths.nodeExecutable.includes('/') && !existsSync(paths.nodeExecutable)) {
    throw new Error(`desktop Node runtime is missing: ${paths.nodeExecutable}`)
  }
  if (!existsSync(paths.cliEntry)) {
    throw new Error(`official dsh bin is missing: ${paths.cliEntry}; pnpm install @deepseek-ai/dsh`)
  }
}

export { stagedOfficialBin }
