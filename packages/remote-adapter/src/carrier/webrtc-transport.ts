import {
  RTCPeerConnection,
  type PeerConfig,
  type RTCDataChannel,
  type RTCIceCandidateInit,
} from 'werift'
import { RemoteCryptoError } from '../crypto/errors.js'
import type { RtcIceCandidatePayload } from './signaling-server.js'
import {
  normalizeBinaryPayload,
  type FramedMessageTransport,
  type FramedMessageTransportHandlers,
} from './transport.js'

export const DSH_WEBRTC_DATA_CHANNEL_LABEL = 'dsh-remote-v1'
export const DEFAULT_WEBRTC_CHUNK_BYTES = 16_000

const CHUNK_SINGLE = 0x00
const CHUNK_MORE = 0x01
const CHUNK_FINAL = 0x02

export function toRtcIceCandidateInit(
  payload: RtcIceCandidatePayload | null,
): RTCIceCandidateInit | null {
  if (payload === null) return null
  const init: RTCIceCandidateInit = { candidate: payload.candidate }
  if (payload.sdpMid !== undefined) {
    init.sdpMid = payload.sdpMid
  }
  if (payload.sdpMLineIndex !== undefined) {
    init.sdpMLineIndex = payload.sdpMLineIndex
  }
  if (payload.usernameFragment !== undefined) {
    init.usernameFragment = payload.usernameFragment
  }
  return init
}

export interface SelectedIceCandidatePairInfo {
  readonly localType: string
  readonly localAddress: string
  readonly localPort: number
  readonly remoteType: string
  readonly remoteAddress: string
  readonly remotePort: number
  readonly protocol: string
}

export function getSelectedIceCandidatePair(
  pc: RTCPeerConnection,
): SelectedIceCandidatePairInfo | undefined {
  const ice = pc.iceTransports[0] as
    | {
        connection?: {
          nominated?: {
            localCandidate?: {
              type?: string
              host?: string
              port?: number
              transport?: string
            }
            remoteCandidate?: {
              type?: string
              host?: string
              port?: number
              transport?: string
            }
          }
        }
      }
    | undefined
  const nominated = ice?.connection?.nominated
  const local = nominated?.localCandidate
  const remote = nominated?.remoteCandidate
  if (!local || !remote) return undefined
  return {
    localType: String(local.type ?? 'unknown'),
    localAddress: String(local.host ?? ''),
    localPort: Number(local.port ?? 0),
    remoteType: String(remote.type ?? 'unknown'),
    remoteAddress: String(remote.host ?? ''),
    remotePort: Number(remote.port ?? 0),
    protocol: String(local.transport ?? remote.transport ?? 'udp'),
  }
}

export interface WebRtcIceConfigOptions {
  /** Self-owned STUN URLs (e.g., ['stun:127.0.0.1:3478']). No third-party fallback is allowed. */
  readonly stunUrls?: readonly string[] | undefined
  /** Include explicit local/loopback interface addresses for deterministic LAN/netns NAT testing. */
  readonly iceAdditionalHostAddresses?: readonly string[] | undefined
  /** Explicit per-family bind addresses when testing isolated topologies. */
  readonly iceInterfaceAddresses?: PeerConfig['iceInterfaceAddresses'] | undefined
  /** Optional ICE candidate-pair filter (useful for forcing srflx/NAT paths or blocked-UDP simulation). */
  readonly iceFilterCandidatePair?: PeerConfig['iceFilterCandidatePair'] | undefined
  /** Optional ICE UDP port range. */
  readonly icePortRange?: readonly [number, number] | undefined
  /** Seconds to wait for STUN server-reflexive candidates. Defaults to 2s for responsive failover. */
  readonly iceStunGatherTimeoutSec?: number | undefined
  readonly iceUseIpv4?: boolean | undefined
  readonly iceUseIpv6?: boolean | undefined
  readonly iceUseTcp?: boolean | undefined
  /**
   * 'all' (default) allows all ICE candidates; 'direct-only' strips/ignores `typ relay` candidates
   * during local/P2P probing so direct LAN/STUN stage never leaks relay paths.
   */
  readonly iceTransportPolicy?: 'all' | 'direct-only' | undefined
}

