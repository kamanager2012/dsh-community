import { resolve } from 'node:path'
import type { HostLanCarrierOptions } from '../carrier/lan-host.js'
import { createPairingBootstrapDescriptor, encodePairingDeepLink } from '../carrier/pairing-qr.js'
import type { HostRelayCarrierOptions } from '../carrier/relay-host.js'
import type { HostWebRtcCarrierOptions } from '../carrier/webrtc-host.js'
import {
  createBridgeControlServer,
  ObservablePairingCoordinator,
  type BridgeControlServerHandle,
  type PairingIssueResult,
} from '../cordis-host.js'
import type { DeviceRecord } from '../crypto/device-trust.js'
import { MAX_PAIRING_TTL_MS, PairingTokenRegistry, type PairingCandidateView } from '../crypto/pairing-token.js'
import { RemoteProtocolError } from '../errors.js'
import { RemoteHostRuntime, type RemoteHostRuntimeOptions } from '../host-runtime.js'
import {
  REMOTE_PROTOCOL_VERSION,
  type AgentEngineId,
  type Capability,
  type CreateSessionParams,
  type EngineDescriptor,
  type SessionRef,
  type WorkspaceGitDiffParams,
  type WorkspaceGitDiffResult,
  type WorkspaceGitStatusParams,
  type WorkspaceGitStatusResult,
} from '../protocol.js'
import {
  defaultRemoteDshHome,
  openPersistentRemoteStores,
  type PersistentRemoteStores,
} from '../stores.js'
import { AcpAgentBackend } from './acp-backend.js'
import { ClaudeAgentBackend } from './claude-backend.js'
import { CodexAgentBackend } from './codex-backend.js'
import { MultiAgentHostRouter } from './multi-agent-router.js'
import type { ManagedAgentBackend } from './types.js'

const DEFAULT_GRANTED_CAPABILITIES: readonly Capability[] = Object.freeze([
  'observe',
  'prompt',
  'approve',
  'answer-question',
])

export interface MultiAgentRemoteHostOptions {
  readonly engines?: readonly AgentEngineId[] | undefined
  readonly defaultEngine?: AgentEngineId | undefined
  readonly backends?: readonly ManagedAgentBackend[] | undefined
  readonly configDir?: string | undefined
  readonly dshHome?: string | undefined
  readonly cwd?: string | undefined
  readonly carrier?: Omit<
    HostLanCarrierOptions,
    'core' | 'trustStore' | 'hostIdentityStore' | 'pairingCoordinator' | 'epochAllocator'
  > | undefined
  readonly webrtc?: Omit<
    HostWebRtcCarrierOptions,
    'core' | 'trustStore' | 'hostIdentityStore' | 'pairingCoordinator' | 'epochAllocator'
  > | undefined
  readonly relay?: Omit<
    HostRelayCarrierOptions,
    'core' | 'trustStore' | 'hostIdentityStore' | 'pairingCoordinator' | 'epochAllocator'
  > | undefined
  readonly coreOptions?: RemoteHostRuntimeOptions['coreOptions'] | undefined
  readonly pairingTtlMs?: number | undefined
  readonly onPairingCandidate?: ((candidate: PairingCandidateView) => void) | undefined
  readonly autoConfirmCapabilities?: readonly Capability[] | undefined
  readonly clock?: (() => number) | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
}

export function createConfiguredExternalBackends(options: {
  readonly engines?: readonly AgentEngineId[] | undefined
  readonly defaultCwd?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
}): ManagedAgentBackend[] {
  const cwd = options.defaultCwd ?? process.cwd()
  const env = options.env ?? process.env
  const requested = options.engines
    ? new Set(options.engines.map((e) => String(e).toLowerCase()))
    : new Set<string>(['claude', 'codex', 'opencode'])

  const out: ManagedAgentBackend[] = []
  if (requested.has('claude')) {
    out.push(new ClaudeAgentBackend({ defaultCwd: cwd, env }))
  }
  if (requested.has('codex')) {
    out.push(new CodexAgentBackend({ defaultCwd: cwd, env }))
  }
  if (requested.has('opencode')) {
    out.push(new AcpAgentBackend({
      engineId: 'opencode',
      displayName: 'OpenCode (ACP)',
      command: 'opencode',
      args: ['acp'],
      defaultCwd: cwd,
      env,
    }))
  }
  return out
}

