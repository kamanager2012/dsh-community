import { randomBytes } from 'node:crypto'
import { chmodSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HostLanCarrierOptions } from './carrier/lan-host.js'
import type { HostRelayCarrierOptions } from './carrier/relay-host.js'
import type { HostWebRtcCarrierOptions } from './carrier/webrtc-host.js'
import type { PairingCandidateView } from './crypto/pairing-token.js'
import type { AgentEngineId, Capability, EngineDescriptor } from './protocol.js'
import { defaultRemoteConfigDir, defaultRemoteDshHome } from './stores.js'

const ALL_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'observe',
  'prompt',
  'approve',
  'answer-question',
])

const VALID_ENGINES: ReadonlySet<AgentEngineId> = new Set<AgentEngineId>([
  'dsh',
  'claude',
  'codex',
  'opencode',
  'acp',
])

export interface RemoteTransportDefaults {
  readonly relayUrl?: string | undefined
  readonly signalingUrl?: string | undefined
  readonly stunUrlsRaw?: string | undefined
  readonly stunUrls?: readonly string[] | undefined
  readonly error?: string | undefined
}

const MAX_TRANSPORT_URL_CHARS = 512
const STUN_URL_RE = /^stun:[^\s,]+(?::\d+)?$/iu

export function validateWsEndpointUrl(
  raw: string | undefined,
  fieldLabel = 'URL',
): string | undefined {
  const trimmed = raw?.trim() ?? ''
  if (trimmed === '') return undefined
  if (trimmed.length > MAX_TRANSPORT_URL_CHARS || /[\s\u0000-\u001f]/u.test(trimmed)) {
    return `${fieldLabel} 格式无效或包含空白字符`
  }
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      return `${fieldLabel} 必须使用 ws:// 或 wss:// 协议`
    }
    return undefined
  } catch {
    return `${fieldLabel} 不是有效的 URL`
  }
}

export function normalizeStunUrlList(
  raw: string | undefined,
  fieldLabel = 'STUN URL',
):
  | { readonly ok: true; readonly urls: readonly string[]; readonly formatted: string }
  | { readonly ok: false; readonly error: string } {
  const trimmed = raw?.trim() ?? ''
  if (trimmed === '') {
    return { ok: true, urls: [], formatted: '' }
  }
  if (trimmed.length > MAX_TRANSPORT_URL_CHARS || /[\u0000-\u001f]/u.test(trimmed)) {
    return { ok: false, error: `${fieldLabel} 列表过长或包含非法字符` }
  }
  const items = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  for (const item of items) {
    if (!STUN_URL_RE.test(item)) {
      return {
        ok: false,
        error: `${fieldLabel} 格式无效: ${item}（应形如 stun:host:port，禁止 turn:/turns:）`,
      }
    }
  }
  return { ok: true, urls: items, formatted: items.join(', ') }
}

/**
 * Resolves unified public-network carrier defaults across CLI/TUI/Desktop (`DSH_REMOTE_DEFAULT_*`)
 * with strict `ws:`/`wss:` and `stun:`-only validation (no third-party TURN).
 */