export function isRelayIceCandidate(payload: RtcIceCandidatePayload | null): boolean {
  if (!payload || typeof payload.candidate !== 'string') return false
  return /\btyp\s+relay\b/iu.test(payload.candidate)
}

export function shouldAllowIceCandidate(
  payload: RtcIceCandidatePayload | null,
  policy: WebRtcIceConfigOptions['iceTransportPolicy'],
): boolean {
  if (policy !== 'direct-only') return true
  return !isRelayIceCandidate(payload)
}

export function validateSelfOwnedStunUrls(
  stunUrls: readonly string[] | undefined,
): { urls: string[] }[] {
  if (!stunUrls || stunUrls.length === 0) return []
  const validated: string[] = []
  for (const url of stunUrls) {
    if (typeof url !== 'string' || !/^stun:[^\s]+$/i.test(url.trim())) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        `invalid STUN URL '${String(url)}'; R3 permits only self-owned stun: URLs`,
      )
    }
    validated.push(url.trim())
  }
  return validated.length > 0 ? [{ urls: validated }] : []
}

export function createConfiguredPeerConnection(
  options?: WebRtcIceConfigOptions,
): RTCPeerConnection {
  const iceServers = validateSelfOwnedStunUrls(options?.stunUrls)
  return new RTCPeerConnection({
    iceServers,
    // Fail closed: NEVER silently fall back to public stun.l.google.com
    iceUseDefaultStunServer: false,
    certificateScope: 'peerConnection',
    iceTransportPolicy: 'all',
    iceStunGatherTimeout: options?.iceStunGatherTimeoutSec ?? 2,
    iceUseIpv4: options?.iceUseIpv4 ?? true,
    iceUseIpv6: options?.iceUseIpv6 ?? false,
    iceUseTcp: options?.iceUseTcp ?? false,
    ...(options?.iceAdditionalHostAddresses
      ? { iceAdditionalHostAddresses: [...options.iceAdditionalHostAddresses] }
      : {}),
    ...(options?.iceInterfaceAddresses !== undefined
      ? { iceInterfaceAddresses: options.iceInterfaceAddresses }
      : {}),
    ...(options?.iceFilterCandidatePair !== undefined
      ? { iceFilterCandidatePair: options.iceFilterCandidatePair }
      : {}),
    ...(options?.icePortRange !== undefined
      ? { icePortRange: [options.icePortRange[0], options.icePortRange[1]] }
      : {}),
  })
}

export function encodeDataChannelChunks(
  payload: Uint8Array,
  maxFrameBytes: number,
  chunkSize = DEFAULT_WEBRTC_CHUNK_BYTES,
): Uint8Array[] {
  if (payload.byteLength > maxFrameBytes) {
    throw new RemoteCryptoError(
      'HANDSHAKE_FAILED',
      `DataChannel payload (${payload.byteLength}) exceeds maxFrameBytes (${maxFrameBytes})`,
    )
  }

  if (payload.byteLength <= chunkSize) {
    const out = Buffer.allocUnsafe(1 + payload.byteLength)
    out[0] = CHUNK_SINGLE
    Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(out, 1)
    return [out]
  }

  const chunks: Uint8Array[] = []
  let offset = 0
  while (offset < payload.byteLength) {
    const end = Math.min(payload.byteLength, offset + chunkSize)
    const isFinal = end >= payload.byteLength
    const sliceLen = end - offset
    const frame = Buffer.allocUnsafe(1 + sliceLen)
    frame[0] = isFinal ? CHUNK_FINAL : CHUNK_MORE
    Buffer.from(payload.buffer, payload.byteOffset + offset, sliceLen).copy(frame, 1)
    chunks.push(frame)
    offset = end
  }
  return chunks
}

/**
 * Reassembles chunked ordered binary frames sent over RTCDataChannel
 * while enforcing maxFrameBytes before concatenating buffers.
 */
export class DataChannelFrameReassembler {
  private chunks: Uint8Array[] = []
  private totalBytes = 0

  constructor(private readonly maxFrameBytes: number) {}

