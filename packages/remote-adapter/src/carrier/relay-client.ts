import { RemoteCryptoError } from '../crypto/errors.js'
import { computeFingerprint } from '../crypto/host-identity.js'
import type { NoiseInitiatorSession } from '../crypto/noise.js'
import { RemoteClientSession } from './remote-client-session.js'
import {
  normalizeBinaryPayload,
  type FramedClientTransport,
  type FramedClientTransportHandlers,
  type ReconnectBackoffPolicy,
} from './transport.js'

const ROOM_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export interface RelayClientCarrierOptions {
  readonly clientKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array }
  readonly hostPublicKey: Uint8Array
  readonly relayUrl: string
  /** Optional relay roomId (defaults to Host static key fingerprint). */
  readonly roomId?: string | undefined
  /** Optional relay admission token authenticated by BlindRelayServer. */
  readonly clientToken?: string | undefined
  /** Timeout for relay WebSocket open + room join handshake (default: 5_000 ms). */
  readonly connectTimeoutMs?: number | undefined
  readonly handshakeTimeoutMs?: number | undefined
  readonly requestTimeoutMs?: number | undefined
  readonly sleep?: ((delayMs: number) => Promise<void>) | undefined
}

export interface RelayTransportHandles {
  readonly ws: WebSocket | undefined
  readonly connIdHex: string | undefined
}

export function createRelayTransport(
  options: Omit<RelayClientCarrierOptions, 'clientKeyPair' | 'handshakeTimeoutMs' | 'requestTimeoutMs' | 'sleep'>,
  onHandlesChanged?: (handles: RelayTransportHandles) => void,
): FramedClientTransport {
  if (!/^wss?:\/\/[^\s]+$/i.test(options.relayUrl ?? '')) {
    throw new RemoteCryptoError(
      'HANDSHAKE_FAILED',
      `invalid relayUrl '${String(options.relayUrl)}'`,
    )
  }
  const roomId = options.roomId ?? computeFingerprint(options.hostPublicKey)
  if (!ROOM_ID_RE.test(roomId)) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', `invalid relay roomId '${roomId}'`)
  }
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000

  let activeWs: WebSocket | undefined = undefined
  let connIdHex: string | undefined = undefined
  let joined = false

  const publishHandles = () => {
    onHandlesChanged?.({ ws: activeWs, connIdHex })
  }

  return {
    kind: 'relay',
    isOpen: () => joined && activeWs !== undefined && activeWs.readyState === WebSocket.OPEN,
    connect: (handlers: FramedClientTransportHandlers) =>
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(options.relayUrl)
        ws.binaryType = 'arraybuffer'
        activeWs = ws
        connIdHex = undefined
        joined = false
        publishHandles()

        const failEarly = (err: Error): void => {
          clearTimeout(timer)
          if (activeWs === ws) {
            activeWs = undefined
            connIdHex = undefined
            joined = false
            publishHandles()
          }
          try {
            ws.close()
          } catch {}
          reject(err)
        }

        const timer = setTimeout(() => {
          if (!joined) {
            failEarly(new RemoteCryptoError('HANDSHAKE_FAILED', 'blind relay join timeout'))
          }
        }, connectTimeoutMs)

        ws.onopen = () => {
          try {
            ws.send(
              textEncoder.encode(
                JSON.stringify({
                  v: 1,
                  type: 'relay.client.join',
                  roomId,
                  ...(options.clientToken !== undefined ? { clientToken: options.clientToken } : {}),
                }),
              ),
            )
          } catch (err) {
            failEarly(err instanceof Error ? err : new Error(String(err)))
          }
        }

        ws.onmessage = (event: MessageEvent) => {
          if (activeWs !== ws) return

          if (!joined) {
            let msg: Record<string, unknown>
            try {
              const raw =
                typeof event.data === 'string'
                  ? event.data
                  : textDecoder.decode(normalizeBinaryPayload(event.data))
              msg = JSON.parse(raw) as Record<string, unknown>
            } catch (err) {
              failEarly(err instanceof Error ? err : new Error(String(err)))
              return
            }

            if (msg.type === 'error') {
              failEarly(
                new RemoteCryptoError(
                  'HANDSHAKE_FAILED',
                  `blind relay join failed: ${String(msg.code ?? 'ERROR')} ${String(msg.message ?? '')}`,
                ),
              )
              return
            }

            if (msg.type === 'relay.client.joined' && msg.roomId === roomId) {
              clearTimeout(timer)
              joined = true
              connIdHex = typeof msg.connIdHex === 'string' ? msg.connIdHex : undefined
              publishHandles()
              resolve()
            }
            return
          }

          if (typeof event.data === 'string') {
            const err = new RemoteCryptoError(
              'HANDSHAKE_FAILED',
              'unexpected text frame received in blind relay binary mode',
            )
            handlers.onError(err)
            try {
              ws.close(1003, 'binary ciphertext only')
            } catch {}
            return
          }

          try {
            handlers.onMessage(normalizeBinaryPayload(event.data))
          } catch (err) {
            handlers.onError(err instanceof Error ? err : new Error(String(err)))
          }
        }

        ws.onerror = (err) => {
          const error = new RemoteCryptoError(
            'HANDSHAKE_FAILED',
            `blind relay websocket error: ${String((err as { message?: unknown }).message ?? 'connect failed')}`,
          )
          if (!joined) {
            failEarly(error)
          } else {
            handlers.onError(error)
          }
        }

        ws.onclose = (event) => {
          const wasJoined = joined
          if (activeWs === ws) {
            activeWs = undefined
            connIdHex = undefined
            joined = false
            publishHandles()
          }
          const reason = `blind relay closed${wasJoined ? '' : ' during join'} (code ${event.code}: ${event.reason || 'closed'})`
          if (!wasJoined) {
            clearTimeout(timer)
            reject(new RemoteCryptoError('HANDSHAKE_FAILED', reason))
          } else {
            handlers.onClose(reason)
          }
        }
      }),
    send: (payload: Uint8Array) => {
      if (!joined || !activeWs || activeWs.readyState !== WebSocket.OPEN) {
        throw new RemoteCryptoError('HANDSHAKE_STATE_INVALID', 'blind relay transport is not open')
      }
      activeWs.send(payload)
    },
    close: () => {
      const ws = activeWs
      activeWs = undefined
      connIdHex = undefined
      joined = false
      publishHandles()
      if (ws) {
        try {
          ws.close()
        } catch {}
      }
    },
  }
}

/**
 * Blind WebSocket Relay client carrier backed by the shared RemoteClientSession.
 */
export class RelayClientCarrier {
  readonly deviceId: string
  private readonly options: RelayClientCarrierOptions
  private readonly session: RemoteClientSession
  private ws: WebSocket | undefined = undefined
  private connIdHex: string | undefined = undefined

  constructor(options: RelayClientCarrierOptions) {
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

  getAssignedConnIdHex(): string | undefined {
    return this.connIdHex
  }

  getWebSocket(): WebSocket | undefined {
    return this.ws
  }

  isOpen(): boolean {
    return this.session.isOpen()
  }

  private createRelayTransport(): FramedClientTransport {
    return createRelayTransport(this.options, (handles) => {
      this.ws = handles.ws
      this.connIdHex = handles.connIdHex
    })
  }

  async connect(): Promise<void> {
    await this.session.connectWithTransport(() => this.createRelayTransport())
  }

  async reconnectWithBackoff(policy?: ReconnectBackoffPolicy): Promise<void> {
    await this.session.connectAgainWithBackoff(() => this.createRelayTransport(), policy)
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
      () => this.createRelayTransport(),
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
    this.connIdHex = undefined
  }
}