export function resolveRemoteDefaultTransportEnv(
  env: NodeJS.ProcessEnv = process.env,
  explicit?: {
    readonly relayUrl?: string | undefined
    readonly signalingUrl?: string | undefined
    readonly stunUrls?: string | undefined
  },
): RemoteTransportDefaults {
  const explicitRelay = explicit?.relayUrl?.trim() || undefined
  const envRelay = env.DSH_REMOTE_RELAY_URL?.trim() || undefined
  const defaultRelay = env.DSH_REMOTE_DEFAULT_RELAY_URL?.trim() || undefined
  const relayUrl = explicitRelay ?? envRelay ?? defaultRelay
  if (relayUrl !== undefined) {
    const relayLabel = explicitRelay
      ? '盲中继地址 (Relay URL)'
      : envRelay
        ? 'DSH_REMOTE_RELAY_URL'
        : 'DSH_REMOTE_DEFAULT_RELAY_URL'
    const relayErr = validateWsEndpointUrl(relayUrl, relayLabel)
    if (relayErr !== undefined) return { error: relayErr }
  }

  const explicitSignaling = explicit?.signalingUrl?.trim() || undefined
  const envSignaling = env.DSH_REMOTE_SIGNALING_URL?.trim() || undefined
  const defaultSignaling = env.DSH_REMOTE_DEFAULT_SIGNALING_URL?.trim() || undefined
  const signalingUrl = explicitSignaling ?? envSignaling ?? defaultSignaling
  if (signalingUrl !== undefined) {
    const sigLabel = explicitSignaling
      ? 'WebRTC 信令地址 (Signaling URL)'
      : envSignaling
        ? 'DSH_REMOTE_SIGNALING_URL'
        : 'DSH_REMOTE_DEFAULT_SIGNALING_URL'
    const sigErr = validateWsEndpointUrl(signalingUrl, sigLabel)
    if (sigErr !== undefined) return { error: sigErr }
  }

  const explicitStun = explicit?.stunUrls?.trim() || undefined
  const envStun = env.DSH_REMOTE_STUN_URLS?.trim() || undefined
  const defaultStun = env.DSH_REMOTE_DEFAULT_STUN_URLS?.trim() || undefined
  const stunSource = explicitStun ?? envStun ?? defaultStun
  let stunUrlsRaw: string | undefined
  let stunUrls: readonly string[] | undefined
  if (stunSource !== undefined) {
    const stunLabel = explicitStun
      ? 'STUN 地址'
      : envStun
        ? 'DSH_REMOTE_STUN_URLS'
        : 'DSH_REMOTE_DEFAULT_STUN_URLS'
    const parsedStun = normalizeStunUrlList(stunSource, stunLabel)
    if (!parsedStun.ok) return { error: parsedStun.error }
    if (parsedStun.urls.length > 0) {
      stunUrlsRaw = parsedStun.formatted
      stunUrls = parsedStun.urls
    }
  }

  return {
    ...(relayUrl !== undefined ? { relayUrl } : {}),
    ...(signalingUrl !== undefined ? { signalingUrl } : {}),
    ...(stunUrlsRaw !== undefined ? { stunUrlsRaw } : {}),
    ...(stunUrls !== undefined ? { stunUrls } : {}),
  }
}

export function parseOptionalPort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`invalid DSH_REMOTE port value: ${raw}`)
  }
  return parsed
}

export function parseOptionalCapabilities(raw: string | undefined): Capability[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const out: Capability[] = []
  for (const part of raw.split(',')) {
    const cap = part.trim() as Capability
    if (!ALL_CAPABILITIES.has(cap)) {
      throw new Error(`unsupported capability '${part}' in DSH_REMOTE_AUTO_APPROVE_PAIRING`)
    }
    if (!out.includes(cap)) out.push(cap)
  }
  return out.length > 0 ? out : undefined
}

export function parseBooleanEnv(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true'
}

export function parseRequestedEngines(
  raw: string | undefined,
  options?: {
    readonly defaultWhenUnset?: readonly AgentEngineId[] | undefined
    readonly autoEngines?: readonly AgentEngineId[] | undefined
    readonly excludeDsh?: boolean | undefined
  },
): AgentEngineId[] {
  const autoList: readonly AgentEngineId[] = options?.autoEngines ?? ['dsh', 'claude', 'codex', 'opencode']
  const trimmed = raw?.trim().toLowerCase()
  let parsed: AgentEngineId[]
  if (!trimmed) {
    parsed = [...(options?.defaultWhenUnset ?? [])]
  } else if (trimmed === 'none' || trimmed === 'off') {
    parsed = []
  } else if (trimmed === 'auto' || trimmed === 'all') {
    parsed = [...autoList]
  } else {
    parsed = []
    for (const part of trimmed.split(',')) {
      const id = part.trim() as AgentEngineId
      if (!id) continue
      if (!VALID_ENGINES.has(id)) {
        throw new Error(`unsupported engine '${part}' in DSH_REMOTE_ENGINES`)
      }
      if (!parsed.includes(id)) parsed.push(id)
    }
  }
  if (options?.excludeDsh) {
    return parsed.filter((id) => id !== 'dsh')
  }
  return parsed
}