/**
 * Standalone multi-agent E2EE Remote Host that works without Cordis or DEEPSEEK_API_KEY,
 * multiplexing Claude Code, Codex CLI, OpenCode ACP, and custom backends over the unified
 * Noise IK + LAN/WebRTC/Relay runtime.
 */
export class MultiAgentRemoteHost {
  readonly stores: PersistentRemoteStores
  readonly tokenRegistry: PairingTokenRegistry
  readonly pairingCoordinator: ObservablePairingCoordinator
  readonly router: MultiAgentHostRouter
  readonly runtime: RemoteHostRuntime

  private readonly dshHome: string
  private readonly options: MultiAgentRemoteHostOptions
  private readonly activeSessions = new Set<string>()
  private readonly rootUnsubscribes: Array<() => void> = []
  private started = false
  private stopped = false

  constructor(options: MultiAgentRemoteHostOptions = {}) {
    this.options = options
    const env = options.env ?? process.env
    this.dshHome = options.dshHome ? resolve(options.dshHome) : defaultRemoteDshHome(env)
    const defaultCwd = options.cwd ?? process.cwd()

    this.stores = openPersistentRemoteStores({
      configDir: options.configDir,
      dshHome: this.dshHome,
      clock: options.clock,
    })

    this.tokenRegistry = new PairingTokenRegistry(
      16,
      options.pairingTtlMs ?? MAX_PAIRING_TTL_MS,
      MAX_PAIRING_TTL_MS,
      options.clock ? { clock: options.clock } : undefined,
    )
    this.pairingCoordinator = new ObservablePairingCoordinator(
      this.stores.hostIdentityStore,
      this.stores.trustStore,
      this.tokenRegistry,
      options.clock ? { clock: options.clock } : undefined,
    )

    if (options.onPairingCandidate || options.autoConfirmCapabilities) {
      const unsub = this.pairingCoordinator.subscribeCandidates((candidate) => {
        options.onPairingCandidate?.(candidate)
        if (options.autoConfirmCapabilities) {
          const allowedSet = new Set(candidate.maxAllowedCapabilities)
          const granted = options.autoConfirmCapabilities.filter((c) => allowedSet.has(c))
          void this.pairingCoordinator
            .confirmPairing({
              candidateId: candidate.candidateId,
              grantedCapabilities: granted.length > 0 ? granted : ['observe'],
            })
            .catch(() => {})
        }
      })
      this.rootUnsubscribes.push(unsub)
    }

    const backends = options.backends
      ? [...options.backends]
      : createConfiguredExternalBackends({
          engines: options.engines,
          defaultCwd,
          env,
        })

    this.router = new MultiAgentHostRouter({
      backends,
      ...(options.defaultEngine !== undefined ? { defaultEngine: options.defaultEngine } : {}),
      defaultCwd,
    })

    this.runtime = new RemoteHostRuntime({
      seams: this.router,
      trustStore: this.stores.trustStore,
      hostIdentityStore: this.stores.hostIdentityStore,
      pairingCoordinator: this.pairingCoordinator,
      ...(options.coreOptions !== undefined ? { coreOptions: options.coreOptions } : {}),
      carrier: options.carrier ?? {
        enabled: true,
        host: '127.0.0.1',
        port: 0,
      },
      ...(options.webrtc !== undefined ? { webrtc: options.webrtc } : {}),
      ...(options.relay !== undefined ? { relay: options.relay } : {}),
    })

    const unsubEvents = this.router.onEvent((sessionId, events) => {
      this.activeSessions.add(sessionId)
      this.runtime.ingestSessionEventBatch(sessionId, { log: events })
    })
    this.rootUnsubscribes.push(unsubEvents)
  }

  async start(): Promise<void> {
    if (this.started) return
    await this.stores.hostIdentityStore.loadOrCreate()
    await this.router.start()
    await this.runtime.start()
    this.started = true
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    for (const unsub of this.rootUnsubscribes) unsub()
    this.rootUnsubscribes.length = 0
    await this.router.stop()
    await this.runtime.stop()
  }

  async listSessions(): Promise<readonly SessionRef[]> {
    return this.router.listSessions()
  }

  async listEngines(): Promise<readonly EngineDescriptor[]> {
    return this.router.listEngines()
  }

  async createSession(options?: CreateSessionParams): Promise<SessionRef> {
    const ref = await this.router.createSession(options)
    this.activeSessions.add(ref.id)
    return ref
  }

  async getWorkspaceGitStatus(params: WorkspaceGitStatusParams): Promise<WorkspaceGitStatusResult> {
    return this.router.getWorkspaceGitStatus(params)
  }