  push(rawChunk: unknown): Uint8Array | undefined {
    const bytes = normalizeBinaryPayload(rawChunk)
    if (bytes.byteLength < 1) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'empty DataChannel frame chunk')
    }
    const marker = bytes[0]
    const slice = bytes.subarray(1)

    if (marker === CHUNK_SINGLE) {
      if (this.chunks.length > 0) {
        this.reset()
        throw new RemoteCryptoError('HANDSHAKE_FAILED', 'unexpected CHUNK_SINGLE during multipart frame')
      }
      if (slice.byteLength > this.maxFrameBytes) {
        throw new RemoteCryptoError('HANDSHAKE_FAILED', 'DataChannel frame exceeds maxFrameBytes')
      }
      return slice
    }

    if (marker !== CHUNK_MORE && marker !== CHUNK_FINAL) {
      this.reset()
      throw new RemoteCryptoError('HANDSHAKE_FAILED', `unknown DataChannel chunk marker ${marker}`)
    }

    if (this.totalBytes + slice.byteLength > this.maxFrameBytes) {
      this.reset()
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'reassembled DataChannel frame exceeds maxFrameBytes')
    }

    this.chunks.push(slice)
    this.totalBytes += slice.byteLength

    if (marker === CHUNK_MORE) {
      return undefined
    }

    const assembled = Buffer.concat(this.chunks, this.totalBytes)
    this.reset()
    return assembled
  }

  reset(): void {
    this.chunks = []
    this.totalBytes = 0
  }
}

/**
 * Adapts an ordered reliable werift RTCDataChannel (+ owning RTCPeerConnection)
 * to FramedMessageTransport for RemoteServerChannel.
 */
export class WebRtcServerDataChannelTransport implements FramedMessageTransport {
  readonly kind = 'webrtc' as const
  private handlers: FramedMessageTransportHandlers | undefined = undefined
  private readonly reassembler: DataChannelFrameReassembler
  private closed = false

  constructor(
    readonly peerConnection: RTCPeerConnection,
    readonly dataChannel: RTCDataChannel,
    private readonly maxFrameBytes: number,
  ) {
    this.reassembler = new DataChannelFrameReassembler(maxFrameBytes)

    this.dataChannel.onmessage = (evt) => {
      if (this.closed) return
      if (typeof evt.data === 'string') {
        this.close(1003, 'text DataChannel frames are strictly forbidden')
        return
      }
      try {
        const message = this.reassembler.push(evt.data)
        if (message !== undefined) {
          this.handlers?.onMessage(message)
        }
      } catch (err) {
        this.handlers?.onError(err instanceof Error ? err : new Error(String(err)))
        this.close(1009, 'invalid DataChannel frame')
      }
    }

    this.dataChannel.onerror = (evt) => {
      if (this.closed) return
      const err = evt.error instanceof Error ? evt.error : new Error('DataChannel error')
      this.handlers?.onError(err)
    }

    this.dataChannel.onclose = () => {
      if (this.closed) return
      this.closed = true
      this.reassembler.reset()
      this.handlers?.onClose()
    }

    this.peerConnection.connectionStateChange.subscribe((state) => {
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        if (!this.closed && (state === 'failed' || state === 'closed')) {
          this.closed = true
          this.reassembler.reset()
          this.handlers?.onClose()
        }
      }
    })
  }

  isWritable(): boolean {
    return !this.closed && this.dataChannel.readyState === 'open'
  }

  getBufferedBytes(): number {
    return this.dataChannel.bufferedAmount
  }

  send(payload: Uint8Array, onFlushed?: () => void): void {
    if (!this.isWritable()) {
      throw new RemoteCryptoError('HANDSHAKE_STATE_INVALID', 'WebRTC DataChannel is not open')
    }
    const chunks = encodeDataChannelChunks(payload, this.maxFrameBytes)
    for (const chunk of chunks) {
      this.dataChannel.send(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    }
    onFlushed?.()
  }

  close(_code?: number, _reason?: string): void {
    const wasClosed = this.closed
    this.closed = true
    this.reassembler.reset()
    try {
      this.dataChannel.close()
    } catch {}
    try {
      void this.peerConnection.close()
    } catch {}
    if (!wasClosed) {
      this.handlers?.onClose()
    }
  }

  setHandlers(handlers: FramedMessageTransportHandlers): void {
    this.handlers = handlers
  }
}
