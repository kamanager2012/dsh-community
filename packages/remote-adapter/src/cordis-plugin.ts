import { chmodSync, writeFileSync } from 'node:fs'
import type { Capability } from './protocol.js'
import type { HostLanCarrierOptions } from './carrier/lan-host.js'
import type { HostRelayCarrierOptions } from './carrier/relay-host.js'
import type { HostWebRtcCarrierOptions } from './carrier/webrtc-host.js'
import {
  createBridgeControlServer,
  defaultRemoteConfigDir,
  defaultRemoteDshHome,
  OfficialHostCordisBridge,
  type BridgeControlServerHandle,
  type OfficialCordisContextLike,
  type PairingIssueResult,
} from './cordis-host.js'

export const name = 'dsh-community-remote'

export const inject = ['agents', 'userQuestions', 'agentDefaultModel', 'sessions'] as const

const ALL_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'observe',
  'prompt',
  'approve',
  'answer-question',
])

function parseOptionalPort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`invalid DSH_REMOTE port value: ${raw}`)
  }
  return parsed
}

function parseOptionalCapabilities(raw: string | undefined): Capability[] | undefined {
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

function parseBooleanEnv(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true'
}

export function apply(ctx: OfficialCordisContextLike): () => void {
  const controlToken = process.env.DSH_REMOTE_CONTROL_TOKEN?.trim() || undefined
  const relayHostSecret = process.env.DSH_REMOTE_RELAY_HOST_SECRET?.trim() || undefined
  const relayClientToken = process.env.DSH_REMOTE_RELAY_CLIENT_TOKEN?.trim() || undefined
  const signalingHostSecret = process.env.DSH_REMOTE_SIGNALING_HOST_SECRET?.trim() || undefined
  const signalingJoinToken = process.env.DSH_REMOTE_SIGNALING_JOIN_TOKEN?.trim() || undefined

  // Scrub operator/channel secrets before agent tool subprocesses can inherit them.
  delete process.env.DSH_REMOTE_CONTROL_TOKEN
  delete process.env.DSH_REMOTE_RELAY_HOST_SECRET
  delete process.env.DSH_REMOTE_RELAY_CLIENT_TOKEN
  delete process.env.DSH_REMOTE_SIGNALING_HOST_SECRET
  delete process.env.DSH_REMOTE_SIGNALING_JOIN_TOKEN

  const dshHome = process.env.DSH_REMOTE_DSH_HOME?.trim() || defaultRemoteDshHome()
  const configDir = process.env.DSH_REMOTE_CONFIG_DIR?.trim() || defaultRemoteConfigDir()
  const cwd = process.env.DSH_REMOTE_CWD?.trim() || process.cwd()
  const lanHost = process.env.DSH_REMOTE_LAN_HOST?.trim() || '127.0.0.1'
  const lanPort = parseOptionalPort(process.env.DSH_REMOTE_LAN_PORT) ?? 0
  const enableMdns = parseBooleanEnv(process.env.DSH_REMOTE_ENABLE_MDNS)
  const hostDisplayLabel = process.env.DSH_REMOTE_MDNS_LABEL?.trim() || undefined

  const relayUrl = process.env.DSH_REMOTE_RELAY_URL?.trim() || undefined
  const relayRoomId = process.env.DSH_REMOTE_RELAY_ROOM_ID?.trim() || undefined
  const signalingUrl = process.env.DSH_REMOTE_SIGNALING_URL?.trim() || undefined
  const signalingRoomId = process.env.DSH_REMOTE_SIGNALING_ROOM_ID?.trim() || undefined
  const stunUrlsRaw = process.env.DSH_REMOTE_STUN_URLS?.trim()
  const stunUrls = stunUrlsRaw
    ? stunUrlsRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined

  const controlPort = parseOptionalPort(process.env.DSH_REMOTE_CONTROL_PORT)
  const readyFile = process.env.DSH_REMOTE_READY_FILE?.trim() || undefined
  const emitReadyStdout = parseBooleanEnv(process.env.DSH_REMOTE_EMIT_READY)
  const initialSessionEnv = process.env.DSH_REMOTE_INITIAL_SESSION_ID?.trim() || undefined
  const issuePairingOnStart = parseBooleanEnv(process.env.DSH_REMOTE_ISSUE_PAIRING)
  const pairingTtlRaw = process.env.DSH_REMOTE_PAIRING_TTL_MS?.trim()
  const pairingTtlMs = pairingTtlRaw ? Number(pairingTtlRaw) : undefined
  const autoConfirmCapabilities = parseOptionalCapabilities(
    process.env.DSH_REMOTE_AUTO_APPROVE_PAIRING,
  )

  const carrier: Omit<
    HostLanCarrierOptions,
    'core' | 'trustStore' | 'hostIdentityStore' | 'pairingCoordinator' | 'epochAllocator'
  > = {
    enabled: true,
    host: lanHost,
    port: lanPort,
    ...(enableMdns ? { enableMdns: true } : {}),
    ...(hostDisplayLabel !== undefined ? { hostDisplayLabel } : {}),
  }

  const relay:
    | Omit<
        HostRelayCarrierOptions,
        'core' | 'trustStore' | 'hostIdentityStore' | 'pairingCoordinator' | 'epochAllocator'
      >
    | undefined =
    relayUrl !== undefined
      ? {
          enabled: true,
          relayUrl,
          ...(relayRoomId !== undefined ? { roomId: relayRoomId } : {}),
          ...(relayHostSecret !== undefined ? { hostAuthSecret: relayHostSecret } : {}),
          ...(relayClientToken !== undefined ? { clientToken: relayClientToken } : {}),
        }
      : undefined

  const webrtc:
    | Omit<
        HostWebRtcCarrierOptions,
        'core' | 'trustStore' | 'hostIdentityStore' | 'pairingCoordinator' | 'epochAllocator'
      >
    | undefined =
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

  let controlServer: BridgeControlServerHandle | undefined
  let stopping = false

  const bridge = new OfficialHostCordisBridge({
    ctx,
    configDir,
    dshHome,
    cwd,
    carrier,
    ...(relay !== undefined ? { relay } : {}),
    ...(webrtc !== undefined ? { webrtc } : {}),
    ...(pairingTtlMs !== undefined && Number.isFinite(pairingTtlMs) ? { pairingTtlMs } : {}),
    ...(autoConfirmCapabilities !== undefined ? { autoConfirmCapabilities } : {}),
    onPairingCandidate: (candidate) => {
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
    },
  })

  const shutdown = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    await controlServer?.close().catch(() => {})
    controlServer = undefined
    await bridge.stop().catch(() => {})
  }

  const boot = async (): Promise<void> => {
    await bridge.start()

    let initialSessionId: string | undefined
    if (initialSessionEnv !== undefined) {
      if (initialSessionEnv === 'auto') {
        const created = await bridge.createSession({ cwd })
        initialSessionId = created.id
      } else {
        const existing = (await bridge.listSessions()).some((s) => s.id === initialSessionEnv)
        if (existing) {
          await bridge.ensureLiveAgent(initialSessionEnv)
          initialSessionId = initialSessionEnv
        } else {
          const created = await bridge.createSession({ sessionId: initialSessionEnv, cwd })
          initialSessionId = created.id
        }
      }
    }

    if (controlPort !== undefined) {
      controlServer = await createBridgeControlServer(bridge, {
        port: controlPort,
        ...(controlToken !== undefined ? { controlToken } : {}),
        onShutdown: () => {
          process.exit(0)
        },
      })
    }

    let issuedPairing: PairingIssueResult | undefined
    if (issuePairingOnStart) {
      issuedPairing = await bridge.issuePairingDescriptor()
    }

    const identity = await bridge.stores.hostIdentityStore.getPublicIdentity()
    const readyPayload = {
      configDir: bridge.stores.configDir,
      dshHome,
      hostFingerprint: identity.fingerprint,
      lanUrl: bridge.runtime.carrier.getEndpointUrl(),
      relayRoomId: bridge.runtime.relay?.getRoomId(),
      ...(initialSessionId !== undefined ? { sessionId: initialSessionId } : {}),
      ...(controlServer !== undefined
        ? { controlUrl: controlServer.url, controlToken: controlServer.controlToken }
        : {}),
      ...(issuedPairing !== undefined
        ? {
            pairingJson: issuedPairing.pairingJson,
            deepLink: issuedPairing.deepLink,
            expiresAt: issuedPairing.expiresAt,
          }
        : {}),
    }

    if (readyFile !== undefined) {
      writeFileSync(readyFile, `${JSON.stringify(readyPayload)}\n`, { mode: 0o600 })
      if (process.platform !== 'win32') chmodSync(readyFile, 0o600)
    }
    if (emitReadyStdout) {
      process.stdout.write(`DSH_REMOTE_READY ${JSON.stringify(readyPayload)}\n`)
    }
  }

  void boot().catch((err: unknown) => {
    const message = err instanceof Error ? err.stack ?? err.message : String(err)
    process.stderr.write(`dsh-community-remote failed to start: ${message}\n`)
    process.exitCode = 1
  })

  return () => {
    void shutdown()
  }
}