  async getWorkspaceGitDiff(params: WorkspaceGitDiffParams): Promise<WorkspaceGitDiffResult> {
    return this.router.getWorkspaceGitDiff(params)
  }

  resetSessionStream(sessionId: string, reason = 'window-unavailable'): void {
    this.runtime.forgetSession(sessionId, reason)
  }

  async issuePairingDescriptor(options?: {
    readonly ttlMs?: number | undefined
    readonly allowedCapabilities?: readonly Capability[] | undefined
    readonly endpointUrl?: string | undefined
  }): Promise<PairingIssueResult> {
    const identity = await this.stores.hostIdentityStore.loadOrCreate()
    const endpointUrl = options?.endpointUrl ?? this.runtime.carrier.getEndpointUrl()
    if (!endpointUrl) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'LAN carrier endpoint is not running')
    }
    const token = this.tokenRegistry.createToken({
      trustDomainId: identity.identity.trustDomainId,
      hostGeneration: identity.identity.generation,
      ttlMs: options?.ttlMs ?? this.options.pairingTtlMs ?? MAX_PAIRING_TTL_MS,
      allowedCapabilities: options?.allowedCapabilities ?? DEFAULT_GRANTED_CAPABILITIES,
    })

    const relayUrl = this.options.relay?.relayUrl
    const relayRoomId = this.runtime.relay?.getRoomId()
    const signalingUrl = this.options.webrtc?.signalingUrl
    const signalingRoomId = this.options.webrtc?.roomId
    const stunUrls = this.options.webrtc?.ice?.stunUrls

    const descriptor = createPairingBootstrapDescriptor({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      hostPublicKey: identity.identity.publicKey,
      bootstrapToken: token.token,
      endpointUrl,
      expiresAt: token.expiresAt,
      ...(signalingUrl !== undefined ? { signalingUrl } : {}),
      ...(signalingRoomId !== undefined ? { signalingRoomId } : {}),
      ...(stunUrls !== undefined && stunUrls.length > 0 ? { stunUrls } : {}),
      ...(relayUrl !== undefined ? { relayUrl } : {}),
      ...(relayRoomId !== undefined ? { relayRoomId } : {}),
    })

    return {
      descriptor,
      pairingJson: JSON.stringify(descriptor),
      deepLink: encodePairingDeepLink(descriptor),
      tokenHash: token.tokenHash,
      expiresAt: token.expiresAt,
    }
  }

  async listTrustedDevices(): Promise<readonly DeviceRecord[]> {
    return this.stores.trustStore.list()
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    this.router.revokeDeviceUploads(deviceId)
    return this.stores.trustStore.revoke(deviceId)
  }

  async getStatus(): Promise<{
    readonly started: boolean
    readonly configDir: string
    readonly dshHome: string
    readonly hostFingerprint: string | undefined
    readonly lanEndpointUrl: string | undefined
    readonly relayRoomId: string | undefined
    readonly activeSessions: readonly string[]
    readonly trustedDevices: number
    readonly activeConnections: number
    readonly pendingApprovals: number
    readonly pendingQuestions: number
    readonly pendingPairingCandidates: number
    readonly engines: readonly EngineDescriptor[]
  }> {
    let hostFingerprint: string | undefined
    try {
      hostFingerprint = (await this.stores.hostIdentityStore.getPublicIdentity()).fingerprint
    } catch {
      hostFingerprint = undefined
    }
    const [devices, engines] = await Promise.all([
      this.stores.trustStore.list(),
      this.listEngines(),
    ])
    return {
      started: this.started && !this.stopped,
      configDir: this.stores.configDir,
      dshHome: this.dshHome,
      hostFingerprint,
      lanEndpointUrl: this.runtime.carrier.getEndpointUrl(),
      relayRoomId: this.runtime.relay?.getRoomId(),
      activeSessions: [...this.activeSessions],
      trustedDevices: devices.filter((d) => d.revokedAt === undefined).length,
      activeConnections: this.runtime.carrier.getActiveConnectionCount(),
      pendingApprovals: 0,
      pendingQuestions: 0,
      pendingPairingCandidates: this.pairingCoordinator.listPendingCandidates().length,
      engines,
    }
  }

  async createControlServer(options?: {
    readonly port?: number | undefined
    readonly controlToken?: string | undefined
    readonly onShutdown?: (() => Promise<void> | void) | undefined
  }): Promise<BridgeControlServerHandle> {
    return createBridgeControlServer(this, options)
  }
}
