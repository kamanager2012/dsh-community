import { randomBytes } from 'node:crypto'
import type { RTCPeerConnection } from 'werift'
import { RemoteCryptoError } from '../crypto/errors.js'
import { ConnectionEpochAllocator } from '../crypto/epoch.js'
import type { DeviceTrustStore } from '../crypto/device-trust.js'
import type { HostIdentityStore, HostKeyPair } from '../crypto/host-identity.js'
import type { PairingCoordinator } from '../crypto/pairing-coordinator.js'
import type { RemoteAdapterCore } from '../core.js'
import type { AuthenticatedPeer } from '../protocol.js'
import { validateLanCarrierBounds, type LanCarrierBounds } from './constants.js'
import { RemoteServerChannel, revokeDeviceChannels } from './remote-channel.js'
import { SignalingClient } from './signaling-client.js'
import type { RtcIceCandidatePayload, RtcSessionDescriptionPayload } from './signaling-server.js'
import {
  createConfiguredPeerConnection,
  DSH_WEBRTC_DATA_CHANNEL_LABEL,
  toRtcIceCandidateInit,
  validateSelfOwnedStunUrls,
  WebRtcServerDataChannelTransport,
  type WebRtcIceConfigOptions,
} from './webrtc-transport.js'

export interface HostWebRtcCarrierOptions {
  /** Explicitly enable the WebRTC P2P carrier. Default is false (fail closed). */
  readonly enabled?: boolean | undefined
  /** Self-owned WebSocket signaling endpoint URL (ws:// or wss://). */
  readonly signalingUrl: string
  /** Optional explicit signaling roomId (defaults to Host static key fingerprint). */
  readonly roomId?: string | undefined
  /** Optional host registration secret authenticated by the signaling server. */
  readonly hostAuthSecret?: string | undefined
  /** Optional room join token shared with authorized pairing/reconnect clients. */
  readonly joinToken?: string | undefined
  /** ICE & self-owned STUN server configuration. */
  readonly ice?: WebRtcIceConfigOptions | undefined
  /** Maximum time allowed for ICE + DataChannel opening per peer (default: 10s). */
  readonly iceConnectTimeoutMs?: number | undefined
  /** Periodic signaling keepalive interval in ms (default: 20_000; 0 disables). */
  readonly keepaliveIntervalMs?: number | undefined
  /** Automatically reconnect to signaling server after unexpected disconnect (default: true). */
  readonly reconnect?: boolean | undefined
  /** Initial reconnect backoff delay in ms (default: 500). */
  readonly reconnectMinDelayMs?: number | undefined
  /** Maximum reconnect backoff delay in ms (default: 15_000). */
  readonly reconnectMaxDelayMs?: number | undefined
  readonly core: RemoteAdapterCore
  readonly trustStore: DeviceTrustStore
  readonly hostIdentityStore: HostIdentityStore
  readonly pairingCoordinator?: PairingCoordinator | undefined
  readonly bounds?: Partial<LanCarrierBounds> | undefined
  readonly epochAllocator?: ConnectionEpochAllocator | undefined
}

const PREMATURE_END_OF_CANDIDATES_DELAY_MS = 250

interface HostPeerSession {
  readonly peerId: string
  readonly pc: RTCPeerConnection
  readonly remoteIceQueue: RtcIceCandidatePayload[]
  readonly localIceBuffer: (RtcIceCandidatePayload | null)[]
  remoteDescSet: boolean
  answerSent: boolean
  receivedRemoteCandidate: boolean
  pendingEndOfCandidates: boolean
  endOfCandidatesSent: boolean
  flushingRemoteIce: boolean
  channel: RemoteServerChannel | undefined
  iceTimer: NodeJS.Timeout | undefined
  endOfCandidatesTimer: NodeJS.Timeout | undefined
  closed: boolean
}

const MAX_ICE_QUEUE_ENTRIES = 64

/**
 * Host WebRTC P2P carrier connecting to self-owned Signaling + STUN,
 * binding opened DataChannels directly to the shared Noise IK + RemoteServerChannel engine.
 */
