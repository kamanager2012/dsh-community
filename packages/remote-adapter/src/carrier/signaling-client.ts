import { RemoteCryptoError } from '../crypto/errors.js'
import type {
  RtcIceCandidatePayload,
  RtcSessionDescriptionPayload,
} from './signaling-server.js'
import { normalizeBinaryPayload } from './transport.js'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export interface SignalingOfferMessage {
  readonly roomId: string
  readonly fromPeerId: string
  readonly toPeerId: string
  readonly sdp: RtcSessionDescriptionPayload
}

export interface SignalingAnswerMessage {
  readonly roomId: string
  readonly fromPeerId: string
  readonly toPeerId: string
  readonly sdp: RtcSessionDescriptionPayload
}

export interface SignalingIceMessage {
  readonly roomId: string
  readonly fromPeerId: string
  readonly toPeerId: string
  readonly candidate: RtcIceCandidatePayload | null
}

export interface SignalingClientHandlers {
  readonly onOffer?: ((msg: SignalingOfferMessage) => void) | undefined
  readonly onAnswer?: ((msg: SignalingAnswerMessage) => void) | undefined
  readonly onIceCandidate?: ((msg: SignalingIceMessage) => void) | undefined
  readonly onPeerJoined?: ((peerId: string) => void) | undefined
  readonly onPeerLeft?: ((peerId: string) => void) | undefined
  readonly onClose?: ((reason: string) => void) | undefined
}

/**
 * WebSocket signaling client used by HostWebRtcCarrier and WebRtcClientCarrier
 * to exchange SDP offers/answers and Trickle ICE candidates over the self-hosted signaling server.
 */
export class SignalingClient {
  private ws: WebSocket | undefined = undefined
  private peerId: string | undefined = undefined
  private hostPeerId: string | undefined = undefined
  private roomId: string | undefined = undefined
  private handlers: SignalingClientHandlers = {}

  constructor(private readonly signalingUrl: string) {}

  getPeerId(): string | undefined {
    return this.peerId
  }

  getHostPeerId(): string | undefined {
    return this.hostPeerId
  }

  getRoomId(): string | undefined {
    return this.roomId
  }

  isOpen(): boolean {
    return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN
  }

  setHandlers(handlers: SignalingClientHandlers): void {
    this.handlers = handlers
  }

  async registerHost(params: {
    readonly roomId: string
    readonly hostAuthSecret?: string | undefined
    readonly joinToken?: string | undefined
    readonly timeoutMs?: number | undefined
  }): Promise<{ peerId: string; roomId: string }> {
    const welcome = await this.connectAndHandshake(
      {
        v: 1,
        type: 'host.register',
        roomId: params.roomId,
        ...(params.hostAuthSecret !== undefined ? { hostAuthSecret: params.hostAuthSecret } : {}),
        ...(params.joinToken !== undefined ? { joinToken: params.joinToken } : {}),
      },
      'host.registered',
      params.timeoutMs ?? 5_000,
    )
    this.peerId = String(welcome.peerId)
    this.hostPeerId = this.peerId
    this.roomId = String(welcome.roomId)
    return { peerId: this.peerId, roomId: this.roomId }
  }

  async joinRoom(params: {
    readonly roomId: string
    readonly joinToken?: string | undefined
    readonly timeoutMs?: number | undefined
  }): Promise<{ peerId: string; hostPeerId: string; roomId: string }> {
    const welcome = await this.connectAndHandshake(
      {
        v: 1,
        type: 'client.join',
        roomId: params.roomId,
        ...(params.joinToken !== undefined ? { joinToken: params.joinToken } : {}),
      },
      'client.joined',
      params.timeoutMs ?? 5_000,
    )
    this.peerId = String(welcome.peerId)
    this.hostPeerId = String(welcome.hostPeerId)
    this.roomId = String(welcome.roomId)
    return {
      peerId: this.peerId,
      hostPeerId: this.hostPeerId,
      roomId: this.roomId,
    }
  }

  sendOffer(toPeerId: string, sdp: RtcSessionDescriptionPayload): void {
    this.sendMessage({
      v: 1,
      type: 'rtc.offer',
      roomId: this.roomId,
      toPeerId,
      sdp,
    })
  }

