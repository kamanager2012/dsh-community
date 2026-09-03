import { RemoteCryptoError } from '../crypto/errors.js'
import { RemoteProtocolError } from '../errors.js'
import { NoiseInitiatorSession } from '../crypto/noise.js'
import { computeFingerprint } from '../crypto/host-identity.js'
import { REMOTE_PROTOCOL_VERSION } from '../protocol.js'

export interface ReconnectBackoffPolicy {
  readonly initialDelayMs?: number
  readonly maxDelayMs?: number
  readonly multiplier?: number
  readonly maxAttempts?: number
}

interface ResolvedReconnectBackoffPolicy {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly multiplier: number
  readonly maxAttempts: number
}

export interface LanClientCarrierOptions {
  readonly clientKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array }
  readonly hostPublicKey: Uint8Array
  readonly endpointUrl: string
  readonly handshakeTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly sleep?: (delayMs: number) => Promise<void>
}

const DEFAULT_RECONNECT_POLICY: ResolvedReconnectBackoffPolicy = Object.freeze({
  initialDelayMs: 100,
  maxDelayMs: 2_000,
  multiplier: 2,
  maxAttempts: 5,
})

function positiveFiniteInteger(name: string, value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RemoteProtocolError(
      'INVALID_REQUEST',
      name + ' must be an integer between 1 and ' + String(max),
    )
  }
  return value
}

function resolveReconnectPolicy(
  policy: ReconnectBackoffPolicy | undefined,
): ResolvedReconnectBackoffPolicy {
  const initialDelayMs = positiveFiniteInteger(
    'initialDelayMs',
    policy?.initialDelayMs ?? DEFAULT_RECONNECT_POLICY.initialDelayMs,
    60_000,
  )
  const maxDelayMs = positiveFiniteInteger(
    'maxDelayMs',
    policy?.maxDelayMs ?? DEFAULT_RECONNECT_POLICY.maxDelayMs,
    60_000,
  )
  const maxAttempts = positiveFiniteInteger(
    'maxAttempts',
    policy?.maxAttempts ?? DEFAULT_RECONNECT_POLICY.maxAttempts,
    32,
  )
  const multiplier = policy?.multiplier ?? DEFAULT_RECONNECT_POLICY.multiplier
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10) {
    throw new RemoteProtocolError(
      'INVALID_REQUEST',
      'multiplier must be finite and between 1 and 10',
    )
  }
  if (maxDelayMs < initialDelayMs) {
    throw new RemoteProtocolError(
      'INVALID_REQUEST',
      'maxDelayMs cannot be smaller than initialDelayMs',
    )
  }
  return Object.freeze({ initialDelayMs, maxDelayMs, multiplier, maxAttempts })
}