export class HostWebRtcCarrier {
  private readonly options: HostWebRtcCarrierOptions
  private readonly bounds: LanCarrierBounds
  private readonly epochAllocator: ConnectionEpochAllocator
  private readonly iceConnectTimeoutMs: number

  private hostKeyPair: HostKeyPair | undefined = undefined
  private signaling: SignalingClient | undefined = undefined
  private roomId: string | undefined = undefined
  private isRunning = false
  private shouldRun = false
  private lifecycleGeneration = 0
  private reconnectAttempt = 0
  private keepaliveTimer: NodeJS.Timeout | undefined = undefined
  private reconnectTimer: NodeJS.Timeout | undefined = undefined
  private unsubscribeRevocations: (() => void) | undefined = undefined
  private readonly peersBySignalingId = new Map<string, HostPeerSession>()
  private readonly activeChannels = new Map<string, RemoteServerChannel>()
  private readonly deviceChannels = new Map<string, Set<RemoteServerChannel>>()
  private readonly channelToPeer = new Map<RemoteServerChannel, HostPeerSession>()

  constructor(options: HostWebRtcCarrierOptions) {
    this.options = options
    this.bounds = validateLanCarrierBounds(options.bounds)
    this.epochAllocator = options.epochAllocator ?? new ConnectionEpochAllocator()
    this.iceConnectTimeoutMs = options.iceConnectTimeoutMs ?? 10_000
    validateSelfOwnedStunUrls(options.ice?.stunUrls)
  }

  isEnabled(): boolean {
    return this.options.enabled === true
  }

  isListening(): boolean {
    return this.isRunning && this.signaling !== undefined && this.signaling.isOpen()
  }

  getRoomId(): string | undefined {
    return this.roomId
  }

  getActiveConnectionCount(): number {
    return this.peersBySignalingId.size
  }

