import { RemoteCryptoError } from '../crypto/errors.js'
import type { NoiseInitiatorSession } from '../crypto/noise.js'
import { RemoteProtocolError } from '../errors.js'
import { createLanTransport } from './lan-client.js'
import { createRelayTransport, type RelayClientCarrierOptions } from './relay-client.js'
import { isRevocationError, RemoteClientSession } from './remote-client-session.js'
import {
  defaultSleep,
  reconnectDelayMs,
  resolveReconnectPolicy,
  type FramedClientTransport,
  type ReconnectBackoffPolicy,
  type RemoteTransportKind,
} from './transport.js'
import {
  createWebRtcTransport,
  type WebRtcClientCarrierOptions,
  type WebRtcTransportHandles,
} from './webrtc-client.js'
import {
  getSelectedIceCandidatePair,
  validateSelfOwnedStunUrls,
  type SelectedIceCandidatePairInfo,
} from './webrtc-transport.js'

export const DEFAULT_FAILOVER_PRIORITY: readonly RemoteTransportKind[] = Object.freeze([
  'lan',
  'webrtc',
  'relay',
])

export interface FailoverLanPathConfig {
  readonly endpointUrl: string
}

export type FailoverWebRtcPathConfig = Omit<
  WebRtcClientCarrierOptions,
  'clientKeyPair' | 'hostPublicKey' | 'handshakeTimeoutMs' | 'requestTimeoutMs' | 'sleep'
>

export type FailoverRelayPathConfig = Omit<
  RelayClientCarrierOptions,
  'clientKeyPair' | 'hostPublicKey' | 'handshakeTimeoutMs' | 'requestTimeoutMs' | 'sleep'
>

export interface FailoverRemoteClientOptions {
  readonly clientKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array }
  readonly hostPublicKey: Uint8Array
  /** Ordered transport fallback priority. Defaults to ['lan', 'webrtc', 'relay']. */
  readonly priorityOrder?: readonly RemoteTransportKind[] | undefined
  readonly lan?: FailoverLanPathConfig | undefined
  readonly webrtc?: FailoverWebRtcPathConfig | undefined
  readonly relay?: FailoverRelayPathConfig | undefined
  readonly handshakeTimeoutMs?: number | undefined
  readonly requestTimeoutMs?: number | undefined
  readonly sleep?: ((delayMs: number) => Promise<void>) | undefined
}

export interface FailoverAttemptRecord {
  readonly kind: RemoteTransportKind
  readonly status: 'connected' | 'failed'
  readonly error?: string | undefined
  readonly timestampMs: number
}

/**
 * Multi-path Remote Client wrapping ONE RemoteClientSession across ordered carriers:
 * Direct LAN -> WebRTC P2P -> Blind Relay.
 *
 * Preserves one Noise IK client identity, monotonic connectionEpoch checks,
 * session.attach resume cursors, and idempotency keys across carrier failovers.
 */
export class FailoverRemoteClient {
  readonly deviceId: string
  private readonly options: FailoverRemoteClientOptions
  private readonly session: RemoteClientSession
  private readonly orderedCandidates: readonly {
    readonly kind: RemoteTransportKind
    readonly createTransport: () => FramedClientTransport
  }[]

  private activeKind: RemoteTransportKind | undefined = undefined
  private lastConnectedKind: RemoteTransportKind | undefined = undefined
  private webrtcHandles: WebRtcTransportHandles = {
    pc: undefined,
    dc: undefined,
    signaling: undefined,
  }
  private relayConnIdHex: string | undefined = undefined
  private readonly history: FailoverAttemptRecord[] = []