export interface ParsedRemoteHostEnv {
  readonly controlToken?: string | undefined
  readonly dshHome: string
  readonly configDir: string
  readonly cwd: string
  readonly carrier: Omit<
    HostLanCarrierOptions,
    'core' | 'trustStore' | 'hostIdentityStore' | 'pairingCoordinator' | 'epochAllocator'
  >
  readonly relay?: Omit<
    HostRelayCarrierOptions,
    'core' | 'trustStore' | 'hostIdentityStore' | 'pairingCoordinator' | 'epochAllocator'
  > | undefined
  readonly webrtc?: Omit<
    HostWebRtcCarrierOptions,
    'core' | 'trustStore' | 'hostIdentityStore' | 'pairingCoordinator' | 'epochAllocator'
  > | undefined
  readonly relayUrl?: string | undefined
  readonly signalingUrl?: string | undefined
  readonly stunUrls?: readonly string[] | undefined
  readonly controlPort?: number | undefined
  readonly readyFile?: string | undefined
  readonly emitReadyStdout: boolean
  readonly initialSessionEnv?: string | undefined
  readonly issuePairingOnStart: boolean
  readonly pairingTtlMs?: number | undefined
  readonly autoConfirmCapabilities?: readonly Capability[] | undefined
  readonly enginesRaw?: string | undefined
  readonly defaultEngine?: AgentEngineId | undefined
}

/**
 * Reads DSH_REMOTE_* environment variables and immediately deletes host/channel secrets
 * from `env` so spawned agent/tool child processes cannot inherit control or relay tokens.
 */