  async start(): Promise<void> {
    if (this.shouldRun || this.isRunning) return

    if (!this.isEnabled()) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'WebRTC carrier is disabled by default; options.enabled must be explicitly true',
      )
    }

    if (!/^wss?:\/\/[^\s]+$/i.test(this.options.signalingUrl ?? '')) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        `invalid signalingUrl '${String(this.options.signalingUrl)}'`,
      )
    }

    const gen = ++this.lifecycleGeneration
    this.shouldRun = true
    this.reconnectAttempt = 0

    try {
      this.hostKeyPair = await this.options.hostIdentityStore.loadOrCreate()
      this.roomId = this.options.roomId ?? this.hostKeyPair.identity.fingerprint

      const signaling = this.createConfiguredSignalingClient(gen)
      this.signaling = signaling

      await signaling.registerHost({
        roomId: this.roomId,
        hostAuthSecret: this.options.hostAuthSecret,
        joinToken: this.options.joinToken,
        timeoutMs: this.bounds.handshakeTimeoutMs,
      })

      if (!this.shouldRun || gen !== this.lifecycleGeneration) {
        signaling.close()
        return
      }

      this.isRunning = true
      this.startKeepalive()

      this.unsubscribeRevocations = this.options.trustStore.subscribeRevocations((event) => {
        this.handleRevocation(event.deviceId)
      })
    } catch (err) {
      await this.stop()
      throw err
    }
  }

  private createConfiguredSignalingClient(gen: number): SignalingClient {
    const signaling = new SignalingClient(this.options.signalingUrl)
    signaling.setHandlers({
      onOffer: (msg) => {
        void this.handleOffer(msg.fromPeerId, msg.sdp)
      },
      onIceCandidate: (msg) => {
        this.handleRemoteIce(msg.fromPeerId, msg.candidate)
      },
      onPeerLeft: (peerId) => {
        const entry = this.peersBySignalingId.get(peerId)
        if (entry && !entry.channel) {
          this.teardownPeerSession(entry, 1001, 'peer left signaling before datachannel opened')
        }
      },
      onClose: () => {
        if (this.signaling !== signaling) return
        this.clearKeepalive()
        this.signaling = undefined
        for (const entry of Array.from(this.peersBySignalingId.values())) {
          if (!entry.channel) {
            this.teardownPeerSession(entry, 1001, 'signaling closed before datachannel opened')
          }
        }
        if (this.shouldRun && gen === this.lifecycleGeneration && (this.options.reconnect ?? true)) {
          this.scheduleReconnect(gen)
        }
      },
    })
    return signaling
  }

  private clearKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = undefined
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
  }

  private startKeepalive(): void {
    this.clearKeepalive()
    const intervalMs = this.options.keepaliveIntervalMs ?? 20_000
    if (intervalMs <= 0 || !Number.isFinite(intervalMs)) return
    this.keepaliveTimer = setInterval(() => {
      if (!this.shouldRun || !this.signaling?.isOpen()) return
      try {
        this.signaling.sendPing()
      } catch {}
    }, intervalMs)
    this.keepaliveTimer.unref?.()
  }

  private scheduleReconnect(gen: number): void {
    this.clearReconnect()
    if (!this.shouldRun || gen !== this.lifecycleGeneration) return
    const minDelayMs = Math.max(25, this.options.reconnectMinDelayMs ?? 500)
    const maxDelayMs = Math.max(minDelayMs, this.options.reconnectMaxDelayMs ?? 15_000)
    const delayMs = Math.min(maxDelayMs, minDelayMs * 2 ** Math.min(this.reconnectAttempt, 6))
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.attemptReconnect(gen)
    }, delayMs)
    this.reconnectTimer.unref?.()
  }

  private async attemptReconnect(gen: number): Promise<void> {
    if (!this.shouldRun || gen !== this.lifecycleGeneration || !this.roomId) return
    const signaling = this.createConfiguredSignalingClient(gen)
    this.signaling = signaling

    try {
      await signaling.registerHost({
        roomId: this.roomId,
        hostAuthSecret: this.options.hostAuthSecret,
        joinToken: this.options.joinToken,
        timeoutMs: this.bounds.handshakeTimeoutMs,
      })
    } catch {
      if (this.signaling === signaling) {
        this.signaling = undefined
      }
      signaling.close()
      if (this.shouldRun && gen === this.lifecycleGeneration) {
        this.scheduleReconnect(gen)
      }
      return
    }

    if (!this.shouldRun || gen !== this.lifecycleGeneration || this.signaling !== signaling) {
      signaling.close()
      return
    }

    this.reconnectAttempt = 0
    this.isRunning = true
    this.startKeepalive()
  }

  private async handleOffer(
    fromPeerId: string,
    sdp: RtcSessionDescriptionPayload,
  ): Promise<void> {
    if (!this.isRunning || !this.hostKeyPair || !this.signaling) return
    if (this.peersBySignalingId.has(fromPeerId)) {
      return
    }
    if (this.peersBySignalingId.size >= this.bounds.maxConcurrentConnections) {
      return
    }

    const pc = createConfiguredPeerConnection(this.options.ice)
    const entry: HostPeerSession = {
      peerId: fromPeerId,
      pc,
      remoteIceQueue: [],
      localIceBuffer: [],
      remoteDescSet: false,
      answerSent: false,
      receivedRemoteCandidate: false,
      pendingEndOfCandidates: false,
      endOfCandidatesSent: false,
      flushingRemoteIce: false,
      channel: undefined,
      iceTimer: undefined,
      endOfCandidatesTimer: undefined,
      closed: false,
    }
    this.peersBySignalingId.set(fromPeerId, entry)

    entry.iceTimer = setTimeout(() => {
      if (!entry.channel && !entry.closed) {
        this.teardownPeerSession(entry, 1008, 'WebRTC ICE / DataChannel timeout')
      }
    }, this.iceConnectTimeoutMs)

    pc.onicecandidate = ({ candidate }) => {
      if (entry.closed || !this.signaling?.isOpen()) return
      const payload: RtcIceCandidatePayload | null = candidate ? candidate.toJSON() : null
      if (!entry.answerSent) {
        if (entry.localIceBuffer.length < MAX_ICE_QUEUE_ENTRIES) {
          entry.localIceBuffer.push(payload)
        }
        return
      }
      try {
        this.signaling.sendIceCandidate(fromPeerId, payload)
      } catch {}
    }

    pc.ondatachannel = ({ channel }) => {
      if (entry.closed) {
        try {
          channel.close()
        } catch {}
        return
      }
      if (channel.label !== DSH_WEBRTC_DATA_CHANNEL_LABEL || entry.channel !== undefined) {
        this.teardownPeerSession(entry, 1008, 'unexpected DataChannel label')
        return
      }

      const attachOpenChannel = () => {
        if (entry.closed || entry.channel !== undefined || !this.hostKeyPair) return
        this.clearPeerTimers(entry)

        const transport = new WebRtcServerDataChannelTransport(
          pc,
          channel,
          this.bounds.maxFrameBytes,
        )
        const channelId = randomBytes(16).toString('hex')
        const serverChannel = new RemoteServerChannel(
          transport,
          {
            core: this.options.core,
            trustStore: this.options.trustStore,
            hostIdentityStore: this.options.hostIdentityStore,
            hostKeyPair: this.hostKeyPair,
            epochAllocator: this.epochAllocator,
            pairingCoordinator: this.options.pairingCoordinator,
            bounds: this.bounds,
            onPeerAuthenticated: (peer: AuthenticatedPeer, ch: RemoteServerChannel) => {
              let set = this.deviceChannels.get(peer.deviceId)
              if (!set) {
                set = new Set()
                this.deviceChannels.set(peer.deviceId, set)
              }
              set.add(ch)
            },
            onClosed: (ch: RemoteServerChannel) => {
              this.removeChannel(ch)
            },
          },
          channelId,
        )

        entry.channel = serverChannel
        this.activeChannels.set(channelId, serverChannel)
        this.channelToPeer.set(serverChannel, entry)
      }

      if (channel.readyState === 'open') {
        attachOpenChannel()
      } else {
        channel.onopen = attachOpenChannel
      }
    }

    pc.connectionStateChange.subscribe((state) => {
      if ((state === 'failed' || state === 'closed') && !entry.closed) {
        this.teardownPeerSession(entry, 1001, `WebRTC peer connection ${state}`)
      }
    })

    try {
      await pc.setRemoteDescription(sdp)
      entry.remoteDescSet = true
      await this.flushRemoteIce(entry)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      if (entry.closed || !this.signaling?.isOpen()) return
      this.signaling.sendAnswer(fromPeerId, { type: 'answer', sdp: answer.sdp })
      entry.answerSent = true
      for (const localCand of entry.localIceBuffer) {
        try {
          this.signaling.sendIceCandidate(fromPeerId, localCand)
        } catch {}
      }
      entry.localIceBuffer.length = 0
    } catch {
      this.teardownPeerSession(entry, 1008, 'failed WebRTC SDP negotiation')
    }
  }

  private clearPeerTimers(entry: HostPeerSession): void {
    if (entry.iceTimer) {
      clearTimeout(entry.iceTimer)
      entry.iceTimer = undefined
    }
    if (entry.endOfCandidatesTimer) {
      clearTimeout(entry.endOfCandidatesTimer)
      entry.endOfCandidatesTimer = undefined
    }
  }

  private scheduleEndOfCandidatesFlush(entry: HostPeerSession): void {
    if (entry.endOfCandidatesTimer) {
      clearTimeout(entry.endOfCandidatesTimer)
      entry.endOfCandidatesTimer = undefined
    }
    // Hold premature null so werift does not discard candidates arriving slightly later
    // (for example on Android libwebrtc builds firing COMPLETE before onIceCandidate).
    entry.endOfCandidatesTimer = setTimeout(() => {
      entry.endOfCandidatesTimer = undefined
      if (entry.closed || entry.channel !== undefined) return
      if (entry.remoteDescSet) {
        void this.flushRemoteIce(entry)
      }
    }, PREMATURE_END_OF_CANDIDATES_DELAY_MS)
    entry.endOfCandidatesTimer.unref?.()
  }

  private handleRemoteIce(fromPeerId: string, candidate: RtcIceCandidatePayload | null): void {
    const entry = this.peersBySignalingId.get(fromPeerId)
    if (!entry || entry.closed) return
    if (candidate === null) {
      if (entry.endOfCandidatesSent) return
      entry.pendingEndOfCandidates = true
      if (!entry.receivedRemoteCandidate) {
        if (!entry.endOfCandidatesTimer) {
          this.scheduleEndOfCandidatesFlush(entry)
        }
        return
      }
      if (entry.remoteDescSet && !entry.endOfCandidatesTimer) {
        void this.flushRemoteIce(entry)
      }
      return
    }
    if (entry.remoteIceQueue.length >= MAX_ICE_QUEUE_ENTRIES) {
      this.teardownPeerSession(entry, 1009, 'ICE candidate queue limit exceeded')
      return
    }
    entry.receivedRemoteCandidate = true
    entry.remoteIceQueue.push(candidate)
    if (entry.pendingEndOfCandidates && !entry.endOfCandidatesSent) {
      this.scheduleEndOfCandidatesFlush(entry)
    }
    if (entry.remoteDescSet) {
      void this.flushRemoteIce(entry)
    }
  }

  private async flushRemoteIce(entry: HostPeerSession): Promise<void> {
    if (entry.flushingRemoteIce) return
    entry.flushingRemoteIce = true
    try {
      while (!entry.closed) {
        if (entry.remoteIceQueue.length > 0) {
          const next = entry.remoteIceQueue.shift()!
          try {
            await entry.pc.addIceCandidate(toRtcIceCandidateInit(next))
          } catch {}
          continue
        }
        if (entry.pendingEndOfCandidates && !entry.endOfCandidatesTimer) {
          entry.pendingEndOfCandidates = false
          if (!entry.endOfCandidatesSent) {
            entry.endOfCandidatesSent = true
            try {
              await entry.pc.addIceCandidate(toRtcIceCandidateInit(null))
            } catch {}
          }
          continue
        }
        break
      }
    } finally {
      entry.flushingRemoteIce = false
    }
  }

  private teardownPeerSession(entry: HostPeerSession, code: number, reason: string): void {
    if (entry.closed) return
    entry.closed = true
    this.clearPeerTimers(entry)
    this.peersBySignalingId.delete(entry.peerId)
    if (entry.channel) {
      const ch = entry.channel
      entry.channel = undefined
      ch.terminate(code, reason)
    }
    try {
      void entry.pc.close()
    } catch {}
  }

  private removeChannel(ch: RemoteServerChannel): void {
    this.activeChannels.delete(ch.id)
    const peer = ch.getPeer()
    if (peer) {
      const set = this.deviceChannels.get(peer.deviceId)
      if (set) {
        set.delete(ch)
        if (set.size === 0) {
          this.deviceChannels.delete(peer.deviceId)
        }
      }
    }
    const entry = this.channelToPeer.get(ch)
    if (entry) {
      this.channelToPeer.delete(ch)
      entry.channel = undefined
      this.teardownPeerSession(entry, 1000, 'channel closed')
    }
  }

  private handleRevocation(deviceId: string): void {
    revokeDeviceChannels(this.deviceChannels, deviceId, 'device revoked', 1008)
  }

  broadcastEvent(event: unknown): void {
    for (const ch of this.activeChannels.values()) {
      if (ch.getState() === 'ACTIVE') {
        try {
          ch.sendEvent(event)
        } catch {}
      }
    }
  }

  async stop(): Promise<void> {
    this.lifecycleGeneration += 1
    this.shouldRun = false
    this.isRunning = false
    this.clearKeepalive()
    this.clearReconnect()

    if (this.unsubscribeRevocations) {
      try {
        this.unsubscribeRevocations()
      } catch {}
      this.unsubscribeRevocations = undefined
    }

    for (const entry of Array.from(this.peersBySignalingId.values())) {
      this.teardownPeerSession(entry, 1001, 'host shutting down')
    }
    this.peersBySignalingId.clear()
    this.activeChannels.clear()
    this.deviceChannels.clear()
    this.channelToPeer.clear()

    if (this.signaling) {
      this.signaling.close()
      this.signaling = undefined
    }
  }
}
