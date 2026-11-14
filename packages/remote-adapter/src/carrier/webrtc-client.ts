import type { RTCDataChannel, RTCPeerConnection } from 'werift'
import { RemoteCryptoError } from '../crypto/errors.js'
import { computeFingerprint } from '../crypto/host-identity.js'
import type { NoiseInitiatorSession } from '../crypto/noise.js'
import { LAN_CARRIER_BOUNDS } from './constants.js'
import { RemoteClientSession } from './remote-client-session.js'
import { SignalingClient } from './signaling-client.js'
import type { RtcIceCandidatePayload } from './signaling-server.js'
import type {
  FramedClientTransport,
  FramedClientTransportHandlers,
  ReconnectBackoffPolicy,
} from './transport.js'
import {
  createConfiguredPeerConnection,
  DataChannelFrameReassembler,
  DSH_WEBRTC_DATA_CHANNEL_LABEL,
  encodeDataChannelChunks,
  getSelectedIceCandidatePair,
  shouldAllowIceCandidate,
  toRtcIceCandidateInit,
  validateSelfOwnedStunUrls,
  type SelectedIceCandidatePairInfo,
  type WebRtcIceConfigOptions,
} from './webrtc-transport.js'

export interface WebRtcClientCarrierOptions {
  readonly clientKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array }
  readonly hostPublicKey: Uint8Array
  readonly signalingUrl: string
  /** Optional explicit signaling roomId (defaults to Host static key fingerprint). */
  readonly roomId?: string | undefined
  /** Optional join token authenticated by signaling server. */
  readonly joinToken?: string | undefined
  /** Self-owned STUN & ICE configuration. */
  readonly ice?: WebRtcIceConfigOptions | undefined
  /** Maximum DataChannel bytes per assembled frame (default: 64 KiB). */
  readonly maxFrameBytes?: number | undefined
  /** Maximum ICE + DataChannel negotiation timeout (default: 10s). */
  readonly iceConnectTimeoutMs?: number | undefined
  readonly handshakeTimeoutMs?: number | undefined
  readonly requestTimeoutMs?: number | undefined
  /** Keep signaling WebSocket open after DataChannel connects (default: false). */
  readonly keepSignalingOpen?: boolean | undefined
  readonly sleep?: ((delayMs: number) => Promise<void>) | undefined
}

export interface WebRtcTransportHandles {
  readonly pc: RTCPeerConnection | undefined
  readonly dc: RTCDataChannel | undefined
  readonly signaling: SignalingClient | undefined
}