  sendAnswer(toPeerId: string, sdp: RtcSessionDescriptionPayload): void {
    this.sendMessage({
      v: 1,
      type: 'rtc.answer',
      roomId: this.roomId,
      toPeerId,
      sdp,
    })
  }

  sendIceCandidate(toPeerId: string, candidate: RtcIceCandidatePayload | null): void {
    this.sendMessage({
      v: 1,
      type: 'rtc.ice',
      roomId: this.roomId,
      toPeerId,
      candidate,
    })
  }

  sendPing(): void {
    this.sendMessage({
      v: 1,
      type: 'ping',
    })
  }

  close(): void {
    const ws = this.ws
    this.ws = undefined
    if (ws) {
      try {
        ws.close()
      } catch {}
    }
  }

  private sendMessage(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new RemoteCryptoError('HANDSHAKE_STATE_INVALID', 'signaling WebSocket is not open')
    }
    this.ws.send(textEncoder.encode(JSON.stringify(payload)))
  }

  private connectAndHandshake(
    helloPayload: Record<string, unknown>,
    expectedType: 'host.registered' | 'client.joined',
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    this.close()
    const ws = new WebSocket(this.signalingUrl)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false

      const finishFailure = (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.ws === ws) {
          this.ws = undefined
        }
        try {
          ws.close()
        } catch {}
        reject(error)
      }

      const timer = setTimeout(() => {
        finishFailure(new RemoteCryptoError('HANDSHAKE_FAILED', 'signaling handshake timeout'))
      }, timeoutMs)

      ws.onopen = () => {
        try {
          ws.send(textEncoder.encode(JSON.stringify(helloPayload)))
        } catch (err) {
          finishFailure(err instanceof Error ? err : new Error(String(err)))
        }
      }

      ws.onerror = (err) => {
        const message = String((err as { message?: unknown }).message ?? 'signaling connection error')
        finishFailure(new RemoteCryptoError('HANDSHAKE_FAILED', message))
      }

      ws.onclose = (evt) => {
        const reason = `signaling closed (${evt.code}: ${evt.reason || 'closed'})`
        if (!settled) {
          finishFailure(new RemoteCryptoError('HANDSHAKE_FAILED', reason))
          return
        }
        if (this.ws === ws) {
          this.ws = undefined
        }
        this.handlers.onClose?.(reason)
      }

      ws.onmessage = (evt: MessageEvent) => {
        if (this.ws !== ws) return
        let msg: Record<string, unknown>
        try {
          const bytes = normalizeBinaryPayload(evt.data)
          msg = JSON.parse(textDecoder.decode(bytes)) as Record<string, unknown>
        } catch {
          return
        }

        if (!settled) {
          if (msg.type === 'error') {
            finishFailure(
              new RemoteCryptoError(
                'HANDSHAKE_FAILED',
                `${String(msg.code ?? 'SIGNALING_ERROR')}: ${String(msg.message ?? 'rejected')}`,
              ),
            )
            return
          }
          if (msg.type === expectedType) {
            settled = true
            clearTimeout(timer)
            resolve(msg)
          }
          return
        }

        this.dispatchMessage(msg)
      }
    })
  }

  private dispatchMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'rtc.offer':
        this.handlers.onOffer?.(msg as unknown as SignalingOfferMessage)
        return
      case 'rtc.answer':
        this.handlers.onAnswer?.(msg as unknown as SignalingAnswerMessage)
        return
      case 'rtc.ice':
        this.handlers.onIceCandidate?.(msg as unknown as SignalingIceMessage)
        return
      case 'peer.joined':
        if (typeof msg.peerId === 'string') {
          this.handlers.onPeerJoined?.(msg.peerId)
        }
        return
      case 'peer.left':
        if (typeof msg.peerId === 'string') {
          this.handlers.onPeerLeft?.(msg.peerId)
        }
        return
      case 'host.offline':
        this.handlers.onClose?.('host offline')
        this.close()
        return
      default:
        return
    }
  }
}
