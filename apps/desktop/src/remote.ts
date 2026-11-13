/**
 * Desktop Remote Host lifecycle controller, QR pairing state, and trusted-device
 * store facade around `@dsh-community/dsh-bridge` and `@dsh-community/remote-adapter/stores`.
 * Does not implement an agent loop or protocol fork.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'
import {
  buildLoopbackPairingWarning,
  composeRemoteHostPatchYaml,
  detectLanIpv4Candidates,
  officialApiKeyPresent,
  readLiveControlEndpoint,
  removeOwnLiveControlEndpoint,
  renderQrSvg,
  waitForReadyFile,
  writeLiveControlEndpoint,
} from '@dsh-community/dsh-bridge'
import {
  assertOutsideOfficialDshHome,
  defaultRemoteConfigDir,
  openPersistentRemoteStores,
} from '@dsh-community/remote-adapter/stores'
import { readJsonFile, writeJsonFile } from './json-file.ts'
import { assertHostLaunchPaths, type HostLaunchPaths } from './paths.ts'

export type DesktopRemotePhase = 'stopped' | 'starting' | 'running' | 'external' | 'error'

export interface DesktopRemoteSettings {
  readonly listenHost: string
  readonly port: number
  readonly enableMdns: boolean
  readonly relayUrl: string
  readonly signalingUrl: string
  readonly stunUrls: string
}

export interface DesktopRemoteDeviceView {
  readonly deviceId: string
  readonly displayName: string
  readonly capabilities: readonly string[]
  readonly pairedAt: number
  readonly lastSeenAt: number
  readonly revokedAt?: number | undefined
}

export interface DesktopPendingCandidateView {
  readonly candidateId: string
  readonly deviceId: string
  readonly displayName: string
  readonly maxAllowedCapabilities: readonly string[]
  readonly expiresAt: number
  readonly state: string
}

export interface DesktopRemotePairingView {
  readonly deepLink: string
  readonly pairingJson: string
  readonly expiresAt?: number | undefined
  readonly qrSvg: string
  readonly loopbackWarning?: string | undefined
}

export interface DesktopRemoteSnapshot {
  readonly phase: DesktopRemotePhase
  readonly pid: string
  readonly configDir: string
  readonly dshHome: string
  readonly isolated: boolean
  readonly apiKeyPresent: boolean
  readonly hostFingerprint: string
  readonly lanCandidates: readonly string[]
  readonly effectiveListenHost: string
  readonly settings: DesktopRemoteSettings
  readonly lanUrl: string
  readonly relayUrl: string
  readonly relayRoomId: string
  readonly signalingUrl: string
  readonly signalingRoomId: string
  readonly stunUrls: readonly string[]
  readonly activeConnections: number
  readonly pairing?: DesktopRemotePairingView | undefined
  readonly pendingCandidates: readonly DesktopPendingCandidateView[]
  readonly devices: readonly DesktopRemoteDeviceView[]
  readonly logs: string
  readonly notice?: string | undefined
  readonly error?: string | undefined
}

export interface DesktopRemoteContext {
  readonly env: NodeJS.ProcessEnv
  readonly home: string
  readonly desktopRoot: string
  readonly dshHome: string
  readonly isolated: boolean
  readonly isPackaged: boolean
  readonly mainDir: string
  readonly resourcesPath: string
  readonly workspaceRoot: string
  readonly launchPaths: () => HostLaunchPaths
}

export const DEFAULT_DESKTOP_REMOTE_SETTINGS: DesktopRemoteSettings = Object.freeze({
  listenHost: '',
  port: 0,
  enableMdns: true,
  relayUrl: '',
  signalingUrl: '',
  stunUrls: '',
})

const MAX_REMOTE_LOG_CHARS = 32_768
const MAX_LISTEN_HOST_CHARS = 128
const MAX_URL_CHARS = 512
const STUN_URL_RE = /^stun:[^\s,]+(?::\d+)?$/iu
const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*[a-zA-Z]/gu
const CANDIDATE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/u

function clampLogTail(current: string, addition: string): string {
  const clean = addition.replace(ANSI_ESCAPE_RE, '')
  if (clean === '') return current
  const combined = `${current}${clean}`
  if (combined.length <= MAX_REMOTE_LOG_CHARS) return combined
  return `... (earlier logs trimmed)\n${combined.slice(combined.length - MAX_REMOTE_LOG_CHARS)}`
}

export function resolveDesktopRemoteConfigDir(options: {
  readonly env: NodeJS.ProcessEnv
  readonly home: string
  readonly desktopRoot: string
  readonly dshHome: string
  readonly isolated: boolean
}): string {
  const raw = options.isolated
    ? join(options.desktopRoot, 'remote-isolated')
    : defaultRemoteConfigDir(options.env, options.home)
  return assertOutsideOfficialDshHome(raw, options.dshHome)
}

export function resolveDesktopRemotePluginPath(options: {
  readonly isPackaged: boolean
  readonly mainDir: string
  readonly resourcesPath: string
  readonly workspaceRoot: string
  readonly desktopRoot: string
}): string {
  const packagedPlugin = join(options.resourcesPath, 'remote', 'cordis-plugin.mjs')
  if (options.isPackaged && existsSync(packagedPlugin)) {
    return packagedPlugin
  }
  const devBundledPlugin = join(options.mainDir, '..', 'remote-bundle', 'cordis-plugin.mjs')
  if (!options.isPackaged && existsSync(devBundledPlugin)) {
    return devBundledPlugin
  }
  const workspacePlugin = join(
    options.workspaceRoot,
    'packages',
    'remote-adapter',
    'dist',
    'cordis-plugin.js',
  )
  if (!options.isPackaged && existsSync(workspacePlugin)) {
    return workspacePlugin
  }
  throw new Error(`未找到 Remote Host 插件入口（${packagedPlugin} / ${devBundledPlugin}）`)
}

export function parseDesktopRemoteSettings(raw: unknown): DesktopRemoteSettings {
  if (raw === null || typeof raw !== 'object') return DEFAULT_DESKTOP_REMOTE_SETTINGS
  const rec = raw as Record<string, unknown>
  const listenHost =
    typeof rec.listenHost === 'string' &&
    rec.listenHost.length <= MAX_LISTEN_HOST_CHARS &&
    !/[\s\u0000-\u001f]/u.test(rec.listenHost)
      ? rec.listenHost.trim()
      : DEFAULT_DESKTOP_REMOTE_SETTINGS.listenHost
  const port =
    typeof rec.port === 'number' && Number.isInteger(rec.port) && rec.port >= 0 && rec.port <= 65535
      ? rec.port
      : DEFAULT_DESKTOP_REMOTE_SETTINGS.port
  const enableMdns =
    typeof rec.enableMdns === 'boolean' ? rec.enableMdns : DEFAULT_DESKTOP_REMOTE_SETTINGS.enableMdns
  const relayUrl =
    typeof rec.relayUrl === 'string' && rec.relayUrl.length <= MAX_URL_CHARS
      ? rec.relayUrl.trim()
      : ''
  const signalingUrl =
    typeof rec.signalingUrl === 'string' && rec.signalingUrl.length <= MAX_URL_CHARS
      ? rec.signalingUrl.trim()
      : ''
  const stunUrls =
    typeof rec.stunUrls === 'string' && rec.stunUrls.length <= MAX_URL_CHARS
      ? rec.stunUrls.trim()
      : ''
  return { listenHost, port, enableMdns, relayUrl, signalingUrl, stunUrls }
}

function validateWsUrl(raw: string, fieldLabel: string): string | undefined {
  if (raw === '') return undefined
  if (raw.length > MAX_URL_CHARS || /[\s\u0000-\u001f]/u.test(raw)) {
    return `${fieldLabel} 格式无效或包含空白字符`
  }
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      return `${fieldLabel} 必须使用 ws:// 或 wss:// 协议`
    }
    return undefined
  } catch {
    return `${fieldLabel} 不是有效的 URL`
  }
}

export function validateRemoteStartInput(
  raw: unknown,
): { readonly ok: true; readonly settings: DesktopRemoteSettings } | { readonly ok: false; readonly error: string } {
  if (raw === null || typeof raw !== 'object') {
    return { ok: true, settings: DEFAULT_DESKTOP_REMOTE_SETTINGS }
  }
  const rec = raw as Record<string, unknown>
  const listenHost = typeof rec.listenHost === 'string' ? rec.listenHost.trim() : ''
  if (listenHost.length > MAX_LISTEN_HOST_CHARS || /[\s\u0000-\u001f]/u.test(listenHost)) {
    return { ok: false, error: '监听地址包含非法空白或控制字符' }
  }

  let port = 0
  if (typeof rec.port === 'number') {
    port = rec.port
  } else if (typeof rec.port === 'string' && rec.port.trim() !== '') {
    port = Number(rec.port.trim())
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { ok: false, error: '端口必须是 0–65535 的整数（0 表示自动分配）' }
  }

  const enableMdns = rec.enableMdns !== false
  const relayUrl = typeof rec.relayUrl === 'string' ? rec.relayUrl.trim() : ''
  const relayErr = validateWsUrl(relayUrl, '盲中继地址 (Relay URL)')
  if (relayErr !== undefined) return { ok: false, error: relayErr }

  const signalingUrl = typeof rec.signalingUrl === 'string' ? rec.signalingUrl.trim() : ''
  const signalingErr = validateWsUrl(signalingUrl, 'WebRTC 信令地址 (Signaling URL)')
  if (signalingErr !== undefined) return { ok: false, error: signalingErr }

  const stunUrls = typeof rec.stunUrls === 'string' ? rec.stunUrls.trim() : ''
  if (stunUrls !== '') {
    if (stunUrls.length > MAX_URL_CHARS) {
      return { ok: false, error: 'STUN URL 列表过长' }
    }
    const items = stunUrls
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    for (const item of items) {
      if (!STUN_URL_RE.test(item)) {
        return { ok: false, error: `STUN 地址格式无效: ${item}（应形如 stun:host:port）` }
      }
    }
  }

  return {
    ok: true,
    settings: { listenHost, port, enableMdns, relayUrl, signalingUrl, stunUrls },
  }
}

export function parseConfirmPairingInput(
  raw: unknown,
): { readonly candidateId: string; readonly allowApprove: boolean } | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const rec = raw as Record<string, unknown>
  if (typeof rec.candidateId !== 'string' || !CANDIDATE_ID_RE.test(rec.candidateId)) {
    return undefined
  }
  return {
    candidateId: rec.candidateId,
    allowApprove: rec.allowApprove !== false,
  }
}

export function parseRevokeDeviceInput(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > 128 || /[\s\u0000-\u001f]/u.test(trimmed)) {
    return undefined
  }
  return trimmed
}

export function resolveEffectiveListenHost(
  configured: string,
  candidates: readonly string[],
): string {
  const trimmed = configured.trim()
  if (trimmed !== '') return trimmed
  return candidates[0] ?? '127.0.0.1'
}

function buildPairingView(
  ready: Record<string, unknown>,
  lanCandidates: readonly string[],
): DesktopRemotePairingView | undefined {
  const deepLink = typeof ready.deepLink === 'string' ? ready.deepLink : ''
  const pairingJson = typeof ready.pairingJson === 'string' ? ready.pairingJson : ''
  if (deepLink === '') return undefined
  let qrSvg = ''
  try {
    qrSvg = renderQrSvg(deepLink, { eccLevel: 'L', quietZone: 3 })
  } catch {
    qrSvg = ''
  }
  const expiresAt = typeof ready.expiresAt === 'number' ? ready.expiresAt : undefined
  const loopbackWarning = buildLoopbackPairingWarning(ready, lanCandidates)
  return {
    deepLink,
    pairingJson,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    qrSvg,
    ...(loopbackWarning !== undefined ? { loopbackWarning: loopbackWarning.trim() } : {}),
  }
}

interface OwnedRemoteProcess {
  readonly child: ChildProcess
  readonly tmpDir: string
  readonly configDir: string
  readonly controlUrl: string
  readonly controlToken: string
  readonly ready: Record<string, unknown>
}

export class DesktopRemoteController {
  private readonly getContext: () => DesktopRemoteContext
  private readonly spawnFn: typeof spawn
  private readonly fetchFn: typeof fetch
  private readonly onChange: (() => void) | undefined

  private phase: DesktopRemotePhase = 'stopped'
  private owned: OwnedRemoteProcess | undefined
  private startingChild: ChildProcess | undefined
  private startingTmpDir: string | undefined
  private startAborted = false
  private externalControl: { readonly pid: number; readonly controlUrl: string; readonly controlToken: string } | undefined
  private cachedReady: Record<string, unknown> = {}
  private cachedPending: DesktopPendingCandidateView[] = []
  private cachedDevices: DesktopRemoteDeviceView[] = []
  private logs = ''
  private notice: string | undefined
  private lastError: string | undefined
  private settingsCache: DesktopRemoteSettings | undefined

  constructor(options: {
    readonly getContext: () => DesktopRemoteContext
    readonly spawnFn?: typeof spawn | undefined
    readonly fetchFn?: typeof fetch | undefined
    readonly onChange?: (() => void) | undefined
  }) {
    this.getContext = options.getContext
    this.spawnFn = options.spawnFn ?? spawn
    this.fetchFn = options.fetchFn ?? fetch
    this.onChange = options.onChange
  }

  private emitChange(): void {
    this.onChange?.()
  }

  private settingsPath(ctx: DesktopRemoteContext): string {
    return join(ctx.desktopRoot, 'remote-settings.json')
  }

  getSettings(): DesktopRemoteSettings {
    if (this.settingsCache !== undefined) return this.settingsCache
    const ctx = this.getContext()
    this.settingsCache = parseDesktopRemoteSettings(readJsonFile(this.settingsPath(ctx)))
    return this.settingsCache
  }

  private saveSettings(ctx: DesktopRemoteContext, next: DesktopRemoteSettings): void {
    this.settingsCache = next
    writeJsonFile(this.settingsPath(ctx), next)
  }

  pendingCount(): number {
    return this.cachedPending.length
  }

  isRunning(): boolean {
    return this.phase === 'running' || this.phase === 'external'
  }

  private activeControl():
    | { readonly pid: number; readonly controlUrl: string; readonly controlToken: string }
    | undefined {
    if (this.owned !== undefined) {
      return {
        pid: this.owned.child.pid ?? 0,
        controlUrl: this.owned.controlUrl,
        controlToken: this.owned.controlToken,
      }
    }
    return this.externalControl
  }

  private async controlFetch(
    control: { readonly controlUrl: string; readonly controlToken: string },
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    return this.fetchFn(`${control.controlUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        authorization: `Bearer ${control.controlToken}`,
      },
      signal: AbortSignal.timeout(8_000),
    })
  }

  private detectOrAttachExternal(configDir: string): void {
    if (this.owned !== undefined || this.phase === 'starting') return
    const live = readLiveControlEndpoint(configDir)
    if (live !== undefined) {
      this.externalControl = live
      this.phase = 'external'
    } else if (this.phase === 'external') {
      this.externalControl = undefined
      this.phase = 'stopped'
      this.cachedPending = []
    }
  }

  private async refreshLiveInternal(): Promise<void> {
    const ctx = this.getContext()
    const configDir = resolveDesktopRemoteConfigDir(ctx)
    this.detectOrAttachExternal(configDir)
    const control = this.activeControl()
    if (control === undefined) {
      await this.refreshOfflineDevices(configDir, ctx.dshHome)
      return
    }

    try {
      const [statusRes, pendingRes, devicesRes] = await Promise.all([
        this.controlFetch(control, '/status'),
        this.controlFetch(control, '/pairing/pending'),
        this.controlFetch(control, '/devices'),
      ])
      if (statusRes.ok) {
        const statusBody = (await statusRes.json()) as Record<string, unknown>
        this.cachedReady = { ...this.cachedReady, ...statusBody }
      }
      if (pendingRes.ok) {
        const body = (await pendingRes.json()) as { pending?: DesktopPendingCandidateView[] }
        this.cachedPending = Array.isArray(body.pending) ? body.pending : []
      }
      if (devicesRes.ok) {
        const body = (await devicesRes.json()) as { devices?: DesktopRemoteDeviceView[] }
        this.cachedDevices = Array.isArray(body.devices) ? body.devices : []
      }
    } catch {
      if (this.phase === 'external') {
        this.detectOrAttachExternal(configDir)
      }
      await this.refreshOfflineDevices(configDir, ctx.dshHome)
    }
  }

  private async refreshOfflineDevices(configDir: string, dshHome: string): Promise<void> {
    try {
      const stores = openPersistentRemoteStores({ configDir, dshHome })
      const list = await stores.trustStore.list()
      this.cachedDevices = list.map((d) => ({
        deviceId: d.deviceId,
        displayName: d.displayName,
        capabilities: [...d.grantedCapabilities],
        pairedAt: d.pairedAt,
        lastSeenAt: d.lastSeenAt,
        ...(d.revokedAt !== undefined ? { revokedAt: d.revokedAt } : {}),
      }))
      if (existsSync(stores.hostIdentityPath)) {
        const id = await stores.hostIdentityStore.getPublicIdentity()
        this.cachedReady = { ...this.cachedReady, hostFingerprint: id.fingerprint }
      }
    } catch {
      this.cachedDevices = []
    }
  }

  async snapshot(options?: { readonly refreshLive?: boolean | undefined }): Promise<DesktopRemoteSnapshot> {
    const ctx = this.getContext()
    const configDir = resolveDesktopRemoteConfigDir(ctx)
    if (options?.refreshLive !== false) {
      await this.refreshLiveInternal()
    } else {
      await this.refreshOfflineDevices(configDir, ctx.dshHome)
    }
    const settings = this.getSettings()
    const lanCandidates = detectLanIpv4Candidates()
    const effectiveListenHost = resolveEffectiveListenHost(settings.listenHost, lanCandidates)
    const ready = this.cachedReady
    const pid =
      this.owned?.child.pid !== undefined
        ? String(this.owned.child.pid)
        : this.externalControl !== undefined
          ? String(this.externalControl.pid)
          : '—'
    const hostFingerprint = typeof ready.hostFingerprint === 'string' ? ready.hostFingerprint : ''
    const lanUrl =
      typeof ready.lanUrl === 'string'
        ? ready.lanUrl
        : typeof ready.lanEndpointUrl === 'string'
          ? ready.lanEndpointUrl
          : ''
    const relayUrl = typeof ready.relayUrl === 'string' ? ready.relayUrl : ''
    const relayRoomId = typeof ready.relayRoomId === 'string' ? ready.relayRoomId : ''
    const signalingUrl = typeof ready.signalingUrl === 'string' ? ready.signalingUrl : ''
    const signalingRoomId = typeof ready.signalingRoomId === 'string' ? ready.signalingRoomId : ''
    const stunUrls = Array.isArray(ready.stunUrls)
      ? ready.stunUrls.filter((s): s is string => typeof s === 'string')
      : []
    const activeConnections =
      typeof ready.activeConnections === 'number' && Number.isInteger(ready.activeConnections)
        ? ready.activeConnections
        : 0

    return {
      phase: this.phase,
      pid,
      configDir,
      dshHome: ctx.dshHome,
      isolated: ctx.isolated,
      apiKeyPresent: officialApiKeyPresent(ctx.env),
      hostFingerprint,
      lanCandidates,
      effectiveListenHost,
      settings,
      lanUrl,
      relayUrl,
      relayRoomId,
      signalingUrl,
      signalingRoomId,
      stunUrls,
      activeConnections,
      pairing: this.isRunning()
        ? buildPairingView({ ...ready, ...(lanUrl !== '' ? { lanUrl } : {}) }, lanCandidates)
        : undefined,
      pendingCandidates: this.cachedPending,
      devices: this.cachedDevices,
      logs: this.logs,
      ...(this.notice !== undefined ? { notice: this.notice } : {}),
      ...(this.lastError !== undefined ? { error: this.lastError } : {}),
    }
  }

  async start(rawInput?: unknown): Promise<void> {
    const validated = validateRemoteStartInput(rawInput)
    if (!validated.ok) {
      this.lastError = validated.error
      this.notice = undefined
      this.emitChange()
      return
    }

    const ctx = this.getContext()
    this.saveSettings(ctx, validated.settings)
    const configDir = resolveDesktopRemoteConfigDir(ctx)
    this.notice = undefined
    this.lastError = undefined

    if (this.phase === 'starting') return
    this.startAborted = false

    // Stop any previous Desktop-owned host cleanly before starting with updated config.
    if (this.owned !== undefined) {
      await this.stop()
    }

    this.detectOrAttachExternal(configDir)
    if (this.externalControl !== undefined) {
      this.notice = `检测到外部远程宿主（PID ${String(this.externalControl.pid)}）已在运行，已同步连接控制面。`
      await this.refreshPairingQr()
      return
    }

    if (!officialApiKeyPresent(ctx.env)) {
      this.phase = 'error'
      this.lastError = '未检测到 DEEPSEEK_API_KEY。请先设置环境变量再启动远程宿主机。'
      this.emitChange()
      return
    }

    let tmpDir = ''
    try {
      const paths = ctx.launchPaths()
      assertHostLaunchPaths(paths)
      const pluginPath = resolveDesktopRemotePluginPath(ctx)
      const pluginUrl = pathToFileURL(pluginPath).href

      tmpDir = mkdtempSync(join(tmpdir(), 'dsh-desktop-remote-'))
      const patchFile = join(tmpDir, 'remote-host.patch.yml')
      const readyFile = join(tmpDir, 'ready.json')
      const controlToken = randomBytes(24).toString('hex')
      const lanCandidates = detectLanIpv4Candidates()
      const listenHost = resolveEffectiveListenHost(validated.settings.listenHost, lanCandidates)

      writeFileSync(
        patchFile,
        composeRemoteHostPatchYaml({ pluginUrl, workspaceRoot: paths.cwd }),
        'utf8',
      )

      const baseEnv = paths.electronRunAsNode
        ? { ...paths.env, ELECTRON_RUN_AS_NODE: '1' }
        : paths.env
      const nodePrefix = paths.electronRunAsNode ? ['--expose-internals'] : []

      this.phase = 'starting'
      this.logs = ''
      this.cachedPending = []
      this.emitChange()

      const child = this.spawnFn(
        paths.nodeExecutable,
        [...nodePrefix, paths.cliEntry, '--profile', 'headless', '--patch', patchFile],
        {
          cwd: paths.cwd,
          env: {
            ...baseEnv,
            DSH_HOME: ctx.dshHome,
            DSH_REMOTE_DSH_HOME: ctx.dshHome,
            DSH_REMOTE_CONFIG_DIR: configDir,
            DSH_REMOTE_CWD: paths.cwd,
            DSH_REMOTE_LAN_HOST: listenHost,
            DSH_REMOTE_LAN_PORT: String(validated.settings.port),
            DSH_REMOTE_ENABLE_MDNS: validated.settings.enableMdns ? '1' : '0',
            ...(validated.settings.relayUrl ? { DSH_REMOTE_RELAY_URL: validated.settings.relayUrl } : {}),
            ...(validated.settings.signalingUrl
              ? { DSH_REMOTE_SIGNALING_URL: validated.settings.signalingUrl }
              : {}),
            ...(validated.settings.stunUrls ? { DSH_REMOTE_STUN_URLS: validated.settings.stunUrls } : {}),
            DSH_REMOTE_CONTROL_PORT: '0',
            DSH_REMOTE_CONTROL_TOKEN: controlToken,
            DSH_REMOTE_READY_FILE: readyFile,
            DSH_REMOTE_ISSUE_PAIRING: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )

      this.startingChild = child
      this.startingTmpDir = tmpDir
      child.stdout?.resume()

      const stderrDecoder = new StringDecoder('utf8')
      let lineBuf = ''
      const onLine = (line: string): void => {
        if (line.startsWith('DSH_REMOTE_PAIRING_REQUEST ')) {
          this.logs = clampLogTail(this.logs, `${line}\n`)
          void this.refreshLiveInternal().then(() => this.emitChange())
          return
        }
        if (line.trim().length > 0) {
          this.logs = clampLogTail(this.logs, `${line}\n`)
        }
      }

      child.stderr?.on('data', (chunk: Buffer | string) => {
        lineBuf += typeof chunk === 'string' ? chunk : stderrDecoder.write(chunk)
        for (;;) {
          const nl = lineBuf.indexOf('\n')
          if (nl === -1) break
          const line = lineBuf.slice(0, nl).replace(/\r$/u, '')
          lineBuf = lineBuf.slice(nl + 1)
          onLine(line)
        }
      })
      child.stderr?.on('close', () => {
        lineBuf += stderrDecoder.end()
        const tail = lineBuf.replace(/\r$/u, '')
        lineBuf = ''
        if (tail.length > 0) onLine(tail)
      })

      child.once('exit', (code, signal) => {
        const wasOwned = this.owned?.child === child
        if (this.startingChild === child) this.startingChild = undefined
        if (this.owned?.child === child) this.owned = undefined
        removeOwnLiveControlEndpoint(configDir)
        if (tmpDir !== '') rmSync(tmpDir, { recursive: true, force: true })
        if (this.startingTmpDir === tmpDir) this.startingTmpDir = undefined
        if (wasOwned && this.phase === 'running') {
          this.phase = code === 0 ? 'stopped' : 'error'
          if (code !== 0) {
            this.lastError = `Remote Host 进程意外退出 (code=${String(code)}, signal=${String(signal)})`
          }
          this.cachedPending = []
          this.emitChange()
        }
      })

      const ready = await waitForReadyFile(readyFile, child, 25_000)
      const controlUrl = typeof ready.controlUrl === 'string' ? ready.controlUrl : ''
      if (controlUrl === '') {
        throw new Error('Remote Host 就绪但缺少 controlUrl')
      }

      this.startingChild = undefined
      this.startingTmpDir = undefined
      this.owned = {
        child,
        tmpDir,
        configDir,
        controlUrl,
        controlToken,
        ready,
      }
      this.cachedReady = ready
      this.phase = 'running'
      this.notice = 'Remote Host 已就绪，可使用手机端扫码配对。'
      this.lastError = undefined

      try {
        writeLiveControlEndpoint(configDir, { pid: process.pid, controlUrl, controlToken })
      } catch {}

      await this.refreshLiveInternal()
      this.emitChange()
    } catch (error) {
      if (this.startingChild !== undefined && this.startingChild.exitCode === null) {
        this.startingChild.kill('SIGTERM')
      }
      this.startingChild = undefined
      this.startingTmpDir = undefined
      if (tmpDir !== '') rmSync(tmpDir, { recursive: true, force: true })
      if (this.startAborted) {
        this.startAborted = false
        this.phase = 'stopped'
        this.emitChange()
        return
      }
      this.phase = 'error'
      this.lastError = error instanceof Error ? error.message : String(error)
      this.emitChange()
    }
  }

  async stop(): Promise<void> {
    this.notice = undefined
    this.lastError = undefined
    const ctx = this.getContext()
    const configDir = resolveDesktopRemoteConfigDir(ctx)

    if (this.startingChild !== undefined) {
      this.startAborted = true
      if (this.startingChild.exitCode === null) {
        this.startingChild.kill('SIGTERM')
      }
      this.startingChild = undefined
      this.phase = 'stopped'
      this.notice = '已取消启动 Remote Host。'
    }
    if (this.startingTmpDir !== undefined) {
      rmSync(this.startingTmpDir, { recursive: true, force: true })
      this.startingTmpDir = undefined
    }

    if (this.owned !== undefined) {
      const target = this.owned
      this.owned = undefined
      this.phase = 'stopped'
      await this.shutdownProcess(target)
      this.cachedPending = []
      this.notice = 'Remote Host 已停止。'
      this.emitChange()
      return
    }

    if (this.externalControl !== undefined) {
      const ext = this.externalControl
      this.externalControl = undefined
      await this.controlFetch(ext, '/shutdown', { method: 'POST' }).catch(() => {})
      this.phase = 'stopped'
      this.cachedPending = []
      this.notice = '已向外部 Remote Host 发送停止指令。'
      await this.refreshOfflineDevices(configDir, ctx.dshHome)
      this.emitChange()
      return
    }

    this.phase = 'stopped'
    this.emitChange()
  }

  async stopIfOwned(): Promise<void> {
    if (this.owned === undefined && this.startingChild === undefined) return
    await this.stop()
  }

  async shutdown(): Promise<void> {
    await this.stopIfOwned()
  }

  private async shutdownProcess(target: OwnedRemoteProcess): Promise<void> {
    removeOwnLiveControlEndpoint(target.configDir)
    const exited = new Promise<void>((resolveExit) => {
      if (target.child.exitCode !== null || target.child.killed) {
        resolveExit()
        return
      }
      const timer = setTimeout(() => {
        if (target.child.exitCode === null) target.child.kill('SIGKILL')
        resolveExit()
      }, 4_000)
      timer.unref()
      target.child.once('exit', () => {
        clearTimeout(timer)
        resolveExit()
      })
    })
    await this.controlFetch(
      { controlUrl: target.controlUrl, controlToken: target.controlToken },
      '/shutdown',
      { method: 'POST' },
    ).catch(() => {
      if (target.child.exitCode === null) target.child.kill('SIGTERM')
    })
    await exited
    rmSync(target.tmpDir, { recursive: true, force: true })
  }

  async refreshPairingQr(): Promise<void> {
    const control = this.activeControl()
    if (control === undefined) {
      this.lastError = 'Remote Host 未运行，无法签发配对二维码。'
      this.emitChange()
      return
    }
    try {
      const res = await this.controlFetch(control, '/pairing-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const body = (await res.json()) as Record<string, unknown>
      if (!res.ok) {
        throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${String(res.status)}`)
      }
      this.cachedReady = {
        ...this.cachedReady,
        ...(typeof body.pairingJson === 'string' ? { pairingJson: body.pairingJson } : {}),
        ...(typeof body.deepLink === 'string' ? { deepLink: body.deepLink } : {}),
        ...(typeof body.expiresAt === 'number' ? { expiresAt: body.expiresAt } : {}),
      }
      this.notice = '已生成新的配对二维码。'
      this.lastError = undefined
      await this.refreshLiveInternal()
      this.emitChange()
    } catch (error) {
      this.lastError = `刷新配对码失败: ${error instanceof Error ? error.message : String(error)}`
      this.emitChange()
    }
  }

  async confirmPairing(candidateId: string, allowApprove: boolean): Promise<void> {
    const control = this.activeControl()
    if (control === undefined) {
      this.lastError = 'Remote Host 未运行，无法确认配对请求。'
      this.emitChange()
      return
    }
    try {
      await this.refreshLiveInternal()
      const candidate = this.cachedPending.find((c) => c.candidateId === candidateId)
      const baseCaps = candidate?.maxAllowedCapabilities ?? ['observe', 'prompt', 'approve', 'answer-question']
      const grantedCapabilities = allowApprove
        ? [...baseCaps]
        : baseCaps.filter((c) => c !== 'approve')
      const res = await this.controlFetch(control, '/pairing/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ candidateId, grantedCapabilities }),
      })
      const body = (await res.json()) as { ok?: boolean; displayName?: string; deviceId?: string; error?: string }
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? `HTTP ${String(res.status)}`)
      }
      this.notice = `已授权设备 ${body.displayName ?? body.deviceId ?? candidateId}`
      this.lastError = undefined
      await this.refreshLiveInternal()
      this.emitChange()
    } catch (error) {
      this.lastError = `确认配对失败: ${error instanceof Error ? error.message : String(error)}`
      this.emitChange()
    }
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const ctx = this.getContext()
    const configDir = resolveDesktopRemoteConfigDir(ctx)
    this.detectOrAttachExternal(configDir)
    const control = this.activeControl()
    try {
      if (control !== undefined) {
        const res = await this.controlFetch(control, '/devices/revoke', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deviceId }),
        })
        const body = (await res.json()) as { revoked?: boolean; error?: string }
        if (!res.ok) throw new Error(body.error ?? `HTTP ${String(res.status)}`)
        if (!body.revoked) throw new Error(`未找到可吊销设备: ${deviceId}`)
        this.notice = `已吊销设备 ${deviceId}（在线会话已断开）`
      } else {
        const stores = openPersistentRemoteStores({ configDir, dshHome: ctx.dshHome })
        const revoked = await stores.trustStore.revoke(deviceId)
        if (!revoked) throw new Error(`未找到可吊销设备: ${deviceId}`)
        this.notice = `已离线吊销设备 ${deviceId}`
      }
      this.lastError = undefined
      await this.refreshLiveInternal()
      this.emitChange()
    } catch (error) {
      this.lastError = `吊销设备失败: ${error instanceof Error ? error.message : String(error)}`
      this.emitChange()
    }
  }
}