export function reconnectDelayMs(
  retryIndex: number,
  policy?: ReconnectBackoffPolicy,
): number {
  if (!Number.isSafeInteger(retryIndex) || retryIndex < 1) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'retryIndex must be a positive integer')
  }
  const resolved = resolveReconnectPolicy(policy)
  const raw = resolved.initialDelayMs * Math.pow(resolved.multiplier, retryIndex - 1)
  return Math.min(resolved.maxDelayMs, Math.max(1, Math.round(raw)))
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
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
  private readonly lastConfirmedSeqBySession = new Map<string, number>()

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

  getLastConfirmedSeq(sessionId: string): number | undefined {
    return this.lastConfirmedSeqBySession.get(sessionId)
  }

  isOpen(): boolean {
    return this.isConnected && this.ws !== undefined && this.ws.readyState === WebSocket.OPEN
  }

  async connect(): Promise<void> {
    if (this.isOpen()) return
    if (this.isConnected) this.handleClose(this.ws)

    this.noiseSession = new NoiseInitiatorSession(
      this.options.clientKeyPair,
      this.options.hostPublicKey,
    )

    const ws = new WebSocket(this.options.endpointUrl)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finishFailure = (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (this.ws === ws) {
          this.isConnected = false
          this.ws = undefined
        }
        try {
          this.noiseSession?.close()
        } catch {}
        try {
          ws.close()
        } catch {}
        reject(error)
      }

      const timeout = setTimeout(() => {
        finishFailure(new RemoteCryptoError('HANDSHAKE_FAILED', 'client connection timeout'))
      }, this.options.handshakeTimeoutMs ?? 5000)

      ws.onopen = () => {
        try {
          const msg1 = this.noiseSession!.writeMessage1()
          ws.send(msg1)
        } catch (err) {
          finishFailure(err instanceof Error ? err : new Error(String(err)))
        }
      }

      ws.onerror = (err) => {
        finishFailure(
          new RemoteCryptoError(
            'HANDSHAKE_FAILED',
            'websocket error: ' + String((err as any).message ?? 'connect failed'),
          ),
        )
      }

      ws.onclose = (event) => {
        finishFailure(
          new RemoteCryptoError(
            'HANDSHAKE_FAILED',
            'websocket closed during handshake (code ' +
              String(event.code) +
              ': ' +
              String(event.reason || 'closed') +
              ')',
          ),
        )
      }

      const handshakeHandler = (event: MessageEvent) => {
        try {
          const raw = new Uint8Array(event.data as ArrayBuffer)
          this.noiseSession!.readMessage2(raw)
          ws.removeEventListener('message', handshakeHandler)

          const completionHandler = (compEvt: MessageEvent) => {
            if (settled) return
            clearTimeout(timeout)
            ws.removeEventListener('message', completionHandler)

            try {
              const compRaw = new Uint8Array(compEvt.data as ArrayBuffer)
              const compPt = this.noiseSession!.decrypt(compRaw)
              const compParsed = JSON.parse(new TextDecoder().decode(compPt))
              if (!Number.isSafeInteger(compParsed?.connectionEpoch) || compParsed.connectionEpoch < 1) {
                throw new RemoteCryptoError(
                  'HANDSHAKE_FAILED',
                  'handshake completion did not contain a valid connection epoch',
                )
              }
              this.connectionEpoch = compParsed.connectionEpoch
              this.requestSeq = 0
              this.isConnected = true
              settled = true
              this.setupMessageHandler(ws)
              resolve()
            } catch (err) {
              finishFailure(err instanceof Error ? err : new Error(String(err)))
            }
          }

          ws.addEventListener('message', completionHandler)
        } catch (err) {
          finishFailure(err instanceof Error ? err : new Error(String(err)))
        }
      }

      ws.addEventListener('message', handshakeHandler)
    })
  }

  async reconnectWithBackoff(policy?: ReconnectBackoffPolicy): Promise<void> {
    if (this.isOpen()) return
    const resolved = resolveReconnectPolicy(policy)
    const sleep = this.options.sleep ?? defaultSleep
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= resolved.maxAttempts; attempt += 1) {
      if (attempt > 1) {
        await sleep(reconnectDelayMs(attempt - 1, resolved))
      }
      try {
        await this.connect()
        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        this.close()
      }
    }

    throw (
      lastError ??
      new RemoteCryptoError('HANDSHAKE_FAILED', 'reconnect attempts exhausted')
    )
  }

  async resumeSession(sessionId: string): Promise<any> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'sessionId must be a non-empty string')
    }
    const afterSeq = this.lastConfirmedSeqBySession.get(sessionId)
    return this.request(
      'session.attach',
      afterSeq === undefined ? { sessionId } : { sessionId, afterSeq },
    )
  }

  async acknowledgeSessionSeq(sessionId: string, seq: number): Promise<any> {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'seq must be a non-negative integer')
    }
    const result = await this.request('stream.ack', { sessionId, seq })
    const current = this.lastConfirmedSeqBySession.get(sessionId)
    if (current === undefined || seq > current) {
      this.lastConfirmedSeqBySession.set(sessionId, seq)
    }
    return result
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
        await this.connect()
        const results: Record<string, unknown> = {}
        for (const sessionId of new Set(sessionIds)) {
          results[sessionId] = await this.resumeSession(sessionId)
        }
        return Object.freeze(results)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        this.close()
      }
    }

    throw (
      lastError ??
      new RemoteCryptoError('HANDSHAKE_FAILED', 'reconnect-and-resume attempts exhausted')
    )
  }

  clearResumeState(sessionId?: string): void {
    if (sessionId === undefined) {
      this.lastConfirmedSeqBySession.clear()
      return
    }
    this.lastConfirmedSeqBySession.delete(sessionId)
  }

  private setupMessageHandler(ws: WebSocket): void {
    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws || !this.noiseSession) return

      let plaintext: Uint8Array
      try {
        const raw = new Uint8Array(event.data as ArrayBuffer)
        plaintext = this.noiseSession.decrypt(raw)
      } catch {
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
          const msg = detail.startsWith(codeName) ? detail : codeName + ': ' + detail
          const err = new RemoteProtocolError(codeName, msg)
          pending.reject(err)
        } else {
          pending.resolve(parsed.result)
        }
      } else {
        for (const listener of this.eventListeners) {
          try {
            listener(parsed)
          } catch {}
        }
      }
    }

    ws.onerror = () => {
      this.handleClose(ws)
    }

    ws.onclose = () => {
      this.handleClose(ws)
    }
  }

  private handleClose(source?: WebSocket): void {
    if (source !== undefined && this.ws !== source) return
    this.isConnected = false
    if (source === undefined || this.ws === source) {
      this.ws = undefined
    }
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new RemoteCryptoError('HANDSHAKE_FAILED', 'connection closed'))
    }
    this.pendingRequests.clear()
    if (this.noiseSession) {
      try {
        this.noiseSession.close()
      } catch {}
      this.noiseSession = undefined
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
    const requestId = options?.customId !== undefined ? String(options.customId) : 'req-' + String(this.requestSeq)

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
        reject(new RemoteProtocolError('INVALID_REQUEST', 'request timeout: ' + method))
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
    const ws = this.ws
    this.ws = undefined
    if (ws) {
      try {
        ws.close()
      } catch {}
    }
    this.handleClose()
  }
}
