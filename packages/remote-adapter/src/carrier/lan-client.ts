import { RemoteCryptoError } from '../crypto/errors.js'
import { RemoteProtocolError } from '../errors.js'
import { NoiseInitiatorSession } from '../crypto/noise.js'
import { computeFingerprint } from '../crypto/host-identity.js'
import { REMOTE_PROTOCOL_VERSION } from '../protocol.js'

export interface LanClientCarrierOptions {
  readonly clientKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array }
  readonly hostPublicKey: Uint8Array
  readonly endpointUrl: string
  readonly handshakeTimeoutMs?: number
  readonly requestTimeoutMs?: number
}

export class LanClientCarrier {
  readonly deviceId: string
  private readonly options: LanClientCarrierOptions
  private ws: WebSocket | undefined = undefined
  private noiseSession: NoiseInitiatorSession | undefined = undefined
  private isConnected = false
  private requestSeq = 0
  private connectionEpoch = 1
  private readonly pendingRequests = new Map<
    string | number,
    {
      resolve: (value: any) => void
      reject: (err: Error) => void
      timer: NodeJS.Timeout
    }
  >()
  private readonly eventListeners = new Set<(event: unknown) => void>()

  constructor(options: LanClientCarrierOptions) {
    this.options = options
    this.deviceId = computeFingerprint(options.clientKeyPair.publicKey)
  }

  getNoiseSession(): NoiseInitiatorSession | undefined {
    return this.noiseSession
  }

  getConnectionEpoch(): number {
    return this.connectionEpoch
  }

  isOpen(): boolean {
    return this.isConnected && this.ws !== undefined && this.ws.readyState === WebSocket.OPEN
  }

  async connect(): Promise<void> {
    if (this.isConnected) return

    this.noiseSession = new NoiseInitiatorSession(
      this.options.clientKeyPair,
      this.options.hostPublicKey,
    )

    const ws = new WebSocket(this.options.endpointUrl)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close()
        reject(new RemoteCryptoError('HANDSHAKE_FAILED', 'client connection timeout'))
      }, this.options.handshakeTimeoutMs ?? 5000)

      ws.onopen = () => {
        try {
          // Send Noise Handshake Message 1 as binary
          const msg1 = this.noiseSession!.writeMessage1()
          ws.send(msg1)
        } catch (err) {
          clearTimeout(timeout)
          ws.close()
          reject(err)
        }
      }

      ws.onerror = (err) => {
        clearTimeout(timeout)
        reject(new RemoteCryptoError('HANDSHAKE_FAILED', `websocket error: ${(err as any).message ?? 'connect failed'}`))
      }

      ws.onclose = (event) => {
        clearTimeout(timeout)
        reject(
          new RemoteCryptoError(
            'HANDSHAKE_FAILED',
            `websocket closed during handshake (code ${event.code}: ${event.reason || 'closed'})`,
          ),
        )
      }

      // First message received is Message 2
      const handshakeHandler = (event: MessageEvent) => {
        try {
          const raw = new Uint8Array(event.data as ArrayBuffer)
          this.noiseSession!.readMessage2(raw)
          ws.removeEventListener('message', handshakeHandler)

          // Second message received is encrypted handshake.complete frame with connectionEpoch
          const completionHandler = (compEvt: MessageEvent) => {
            clearTimeout(timeout)
            ws.removeEventListener('message', completionHandler)

            try {
              const compRaw = new Uint8Array(compEvt.data as ArrayBuffer)
              const compPt = this.noiseSession!.decrypt(compRaw)
              const compParsed = JSON.parse(new TextDecoder().decode(compPt))
              if (Number.isInteger(compParsed?.connectionEpoch)) {
                this.connectionEpoch = compParsed.connectionEpoch
              }
              this.isConnected = true
              this.setupMessageHandler()
              resolve()
            } catch (err) {
              ws.close()
              reject(err)
            }
          }

          ws.addEventListener('message', completionHandler)
        } catch (err) {
          clearTimeout(timeout)
          ws.close()
          reject(err)
        }
      }

      ws.addEventListener('message', handshakeHandler)
    })
  }

  private setupMessageHandler(): void {
    if (!this.ws) return

    this.ws.onmessage = (event: MessageEvent) => {
      if (!this.noiseSession) return

      let plaintext: Uint8Array
      try {
        const raw = new Uint8Array(event.data as ArrayBuffer)
        plaintext = this.noiseSession.decrypt(raw)
      } catch (err) {
        this.close()
        return
      }

      let parsed: any
      try {
        parsed = JSON.parse(new TextDecoder().decode(plaintext))
      } catch {
        return
      }

      const id = parsed?.id
      if (id !== undefined && this.pendingRequests.has(id)) {
        const pending = this.pendingRequests.get(id)!
        this.pendingRequests.delete(id)
        clearTimeout(pending.timer)

        if (parsed.error) {
          const codeName = parsed.error.name ?? 'RemoteProtocolError'
          const detail = parsed.error.message ?? 'RPC error'
          const msg = detail.startsWith(codeName) ? detail : `${codeName}: ${detail}`
          const err = new RemoteProtocolError(codeName, msg)
          pending.reject(err)
        } else {
          pending.resolve(parsed.result)
        }
      } else {
        // Event broadcast
        for (const listener of this.eventListeners) {
          try {
            listener(parsed)
          } catch {}
        }
      }
    }

    this.ws.onclose = () => {
      this.handleClose()
    }
  }

  private handleClose(): void {
    this.isConnected = false
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new RemoteCryptoError('HANDSHAKE_FAILED', 'connection closed'))
    }
    this.pendingRequests.clear()
    if (this.noiseSession) {
      this.noiseSession.close()
    }
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
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
    if (!this.isOpen() || !this.noiseSession || !this.ws) {
      throw new RemoteCryptoError('HANDSHAKE_STATE_INVALID', 'carrier connection is not open')
    }

    this.requestSeq += 1
    const requestId = options?.customId !== undefined ? String(options.customId) : `req-${this.requestSeq}`

    const requestPayload: any = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      connectionEpoch: options?.connectionEpoch ?? this.connectionEpoch,
      requestSeq: options?.requestSeq ?? this.requestSeq,
      params: params ?? {},
    }

    if (options?.idempotencyKey !== undefined) {
      requestPayload.idempotencyKey = options.idempotencyKey
    }

    const raw = new TextEncoder().encode(JSON.stringify(requestPayload))
    const ciphertext = this.noiseSession.encrypt(raw)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new RemoteProtocolError('INVALID_REQUEST', `request timeout: ${method}`))
      }, this.options.requestTimeoutMs ?? 5000)

      this.pendingRequests.set(requestId, { resolve, reject, timer: timeout })

      try {
        this.ws!.send(ciphertext)
      } catch (err) {
        clearTimeout(timeout)
        this.pendingRequests.delete(requestId)
        reject(err)
      }
    })
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close()
      } catch {}
      this.ws = undefined
    }
    this.handleClose()
  }
}