export function parseAndScrubRemoteHostEnv(env: NodeJS.ProcessEnv = process.env): ParsedRemoteHostEnv {
  const controlToken = env.DSH_REMOTE_CONTROL_TOKEN?.trim() || undefined
  const relayHostSecret = env.DSH_REMOTE_RELAY_HOST_SECRET?.trim() || undefined
  const relayClientToken = env.DSH_REMOTE_RELAY_CLIENT_TOKEN?.trim() || undefined
  const signalingHostSecret = env.DSH_REMOTE_SIGNALING_HOST_SECRET?.trim() || undefined
  const signalingJoinToken = env.DSH_REMOTE_SIGNALING_JOIN_TOKEN?.trim() || undefined

  delete env.DSH_REMOTE_CONTROL_TOKEN
  delete env.DSH_REMOTE_RELAY_HOST_SECRET
  delete env.DSH_REMOTE_RELAY_CLIENT_TOKEN
  delete env.DSH_REMOTE_SIGNALING_HOST_SECRET
  delete env.DSH_REMOTE_SIGNALING_JOIN_TOKEN

  const dshHome = env.DSH_REMOTE_DSH_HOME?.trim() || defaultRemoteDshHome(env)
  const configDir = env.DSH_REMOTE_CONFIG_DIR?.trim() || defaultRemoteConfigDir(env)
  const cwd = env.DSH_REMOTE_CWD?.trim() || process.cwd()
  const lanHost = env.DSH_REMOTE_LAN_HOST?.trim() || '127.0.0.1'
  const lanPort = parseOptionalPort(env.DSH_REMOTE_LAN_PORT) ?? 0
  const enableMdns = parseBooleanEnv(env.DSH_REMOTE_ENABLE_MDNS)
  const hostDisplayLabel = env.DSH_REMOTE_MDNS_LABEL?.trim() || undefined

  const transport = resolveRemoteDefaultTransportEnv(env)
  if (transport.error !== undefined) {
    throw new Error(transport.error)
  }
  const relayUrl = transport.relayUrl
  const relayRoomId = env.DSH_REMOTE_RELAY_ROOM_ID?.trim() || undefined
  const signalingUrl = transport.signalingUrl
  const signalingRoomId = env.DSH_REMOTE_SIGNALING_ROOM_ID?.trim() || undefined
  const stunUrls = transport.stunUrls

  const controlPort = parseOptionalPort(env.DSH_REMOTE_CONTROL_PORT)
  const readyFile = env.DSH_REMOTE_READY_FILE?.trim() || undefined
  const emitReadyStdout = parseBooleanEnv(env.DSH_REMOTE_EMIT_READY)
  const initialSessionEnv = env.DSH_REMOTE_INITIAL_SESSION_ID?.trim() || undefined
  const issuePairingOnStart = parseBooleanEnv(env.DSH_REMOTE_ISSUE_PAIRING)
  const pairingTtlRaw = env.DSH_REMOTE_PAIRING_TTL_MS?.trim()
  const pairingTtlMs = pairingTtlRaw ? Number(pairingTtlRaw) : undefined
  const autoConfirmCapabilities = parseOptionalCapabilities(env.DSH_REMOTE_AUTO_APPROVE_PAIRING)
  const enginesRaw = env.DSH_REMOTE_ENGINES?.trim() || undefined
  const defaultEngineRaw = env.DSH_REMOTE_DEFAULT_ENGINE?.trim().toLowerCase()
  const defaultEngine =
    defaultEngineRaw && VALID_ENGINES.has(defaultEngineRaw as AgentEngineId)
      ? (defaultEngineRaw as AgentEngineId)
      : undefined

  const carrier: ParsedRemoteHostEnv['carrier'] = {
    enabled: true,
    host: lanHost,
    port: lanPort,
    ...(enableMdns ? { enableMdns: true } : {}),
    ...(hostDisplayLabel !== undefined ? { hostDisplayLabel } : {}),
  }

  const relay: ParsedRemoteHostEnv['relay'] =
    relayUrl !== undefined
      ? {
          enabled: true,
          relayUrl,
          ...(relayRoomId !== undefined ? { roomId: relayRoomId } : {}),
          ...(relayHostSecret !== undefined ? { hostAuthSecret: relayHostSecret } : {}),
          ...(relayClientToken !== undefined ? { clientToken: relayClientToken } : {}),
        }
      : undefined

  const webrtc: ParsedRemoteHostEnv['webrtc'] =
    signalingUrl !== undefined
      ? {
          enabled: true,
          signalingUrl,
          ...(signalingRoomId !== undefined ? { roomId: signalingRoomId } : {}),
          ...(signalingHostSecret !== undefined ? { hostAuthSecret: signalingHostSecret } : {}),
          ...(signalingJoinToken !== undefined ? { joinToken: signalingJoinToken } : {}),
          ...(stunUrls !== undefined && stunUrls.length > 0 ? { ice: { stunUrls } } : {}),
        }
      : undefined

  return {
    controlToken,
    dshHome,
    configDir,
    cwd,
    carrier,
    relay,
    webrtc,
    relayUrl,
    signalingUrl,
    stunUrls,
    controlPort,
    readyFile,
    emitReadyStdout,
    initialSessionEnv,
    issuePairingOnStart,
    pairingTtlMs: pairingTtlMs !== undefined && Number.isFinite(pairingTtlMs) ? pairingTtlMs : undefined,
    autoConfirmCapabilities,
    enginesRaw,
    defaultEngine,
  }
}

export function emitPairingRequestStderr(
  candidate: PairingCandidateView,
  autoConfirmCapabilities: readonly Capability[] | undefined,
): void {
  if (autoConfirmCapabilities === undefined) {
    process.stderr.write(
      `DSH_REMOTE_PAIRING_REQUEST ${JSON.stringify({
        candidateId: candidate.candidateId,
        deviceId: candidate.deviceId,
        displayName: candidate.displayName,
        maxAllowedCapabilities: candidate.maxAllowedCapabilities,
      })}\n`,
    )
  }
}

export function publishReadyPayload(
  readyFile: string | undefined,
  emitReadyStdout: boolean,
  payload: Record<string, unknown> & { readonly engines?: readonly EngineDescriptor[] | undefined },
): void {
  if (readyFile !== undefined) {
    const readyTmp = join(dirname(readyFile), `.ready.${randomBytes(6).toString('hex')}.tmp`)
    writeFileSync(readyTmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(readyTmp, 0o600)
    renameSync(readyTmp, readyFile)
  }
  if (emitReadyStdout) {
    process.stdout.write(`DSH_REMOTE_READY ${JSON.stringify(payload)}\n`)
  }
}
