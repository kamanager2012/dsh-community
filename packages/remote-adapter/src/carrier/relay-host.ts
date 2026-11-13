import { randomBytes } from 'node:crypto'
import { RemoteCryptoError } from '../crypto/errors.js'
import { ConnectionEpochAllocator } from '../crypto/epoch.js'
import type { DeviceTrustStore } from '../crypto/device-trust.js'
import type { HostIdentityStore, HostKeyPair } from '../crypto/host-identity.js'
import type { PairingCoordinator } from '../crypto/pairing-coordinator.js'
import type { RemoteAdapterCore } from '../core.js'
import type { AuthenticatedPeer } from '../protocol.js'
import { validateLanCarrierBounds, type LanCarrierBounds } from './constants.js'
import {
  RELAY_CONN_ID_BYTES,
  RELAY_DATA_HEADER_BYTES,
  RELAY_FRAME_CONTROL,
  RELAY_FRAME_DATA,
} from './relay-server.js'
import { RemoteServerChannel } from './remote-channel.js'
import {
  normalizeBinaryPayload,
  type FramedMessageTransport,
  type FramedMessageTransportHandlers,
} from './transport.js'

const ROOM_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/
const CONN_ID_HEX_RE = /^[0-9a-f]{32}$/
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export interface HostRelayCarrierOptions {
  /** Explicitly enable the blind relay carrier. Default is false (fail closed). */
  readonly enabled?: boolean | undefined
  /** Self/community-owned Blind Relay WebSocket URL (ws:// or wss://). */
  readonly relayUrl: string
  /** Optional relay room identifier (defaults to Host static key fingerprint). */
  readonly roomId?: string | undefined
  /** Optional host registration secret authenticated by the blind relay. */
  readonly hostAuthSecret?: string | undefined
  /** Optional client admission token verified by the blind relay before forwarding. */
  readonly clientToken?: string | undefined
  /** Relay room registration timeout in ms (default: handshakeTimeoutMs). */
  readonly registerTimeoutMs?: number | undefined
  readonly core: RemoteAdapterCore
  readonly trustStore: DeviceTrustStore
  readonly hostIdentityStore: HostIdentityStore
  readonly pairingCoordinator?: PairingCoordinator | undefined
  readonly bounds?: Partial<LanCarrierBounds> | undefined
  readonly epochAllocator?: ConnectionEpochAllocator | undefined
}

interface RelayVirtualTransportDelegate {
  isParentWsOpen(): boolean
  getParentWsBufferedBytes(): number
  sendRelayDataFrame(connIdBytes: Buffer, payload: Uint8Array): void
  kickRelayPeer(connIdHex: string): void
  onVirtualClosed(connIdHex: string): void
}

/**
 * Adapts a virtual connId multiplexed inside the Host's BlindRelayServer WebSocket
 * into a FramedMessageTransport consumed by RemoteServerChannel.
 */
class RelayVirtualServerTransport implements FramedMessageTransport {
  readonly kind = 'relay' as const
  private handlers: FramedMessageTransportHandlers | undefined = undefined
  private closed = false

  constructor(
    readonly connIdHex: string,
    readonly connIdBytes: Buffer,
    private readonly delegate: RelayVirtualTransportDelegate,
  ) {}

  isWritable(): boolean {
    return !this.closed && this.delegate.isParentWsOpen()
  }

  getBufferedBytes(): number {
    return this.delegate.getParentWsBufferedBytes()
  }

  send(payload: Uint8Array, onFlushed?: () => void): void {
    if (!this.isWritable()) {
      throw new RemoteCryptoError('HANDSHAKE_STATE_INVALID', 'relay host transport is not open')
    }
    this.delegate.sendRelayDataFrame(this.connIdBytes, payload)
    onFlushed?.()
  }

  deliverPayload(payload: Uint8Array): void {
    if (this.closed) return
    this.handlers?.onMessage(payload)
  }

  markRemoteClosed(): void {
    if (this.closed) return
    this.closed = true
    this.delegate.onVirtualClosed(this.connIdHex)
    this.handlers?.onClose()
  }

