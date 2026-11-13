/**
 * Shared helpers for spawning and controlling the official `@deepseek-ai/dsh`
 * headless Remote Host subprocess across TUI CLI and Desktop UI surfaces.
 */

import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { join } from 'node:path'

export interface LiveControlEndpoint {
  readonly pid: number
  readonly controlUrl: string
  readonly controlToken: string
}

/** Composes the official headless Cordis patch YAML enabling `dsh-community-remote`. */
export function composeRemoteHostPatchYaml(options: {
  readonly pluginUrl: string
  readonly workspaceRoot: string
}): string {
  return [
    '- id: hmr',
    '  disabled: true',
    '- id: headless-startup',
    '  disabled: true',
    '- id: headless-runner',
    '  disabled: true',
    '- id: sandbox-policy',
    '  inject: []',
    '  config:',
    '    mode: workspace-write',
    `    workspaceRoot: ${JSON.stringify(options.workspaceRoot)}`,
    '    additionalWritableRoots: []',
    '- id: approval',
    '  config:',
    '    policy: ask',
    '- insert:',
    '    - id: dsh-community-remote',
    `      name: ${JSON.stringify(options.pluginUrl)}`,
    '',
  ].join('\n')
}

export function isPrivateOrTailscaleIpv4(address: string): boolean {
  const parts = address.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

export function detectLanIpv4Candidates(
  ifaces: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces(),
): string[] {
  const result = new Set<string>()
  for (const entries of Object.values(ifaces)) {
    for (const info of entries ?? []) {
      if (info.family === 'IPv4' && !info.internal && isPrivateOrTailscaleIpv4(info.address)) {
        result.add(info.address)
      }
    }
  }
  return [...result].sort()
}

export function buildLoopbackPairingWarning(
  ready: Record<string, unknown>,
  lanCandidates: readonly string[] = detectLanIpv4Candidates(),
): string | undefined {
  const endpointUrl = String(ready.endpointUrl ?? ready.lanUrl ?? '')
  const hasRemoteFallback = Boolean(ready.relayUrl) || Boolean(ready.signalingUrl)
  const isLoopback = /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/iu.test(endpointUrl)
  if (!isLoopback || hasRemoteFallback) return undefined
  const lanHint =
    lanCandidates.length > 0 ? `（检测到可用局域网 IP: ${lanCandidates.join(', ')}）` : ''
  return `  提示: 当前仅监听 loopback${lanHint}；真机局域网配对请改用 --host <局域网IP> --mdns，或配置 --relay-url / --signaling-url。`
}

export function liveControlFilePath(configDir: string): string {
  return join(configDir, '.control.json')
}

export function writeLiveControlEndpoint(configDir: string, endpoint: LiveControlEndpoint): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(configDir, 0o700)
  const target = liveControlFilePath(configDir)
  const tmp = join(configDir, `.control.${randomBytes(6).toString('hex')}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(tmp, 0o600)
  renameSync(tmp, target)
}

export function removeOwnLiveControlEndpoint(configDir: string, ownerPid: number = process.pid): void {
  const target = liveControlFilePath(configDir)
  try {
    if (!existsSync(target)) return
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as Partial<LiveControlEndpoint>
    if (parsed.pid === ownerPid) {
      rmSync(target, { force: true })
    }
  } catch {}
}

export function readLiveControlEndpoint(configDir: string): LiveControlEndpoint | undefined {
  const target = liveControlFilePath(configDir)
  try {
    if (!existsSync(target)) return undefined
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as Partial<LiveControlEndpoint>
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      typeof parsed.controlUrl !== 'string' ||
      typeof parsed.controlToken !== 'string' ||
      !/^http:\/\/127\.0\.0\.1:\d+$/u.test(parsed.controlUrl)
    ) {
      return undefined
    }
    try {
      process.kill(parsed.pid, 0)
    } catch {
      return undefined
    }
    return {
      pid: parsed.pid,
      controlUrl: parsed.controlUrl,
      controlToken: parsed.controlToken,
    }
  } catch {
    return undefined
  }
}

export async function waitForReadyFile(
  filePath: string,
  child: ChildProcess,
  timeoutMs = 25_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let earlyFailure: Error | undefined
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    earlyFailure = new Error(
      `官方 DSH 远程宿主在就绪前退出 (code=${String(code)}, signal=${String(signal)})`,
    )
  }
  const onError = (err: Error): void => {
    earlyFailure = err
  }
  child.once('exit', onExit)
  child.once('error', onError)
  try {
    while (Date.now() < deadline) {
      if (earlyFailure) throw earlyFailure
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf8').trim()
        if (raw.length > 0) {
          try {
            return JSON.parse(raw) as Record<string, unknown>
          } catch {}
        }
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    if (earlyFailure) throw earlyFailure
    throw new Error('等待官方 DSH 远程宿主就绪超时')
  } finally {
    child.off('exit', onExit)
    child.off('error', onError)
  }
}
