import { RemoteCryptoError } from '../crypto/errors.js'
import type { NoiseInitiatorSession } from '../crypto/noise.js'
import { RemoteClientSession } from './remote-client-session.js'
import {
  normalizeBinaryPayload,
  reconnectDelayMs,
  type FramedClientTransport,
  type FramedClientTransportHandlers,
  type ReconnectBackoffPolicy,
} from './transport.js'

export { reconnectDelayMs, type ReconnectBackoffPolicy } from './transport.js'

export interface LanClientCarrierOptions {
  readonly clientKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array }
  readonly hostPublicKey: Uint8Array
  readonly endpointUrl: string
  readonly handshakeTimeoutMs?: number | undefined
  readonly requestTimeoutMs?: number | undefined
  readonly sleep?: ((delayMs: number) => Promise<void>) | undefined
}

/**
 * WebSocket client transport over LAN/loopback backed by RemoteClientSession.
 */
export class LanClientCarrier {
  readonly deviceId: string
  private readonly options: LanClientCarrierOptions
  private readonly session: RemoteClientSession
  private ws: WebSocket | undefined = undefined

  constructor(options: LanClientCarrierOptions) {
    this.options = options
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

  isOpen(): boolean {
    return this.session.isOpen()
  }

  private createWebSocketTransport(): FramedClientTransport {
    const endpointUrl = this.options.endpointUrl
    return {
      kind: 'lan',
      isOpen: () => this.ws !== undefined && this.ws.readyState === WebSocket.OPEN,
      connect: (handlers: FramedClientTransportHandlers) =>
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(endpointUrl)
          ws.binaryType = 'arraybuffer'
          this.ws = ws
          let opened = false

          ws.onopen = () => {
            opened = true
            resolve()
          }

          ws.onmessage = (event: MessageEvent) => {
            if (this.ws !== ws) return
            try {
              handlers.onMessage(normalizeBinaryPayload(event.data))
            } catch (err) {
              handlers.onError(err instanceof Error ? err : new Error(String(err)))
            }
          }

          ws.onerror = (err) => {
            const error = new RemoteCryptoError(
              'HANDSHAKE_FAILED',
              `websocket error: ${String((err as { message?: unknown }).message ?? 'connect failed')}`,
            )
            if (!opened) {
              reject(error)
            } else {
              handlers.onError(error)
            }
          }

          ws.onclose = (event) => {
            if (this.ws === ws) {
              this.ws = undefined
            }
            const reason = `websocket closed${opened ? '' : ' during handshake'} (code ${event.code}: ${event.reason || 'closed'})`
            if (!opened) {
              reject(new RemoteCryptoError('HANDSHAKE_FAILED', reason))
            } else {
              handlers.onClose(reason)
            }
          }
        }),
      send: (payload: Uint8Array) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          throw new RemoteCryptoError('HANDSHAKE_STATE_INVALID', 'websocket is not open')
        }
        this.ws.send(payload)
      },
      close: () => {
        const ws = this.ws
        this.ws = undefined
        if (ws) {
          try {
            ws.close()
          } catch {}
        }
      },
    }
  }

  async connect(): Promise<void> {
    await this.session.connectWithTransport(() => this.createWebSocketTransport())
  }

  async reconnectWithBackoff(policy?: ReconnectBackoffPolicy): Promise<void> {
    await this.session.connectAgainWithBackoff(() => this.createWebSocketTransport(), policy)
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
      () => this.createWebSocketTransport(),
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
    this.ws = undefined
  }
}