  close(_code?: number, _reason?: string): void {
    const wasClosed = this.closed
    this.closed = true
    this.delegate.onVirtualClosed(this.connIdHex)
    if (!wasClosed) {
      this.delegate.kickRelayPeer(this.connIdHex)
      this.handlers?.onClose()
    }
  }

  setHandlers(handlers: FramedMessageTransportHandlers): void {
    this.handlers = handlers
  }
}

interface RelayPeerEntry {
  readonly connIdHex: string
  readonly transport: RelayVirtualServerTransport
  readonly channel: RemoteServerChannel
}

/**
 * Host blind relay carrier. Registers one outbound WebSocket with a BlindRelayServer
 * and multiplexes each remote client connId onto its own Noise IK RemoteServerChannel.
 *
 * The relay receives strictly Noise ciphertext payloads + opaque routing connIds,
 * never learning device identities, pairing tokens, session IDs, or prompts.
 */
export class HostRelayCarrier {
  private readonly options: HostRelayCarrierOptions
  private readonly bounds: LanCarrierBounds
  private readonly epochAllocator: ConnectionEpochAllocator

  private hostKeyPair: HostKeyPair | undefined = undefined
  private ws: WebSocket | undefined = undefined
  private roomId: string | undefined = undefined
  private isRunning = false
  private unsubscribeRevocations: (() => void) | undefined = undefined
  private readonly peersByConnId = new Map<string, RelayPeerEntry>()
  private readonly activeChannels = new Map<string, RemoteServerChannel>()
  private readonly deviceChannels = new Map<string, Set<RemoteServerChannel>>()
  private readonly channelToConnId = new Map<RemoteServerChannel, string>()

  constructor(options: HostRelayCarrierOptions) {
    this.options = options
    this.bounds = validateLanCarrierBounds(options.bounds)
    this.epochAllocator = options.epochAllocator ?? new ConnectionEpochAllocator()
  }

  isEnabled(): boolean {
    return this.options.enabled === true
  }

  isListening(): boolean {
    return this.isRunning && this.ws !== undefined && this.ws.readyState === WebSocket.OPEN
  }

  getRoomId(): string | undefined {
    return this.roomId
  }

  getActiveConnectionCount(): number {
    return this.peersByConnId.size
  }