  constructor(options: FailoverRemoteClientOptions) {
    this.options = options
    if (options.webrtc?.ice?.stunUrls) {
      validateSelfOwnedStunUrls(options.webrtc.ice.stunUrls)
    }

    const order = options.priorityOrder ?? DEFAULT_FAILOVER_PRIORITY
    const seen = new Set<RemoteTransportKind>()
    const candidates: {
      readonly kind: RemoteTransportKind
      readonly createTransport: () => FramedClientTransport
    }[] = []

    for (const kind of order) {
      if (kind !== 'lan' && kind !== 'webrtc' && kind !== 'relay') {
        throw new RemoteProtocolError('INVALID_REQUEST', `unknown failover transport '${String(kind)}'`)
      }
      if (seen.has(kind)) continue
      seen.add(kind)

      if (kind === 'lan' && options.lan) {
        const endpointUrl = options.lan.endpointUrl
        candidates.push({
          kind: 'lan',
          createTransport: () => {
            this.webrtcHandles = { pc: undefined, dc: undefined, signaling: undefined }
            this.relayConnIdHex = undefined
            return createLanTransport(endpointUrl)
          },
        })
      } else if (kind === 'webrtc' && options.webrtc) {
        const webrtcConfig = options.webrtc
        candidates.push({
          kind: 'webrtc',
          createTransport: () => {
            this.relayConnIdHex = undefined
            return createWebRtcTransport(
              {
                ...webrtcConfig,
                hostPublicKey: options.hostPublicKey,
                ...(options.handshakeTimeoutMs !== undefined
                  ? { handshakeTimeoutMs: options.handshakeTimeoutMs }
                  : {}),
              },
              (handles) => {
                this.webrtcHandles = handles
              },
            )
          },
        })
      } else if (kind === 'relay' && options.relay) {
        const relayConfig = options.relay
        candidates.push({
          kind: 'relay',
          createTransport: () => {
            this.webrtcHandles = { pc: undefined, dc: undefined, signaling: undefined }
            return createRelayTransport(
              {
                ...relayConfig,
                hostPublicKey: options.hostPublicKey,
              },
              (handles) => {
                this.relayConnIdHex = handles.connIdHex
              },
            )
          },
        })
      }
    }

    if (candidates.length === 0) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'FailoverRemoteClient requires at least one configured transport path',
      )
    }

    this.orderedCandidates = Object.freeze(candidates)
    this.session = new RemoteClientSession(options)
    this.deviceId = this.session.deviceId
  }

  getAvailableTransports(): readonly RemoteTransportKind[] {
    return this.orderedCandidates.map((c) => c.kind)
  }

  getActiveTransportKind(): RemoteTransportKind | undefined {
    return this.session.isOpen() ? this.activeKind : undefined
  }

  getLastConnectedTransportKind(): RemoteTransportKind | undefined {
    return this.lastConnectedKind
  }

  getFailoverHistory(): readonly FailoverAttemptRecord[] {
    return Object.freeze([...this.history])
  }

  getRelayConnIdHex(): string | undefined {
    return this.relayConnIdHex
  }

  getIceDiagnostics():
    | {
        readonly connectionState: string
        readonly iceConnectionState: string
        readonly selectedPair: SelectedIceCandidatePairInfo | undefined
      }
    | undefined {
    const pc = this.webrtcHandles.pc
    if (!pc) return undefined
    return {
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      selectedPair: getSelectedIceCandidatePair(pc),
    }
  }

  getNoiseSession(): NoiseInitiatorSession | undefined {
    return this.session.getNoiseSession()
  }

  getSession(): RemoteClientSession {
    return this.session
  }

  getConnectionEpoch(): number {
    return this.session.getConnectionEpoch()
  }

  getLastConfirmedSeq(sessionId: string): number | undefined {
    return this.session.getLastConfirmedSeq(sessionId)
  }

  isOpen(): boolean {
    return this.session.isOpen()
  }

  isRevoked(): boolean {
    return this.session.isRevoked()
  }

  private async connectSingleOrderedPass(): Promise<void> {
    if (this.session.isOpen()) return
    let lastError: Error | undefined

    for (const candidate of this.orderedCandidates) {
      try {
        await this.session.connectWithTransport(() => candidate.createTransport())
        this.activeKind = candidate.kind
        this.lastConnectedKind = candidate.kind
        this.history.push(
          Object.freeze({
            kind: candidate.kind,
            status: 'connected',
            timestampMs: Date.now(),
          }),
        )
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        lastError = error instanceof Error ? error : new Error(message)
        this.history.push(
          Object.freeze({
            kind: candidate.kind,
            status: 'failed',
            error: message,
            timestampMs: Date.now(),
          }),
        )
        this.session.close()
        if (this.session.isRevoked() || isRevocationError(error)) {
          throw lastError
        }
      }
    }

    throw (
      lastError ??
      new RemoteCryptoError('HANDSHAKE_FAILED', 'all failover transport paths failed')
    )
  }

  async connect(): Promise<void> {
    await this.connectSingleOrderedPass()
  }

  async reconnectWithBackoff(policy?: ReconnectBackoffPolicy): Promise<void> {
    if (this.session.isOpen()) return
    const resolved = resolveReconnectPolicy(policy)
    const sleep = this.options.sleep ?? defaultSleep
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= resolved.maxAttempts; attempt += 1) {
      if (attempt > 1) {
        await sleep(reconnectDelayMs(attempt - 1, resolved))
      }
      try {
        await this.connectSingleOrderedPass()
        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        this.session.close()
        if (this.session.isRevoked() || isRevocationError(error)) {
          throw lastError
        }
      }
    }

    throw (
      lastError ??
      new RemoteCryptoError('HANDSHAKE_FAILED', 'failover reconnect attempts exhausted')
    )
  }

  async resumeSession(sessionId: string): Promise<any> {
    return this.session.resumeSession(sessionId)
  }

  async acknowledgeSessionSeq(sessionId: string, seq: number): Promise<any> {
    return this.session.acknowledgeSessionSeq(sessionId, seq)
  }

  async reconnectAndResume(
    sessionIds: readonly string[],
    policy?: ReconnectBackoffPolicy,
  ): Promise<Readonly<Record<string, unknown>>> {
    const resolved = resolveReconnectPolicy(policy)
    const sleep = this.options.sleep ?? defaultSleep
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= resolved.maxAttempts; attempt += 1) {
      if (attempt > 1) {
        await sleep(reconnectDelayMs(attempt - 1, resolved))
      }
      try {
        await this.connectSingleOrderedPass()
        const results: Record<string, unknown> = {}
        for (const sessionId of new Set(sessionIds)) {
          results[sessionId] = await this.session.resumeSession(sessionId)
        }
        return Object.freeze(results)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        this.session.close()
        if (this.session.isRevoked() || isRevocationError(error)) {
          throw lastError
        }
      }
    }

    throw (
      lastError ??
      new RemoteCryptoError('HANDSHAKE_FAILED', 'failover reconnect-and-resume attempts exhausted')
    )
  }

  clearResumeState(sessionId?: string): void {
    this.session.clearResumeState(sessionId)
  }

  onEvent(listener: (event: unknown) => void): () => void {
    return this.session.onEvent(listener)
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    options?: {
      customId?: string | number
      idempotencyKey?: string
      requestSeq?: number
      connectionEpoch?: number
    },
  ): Promise<any> {
    return this.session.request(method, params, options)
  }

  close(): void {
    this.activeKind = undefined
    this.webrtcHandles = { pc: undefined, dc: undefined, signaling: undefined }
    this.relayConnIdHex = undefined
    this.session.close()
  }
}