export function createWebRtcTransport(
  options: Omit<WebRtcClientCarrierOptions, 'clientKeyPair' | 'requestTimeoutMs' | 'sleep'>,
  onHandlesChanged?: (handles: WebRtcTransportHandles) => void,
): FramedClientTransport {
  const maxFrameBytes = options.maxFrameBytes ?? LAN_CARRIER_BOUNDS.maxFrameBytes
  const iceConnectTimeoutMs = options.iceConnectTimeoutMs ?? 10_000
  validateSelfOwnedStunUrls(options.ice?.stunUrls)
  const roomId = options.roomId ?? computeFingerprint(options.hostPublicKey)

  let activePc: RTCPeerConnection | undefined = undefined
  let activeDc: RTCDataChannel | undefined = undefined
  let activeSignaling: SignalingClient | undefined = undefined

  const publishHandles = () => {
    onHandlesChanged?.({
      pc: activePc,
      dc: activeDc,
      signaling: activeSignaling,
    })
  }

  return {
    kind: 'webrtc',
    isOpen: () => activeDc !== undefined && activeDc.readyState === 'open',
    connect: async (handlers: FramedClientTransportHandlers) => {
      if (!/^wss?:\/\/[^\s]+$/i.test(options.signalingUrl ?? '')) {
        throw new RemoteCryptoError(
          'HANDSHAKE_FAILED',
          `invalid signalingUrl '${String(options.signalingUrl)}'`,
        )
      }

      const signaling = new SignalingClient(options.signalingUrl)
      activeSignaling = signaling

      const pc = createConfiguredPeerConnection(options.ice)
      activePc = pc
      const dc = pc.createDataChannel(DSH_WEBRTC_DATA_CHANNEL_LABEL, { ordered: true })
      activeDc = dc
      publishHandles()

      const reassembler = new DataChannelFrameReassembler(maxFrameBytes)
      const remoteIceQueue: (RtcIceCandidatePayload | null)[] = []
      const localIceBuffer: (RtcIceCandidatePayload | null)[] = []
      let offerSent = false
      let remoteDescSet = false
      let hostPeerId: string | undefined = undefined
      let opened = false
      let closed = false

      const cleanupLocal = () => {
        closed = true
        reassembler.reset()
        if (activeDc === dc) activeDc = undefined
        if (activePc === pc) activePc = undefined
        if (activeSignaling === signaling) activeSignaling = undefined
        publishHandles()
        try {
          signaling.close()
        } catch {}
        try {
          dc.close()
        } catch {}
        try {
          void pc.close()
        } catch {}
      }

      await new Promise<void>((resolve, reject) => {
        let settled = false
        const failConnect = (err: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          cleanupLocal()
          reject(err)
        }

        const timer = setTimeout(() => {
          failConnect(
            new RemoteCryptoError('HANDSHAKE_FAILED', 'WebRTC DataChannel connection timeout'),
          )
        }, iceConnectTimeoutMs)

        const flushRemoteIce = async () => {
          while (remoteIceQueue.length > 0 && !closed) {
            const cand = remoteIceQueue.shift()!
            try {
              await pc.addIceCandidate(toRtcIceCandidateInit(cand))
            } catch {}
          }
        }

        signaling.setHandlers({
          onAnswer: (msg) => {
            if (closed) return
            void (async () => {
              try {
                await pc.setRemoteDescription(msg.sdp)
                remoteDescSet = true
                await flushRemoteIce()
              } catch (err) {
                failConnect(err instanceof Error ? err : new Error(String(err)))
              }
            })()
          },
          onIceCandidate: (msg) => {
            if (closed) return
            if (!shouldAllowIceCandidate(msg.candidate, options.ice?.iceTransportPolicy)) {
              return
            }
            remoteIceQueue.push(msg.candidate)
            if (remoteDescSet) {
              void flushRemoteIce()
            }
          },
          onClose: (reason) => {
            if (!opened) {
              failConnect(new RemoteCryptoError('HANDSHAKE_FAILED', reason))
            }
          },
        })

        pc.onicecandidate = ({ candidate }) => {
          if (closed) return
          const payload: RtcIceCandidatePayload | null = candidate ? candidate.toJSON() : null
          if (!shouldAllowIceCandidate(payload, options.ice?.iceTransportPolicy)) {
            return
          }
          if (!offerSent || !hostPeerId || !signaling.isOpen()) {
            localIceBuffer.push(payload)
            return
          }
          try {
            signaling.sendIceCandidate(hostPeerId, payload)
          } catch {}
        }

        pc.connectionStateChange.subscribe((state) => {
          if (state === 'failed' || state === 'closed') {
            const err = new RemoteCryptoError('HANDSHAKE_FAILED', `WebRTC peer connection ${state}`)
            if (!opened) {
              failConnect(err)
            } else {
              cleanupLocal()
              handlers.onClose(`WebRTC peer connection ${state}`)
            }
          }
        })

        dc.onmessage = (evt) => {
          if (closed) return
          if (typeof evt.data === 'string') {
            handlers.onError(new RemoteCryptoError('HANDSHAKE_FAILED', 'text DataChannel frames rejected'))
            cleanupLocal()
            return
          }
          try {
            const assembled = reassembler.push(evt.data)
            if (assembled !== undefined) {
              handlers.onMessage(assembled)
            }
          } catch (err) {
            handlers.onError(err instanceof Error ? err : new Error(String(err)))
            cleanupLocal()
          }
        }

        dc.onerror = (evt) => {
          const err = evt.error instanceof Error ? evt.error : new Error('DataChannel error')
          if (!opened) {
            failConnect(err)
          } else {
            handlers.onError(err)
          }
        }

        dc.onclose = () => {
          if (!opened) {
            failConnect(new RemoteCryptoError('HANDSHAKE_FAILED', 'DataChannel closed before open'))
            return
          }
          if (!closed) {
            cleanupLocal()
            handlers.onClose('WebRTC DataChannel closed')
          }
        }

        const markOpen = () => {
          if (settled || closed) return
          settled = true
          opened = true
          clearTimeout(timer)
          if (options.keepSignalingOpen !== true) {
            signaling.close()
            if (activeSignaling === signaling) {
              activeSignaling = undefined
              publishHandles()
            }
          }
          resolve()
        }

        if (dc.readyState === 'open') {
          markOpen()
        } else {
          dc.onopen = markOpen
        }

        void (async () => {
          try {
            const joined = await signaling.joinRoom({
              roomId,
              joinToken: options.joinToken,
              timeoutMs: options.handshakeTimeoutMs ?? 5_000,
            })
            if (closed) return
            hostPeerId = joined.hostPeerId
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            if (closed) return
            signaling.sendOffer(hostPeerId, { type: 'offer', sdp: offer.sdp })
            offerSent = true
            for (const cand of localIceBuffer) {
              try {
                signaling.sendIceCandidate(hostPeerId, cand)
              } catch {}
            }
            localIceBuffer.length = 0
          } catch (err) {
            failConnect(err instanceof Error ? err : new Error(String(err)))
          }
        })()
      })
    },
    send: (payload: Uint8Array) => {
      if (!activeDc || activeDc.readyState !== 'open') {
        throw new RemoteCryptoError('HANDSHAKE_STATE_INVALID', 'WebRTC DataChannel is not open')
      }
      const chunks = encodeDataChannelChunks(payload, maxFrameBytes)
      for (const chunk of chunks) {
        activeDc.send(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      }
    },
    close: () => {
      const signaling = activeSignaling
      const dc = activeDc
      const pc = activePc
      activeSignaling = undefined
      activeDc = undefined
      activePc = undefined
      publishHandles()
      if (signaling) {
        try {
          signaling.close()
        } catch {}
      }
      if (dc) {
        try {
          dc.close()
        } catch {}
      }
      if (pc) {
        try {
          void pc.close()
        } catch {}
      }
    },
  }
}

/**
 * WebRTC P2P DataChannel client carrier backed by the shared RemoteClientSession.
 */
export class WebRtcClientCarrier {
  readonly deviceId: string
  private readonly options: WebRtcClientCarrierOptions
  private readonly session: RemoteClientSession
  private pc: RTCPeerConnection | undefined = undefined
  private dc: RTCDataChannel | undefined = undefined
  private signaling: SignalingClient | undefined = undefined

  constructor(options: WebRtcClientCarrierOptions) {
    this.options = options
    validateSelfOwnedStunUrls(options.ice?.stunUrls)
    this.session = new RemoteClientSession(options)
    this.deviceId = this.session.deviceId
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

  getPeerConnection(): RTCPeerConnection | undefined {
    return this.pc
  }

  getDataChannel(): RTCDataChannel | undefined {
    return this.dc
  }

  getIceDiagnostics(): {
    readonly connectionState: string
    readonly iceConnectionState: string
    readonly selectedPair: SelectedIceCandidatePairInfo | undefined
  } | undefined {
    if (!this.pc) return undefined
    return {
      connectionState: this.pc.connectionState,
      iceConnectionState: this.pc.iceConnectionState,
      selectedPair: getSelectedIceCandidatePair(this.pc),
    }
  }

  isOpen(): boolean {
    return this.session.isOpen()
  }

  private createWebRtcTransport(): FramedClientTransport {
    return createWebRtcTransport(this.options, (handles) => {
      this.pc = handles.pc
      this.dc = handles.dc
      this.signaling = handles.signaling
    })
  }

  async connect(): Promise<void> {
    await this.session.connectWithTransport(() => this.createWebRtcTransport())
  }

  async reconnectWithBackoff(policy?: ReconnectBackoffPolicy): Promise<void> {
    await this.session.connectAgainWithBackoff(() => this.createWebRtcTransport(), policy)
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
    return this.session.reconnectAndResumeWithTransport(
      () => this.createWebRtcTransport(),
      sessionIds,
      policy,
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
    this.session.close()
  }
}