  async start(): Promise<void> {
    if (this.isRunning) return

    if (!this.isEnabled()) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'Blind relay carrier is disabled by default; options.enabled must be explicitly true',
      )
    }

    if (!/^wss?:\/\/[^\s]+$/i.test(this.options.relayUrl ?? '')) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        `invalid relayUrl '${String(this.options.relayUrl)}'`,
      )
    }

    try {
      this.hostKeyPair = await this.options.hostIdentityStore.loadOrCreate()
      const roomId = this.options.roomId ?? this.hostKeyPair.identity.fingerprint
      if (!ROOM_ID_RE.test(roomId)) {
        throw new RemoteCryptoError('HANDSHAKE_FAILED', `invalid relay roomId '${roomId}'`)
      }
      this.roomId = roomId

      const ws = new WebSocket(this.options.relayUrl)
      ws.binaryType = 'arraybuffer'
      this.ws = ws

      const timeoutMs = this.options.registerTimeoutMs ?? this.bounds.handshakeTimeoutMs
      await this.registerHostSocket(ws, roomId, timeoutMs)

      this.isRunning = true
      this.installActiveHandlers(ws)
      this.unsubscribeRevocations = this.options.trustStore.subscribeRevocations((event) => {
        this.handleRevocation(event.deviceId)
      })
    } catch (err) {
      await this.stop()
      throw err
    }
  }

  private registerHostSocket(ws: WebSocket, roomId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false

      const finishFailure = (err: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        try {
          ws.close()
        } catch {}
        reject(err)
      }

      const timer = setTimeout(() => {
        finishFailure(new RemoteCryptoError('HANDSHAKE_FAILED', 'blind relay host registration timeout'))
      }, timeoutMs)

      ws.onopen = () => {
        try {
          ws.send(
            textEncoder.encode(
              JSON.stringify({
                v: 1,
                type: 'relay.host.register',
                roomId,
                ...(this.options.hostAuthSecret !== undefined
                  ? { hostAuthSecret: this.options.hostAuthSecret }
                  : {}),
                ...(this.options.clientToken !== undefined
                  ? { clientToken: this.options.clientToken }
                  : {}),
              }),
            ),
          )
        } catch (err) {
          finishFailure(err instanceof Error ? err : new Error(String(err)))
        }
      }

      ws.onmessage = (event: MessageEvent) => {
        let controlMsg: Record<string, unknown> | undefined
        try {
          if (typeof event.data === 'string') {
            controlMsg = JSON.parse(event.data) as Record<string, unknown>
          } else {
            const bytes = normalizeBinaryPayload(event.data)
            if (bytes.byteLength >= 2 && bytes[0] === RELAY_FRAME_CONTROL) {
              controlMsg = JSON.parse(textDecoder.decode(bytes.subarray(1))) as Record<
                string,
                unknown
              >
            }
          }
        } catch (err) {
          finishFailure(err instanceof Error ? err : new Error(String(err)))
          return
        }

        if (!controlMsg) return
        if (controlMsg.type === 'error') {
          finishFailure(
            new RemoteCryptoError(
              'HANDSHAKE_FAILED',
              `blind relay registration failed: ${String(controlMsg.code ?? 'ERROR')} ${String(controlMsg.message ?? '')}`,
            ),
          )
          return
        }
        if (controlMsg.type === 'relay.host.registered' && controlMsg.roomId === roomId) {
          settled = true
          clearTimeout(timer)
          resolve()
        }
      }

      ws.onerror = () => {
        finishFailure(new RemoteCryptoError('HANDSHAKE_FAILED', 'blind relay host WebSocket error'))
      }

      ws.onclose = (evt) => {
        finishFailure(
          new RemoteCryptoError(
            'HANDSHAKE_FAILED',
            `blind relay host closed during registration (${evt.code}: ${evt.reason || 'closed'})`,
          ),
        )
      }
    })
  }

  private installActiveHandlers(ws: WebSocket): void {
    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws || !this.isRunning) return
      if (typeof event.data === 'string') {
        return
      }
      let bytes: Uint8Array
      try {
        bytes = normalizeBinaryPayload(event.data)
      } catch {
        return
      }
      if (bytes.byteLength < 1) return

      const tag = bytes[0]
      if (tag === RELAY_FRAME_DATA) {
        if (bytes.byteLength < RELAY_DATA_HEADER_BYTES) return
        const connIdHex = Buffer.from(bytes.subarray(1, RELAY_DATA_HEADER_BYTES)).toString('hex')
        const entry = this.peersByConnId.get(connIdHex)
        if (!entry) return
        const payload = bytes.subarray(RELAY_DATA_HEADER_BYTES)
        if (payload.byteLength > this.bounds.maxFrameBytes) {
          entry.channel.terminate(1009, 'relay opaque payload exceeds maxFrameBytes')
          return
        }
        entry.transport.deliverPayload(payload)
        return
      }

      if (tag === RELAY_FRAME_CONTROL) {
        try {
          const parsed = JSON.parse(textDecoder.decode(bytes.subarray(1))) as Record<string, unknown>
          this.handleRelayControl(parsed)
        } catch {}
      }
    }

    ws.onerror = () => {}

    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = undefined
      this.isRunning = false
      for (const entry of Array.from(this.peersByConnId.values())) {
        entry.transport.markRemoteClosed()
      }
      this.peersByConnId.clear()
      this.activeChannels.clear()
      this.deviceChannels.clear()
      this.channelToConnId.clear()
    }
  }

  private handleRelayControl(msg: Record<string, unknown>): void {
    if (msg.v !== 1 || typeof msg.type !== 'string') return

    if (msg.type === 'relay.peer.joined') {
      const connIdHex = typeof msg.connIdHex === 'string' ? msg.connIdHex : ''
      if (!CONN_ID_HEX_RE.test(connIdHex) || !this.hostKeyPair) return
      if (this.peersByConnId.has(connIdHex)) return
      if (this.peersByConnId.size >= this.bounds.maxConcurrentConnections) {
        this.sendControlFrame({ v: 1, type: 'relay.peer.kick', connIdHex })
        return
      }

      const connIdBytes = Buffer.from(connIdHex, 'hex')
      if (connIdBytes.byteLength !== RELAY_CONN_ID_BYTES) return

      const transport = new RelayVirtualServerTransport(connIdHex, connIdBytes, {
        isParentWsOpen: () => this.ws !== undefined && this.ws.readyState === WebSocket.OPEN,
        getParentWsBufferedBytes: () => this.ws?.bufferedAmount ?? 0,
        sendRelayDataFrame: (idBytes, payload) => {
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new RemoteCryptoError('HANDSHAKE_STATE_INVALID', 'relay WebSocket is not open')
          }
          const framed = Buffer.allocUnsafe(RELAY_DATA_HEADER_BYTES + payload.byteLength)
          framed[0] = RELAY_FRAME_DATA
          idBytes.copy(framed, 1)
          Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(
            framed,
            RELAY_DATA_HEADER_BYTES,
          )
          this.ws.send(framed)
        },
        kickRelayPeer: (targetHex) => {
          this.sendControlFrame({ v: 1, type: 'relay.peer.kick', connIdHex: targetHex })
        },
        onVirtualClosed: (targetHex) => {
          this.peersByConnId.delete(targetHex)
        },
      })

      const channelId = randomBytes(16).toString('hex')
      const channel = new RemoteServerChannel(
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

      const entry: RelayPeerEntry = { connIdHex, transport, channel }
      this.peersByConnId.set(connIdHex, entry)
      this.activeChannels.set(channelId, channel)
      this.channelToConnId.set(channel, connIdHex)
      return
    }

    if (msg.type === 'relay.peer.left') {
      const connIdHex = typeof msg.connIdHex === 'string' ? msg.connIdHex : ''
      const entry = this.peersByConnId.get(connIdHex)
      if (entry) {
        this.peersByConnId.delete(connIdHex)
        entry.transport.markRemoteClosed()
      }
    }
  }

  private sendControlFrame(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const json = Buffer.from(JSON.stringify(payload), 'utf8')
    const framed = Buffer.allocUnsafe(1 + json.byteLength)
    framed[0] = RELAY_FRAME_CONTROL
    json.copy(framed, 1)
    try {
      this.ws.send(framed)
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
    const connIdHex = this.channelToConnId.get(ch)
    if (connIdHex) {
      this.channelToConnId.delete(ch)
      const entry = this.peersByConnId.get(connIdHex)
      if (entry) {
        this.peersByConnId.delete(connIdHex)
        entry.transport.close(1000, 'channel closed')
      }
    }
  }

  private handleRevocation(deviceId: string): void {
    const set = this.deviceChannels.get(deviceId)
    if (!set) return
    for (const ch of Array.from(set)) {
      try {
        ch.terminate(1008, 'device revoked')
      } catch {}
    }
    this.deviceChannels.delete(deviceId)
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
    this.isRunning = false

    if (this.unsubscribeRevocations) {
      try {
        this.unsubscribeRevocations()
      } catch {}
      this.unsubscribeRevocations = undefined
    }

    for (const entry of Array.from(this.peersByConnId.values())) {
      try {
        entry.channel.terminate(1001, 'host shutting down')
      } catch {}
    }
    this.peersByConnId.clear()
    this.activeChannels.clear()
    this.deviceChannels.clear()
    this.channelToConnId.clear()

    const ws = this.ws
    this.ws = undefined
    if (ws) {
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) {
          resolve()
          return
        }
        const timer = setTimeout(() => {
          ws.onclose = null
          resolve()
        }, 300)
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = () => {
          clearTimeout(timer)
          resolve()
        }
        try {
          ws.close(1000, 'host shutting down')
        } catch {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  }
}
