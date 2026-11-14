import { createHash, randomUUID } from 'node:crypto'
import { RemoteCryptoError } from '../crypto/errors.js'
import { computeFingerprint } from '../crypto/host-identity.js'
import { NoiseInitiatorSession } from '../crypto/noise.js'
import { RemoteProtocolError, type RemoteErrorCode } from '../errors.js'
import {
  REMOTE_PROTOCOL_VERSION,
  type WorkspaceUploadChunkResult,
  type WorkspaceUploadCommitResult,
  type WorkspaceUploadOpenResult,
} from '../protocol.js'
import { validateSafeUploadFilename } from '../workspace-upload.js'
import {
  defaultSleep,
  reconnectDelayMs,
  resolveReconnectPolicy,
  type FramedClientTransport,
  type ReconnectBackoffPolicy,
  type RemoteTransportKind,
} from './transport.js'

export interface RemoteClientSessionOptions {
  readonly clientKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array }
  readonly hostPublicKey: Uint8Array
  readonly handshakeTimeoutMs?: number | undefined
  readonly requestTimeoutMs?: number | undefined
  readonly sleep?: ((delayMs: number) => Promise<void>) | undefined
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function isRevocationError(error: unknown): boolean {
  return error instanceof RemoteCryptoError && error.code === 'DEVICE_REVOKED'
}

/**
 * Transport-independent Noise IK initiator + JSON-RPC 2.0 remote client session.
 * Survives carrier switches (LAN <-> WebRTC <-> Relay) while preserving identity,
 * confirmed resume sequence cursors, and idempotency semantics.
 */
export class RemoteClientSession {
  readonly deviceId: string
  private readonly options: RemoteClientSessionOptions
  private transport: FramedClientTransport | undefined = undefined
  private noiseSession: NoiseInitiatorSession | undefined = undefined
  private isConnected = false
  private revoked = false
  private revokedReason: string | undefined = undefined
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
  private lastRttMs: number | undefined

  constructor(options: RemoteClientSessionOptions) {
    this.options = options
    this.deviceId = computeFingerprint(options.clientKeyPair.publicKey)
  }

  getTransport(): FramedClientTransport | undefined {
    return this.transport
  }

  getTransportKind(): RemoteTransportKind | undefined {
    return this.transport?.kind
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
    return this.isConnected && this.transport !== undefined && this.transport.isOpen()
  }

  isRevoked(): boolean {
    return this.revoked
  }

  getRevokedReason(): string | undefined {
    return this.revokedReason
  }

  getLastRttMs(): number | undefined {
    return this.lastRttMs
  }

  async pingWithLatency(): Promise<{ readonly ok: true; readonly rttMs: number }> {
    const start = performance.now()
    await this.request('ping')
    const rttMs = Math.max(0, Math.round((performance.now() - start) * 100) / 100)
    this.lastRttMs = rttMs
    return { ok: true, rttMs }
  }

  async connectWithTransport(
    transportFactory: () => FramedClientTransport,
  ): Promise<void> {
    if (this.isOpen()) return
    if (this.isConnected || this.transport) {
      this.handleClose(this.transport)
    }
    this.revoked = false
    this.revokedReason = undefined

    const noise = new NoiseInitiatorSession(
      this.options.clientKeyPair,
      this.options.hostPublicKey,
    )
    this.noiseSession = noise

    const transport = transportFactory()
    this.transport = transport

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let stage: 'WAIT_MSG2' | 'WAIT_COMPLETE' | 'ACTIVE' = 'WAIT_MSG2'

      let timeout: NodeJS.Timeout | undefined = undefined
      const clearHandshakeTimer = (): void => {
        if (timeout !== undefined) {
          clearTimeout(timeout)
          timeout = undefined
        }
      }
      const startHandshakeTimer = (): void => {
        if (settled || timeout !== undefined) return
        timeout = setTimeout(() => {
          finishFailure(new RemoteCryptoError('HANDSHAKE_FAILED', 'client connection timeout'))
        }, this.options.handshakeTimeoutMs ?? 5000)
      }

      const finishFailure = (error: Error): void => {
        if (settled) return
        settled = true
        clearHandshakeTimer()
        if (this.transport === transport) {
          this.isConnected = false
          this.transport = undefined
        }
        try {
          noise.close()
        } catch {}
        if (this.noiseSession === noise) {
          this.noiseSession = undefined
        }
        try {
          transport.close()
        } catch {}
        reject(error)
      }

      if (transport.kind === 'lan') {
        // LAN upgrade has no separate pre-Noise ICE negotiation budget
        startHandshakeTimer()
      }

      transport
        .connect({
          onMessage: (raw) => {
            if (this.transport !== transport) return
            if (stage === 'WAIT_MSG2') {
              try {
                noise.readMessage2(raw)
                stage = 'WAIT_COMPLETE'
              } catch (err) {
                finishFailure(err instanceof Error ? err : new Error(String(err)))
              }
              return
            }

            if (stage === 'WAIT_COMPLETE') {
              if (settled) return
              clearHandshakeTimer()
              try {
                const compPt = noise.decrypt(raw)
                const compParsed = JSON.parse(textDecoder.decode(compPt)) as {
                  type?: unknown
                  reason?: unknown
                  connectionEpoch?: unknown
                }
                if (compParsed?.type === 'peer.revoked') {
                  const reason = this.markRevoked(compParsed.reason)
                  this.notifyEventListeners({ type: 'peer.revoked', reason })
                  finishFailure(new RemoteCryptoError('DEVICE_REVOKED', reason))
                  return
                }
                if (
                  !Number.isSafeInteger(compParsed?.connectionEpoch) ||
                  (compParsed.connectionEpoch as number) < 1
                ) {
                  throw new RemoteCryptoError(
                    'HANDSHAKE_FAILED',
                    'handshake completion did not contain a valid connection epoch',
                  )
                }
                this.connectionEpoch = compParsed.connectionEpoch as number
                this.requestSeq = 0
                this.isConnected = true
                stage = 'ACTIVE'
                settled = true
                resolve()
              } catch (err) {
                finishFailure(err instanceof Error ? err : new Error(String(err)))
              }
              return
            }

            this.handleActiveMessage(transport, raw)
          },
          onError: (err) => {
            if (stage !== 'ACTIVE') {
              finishFailure(err)
            } else {
              this.handleClose(transport)
            }
          },
          onClose: (reason) => {
            if (stage !== 'ACTIVE') {
              finishFailure(
                new RemoteCryptoError(
                  'HANDSHAKE_FAILED',
                  reason ?? 'transport closed during handshake',
                ),
              )
            } else {
              this.handleClose(transport)
            }
          },
        })
        .then(() => {
          if (settled || this.transport !== transport) return
          startHandshakeTimer()
          try {
            const msg1 = noise.writeMessage1()
            transport.send(msg1)
          } catch (err) {
            finishFailure(err instanceof Error ? err : new Error(String(err)))
          }
        })
        .catch((err) => {
          finishFailure(
            err instanceof Error
              ? err
              : new RemoteCryptoError('HANDSHAKE_FAILED', String(err)),
          )
        })
    })
  }

  async connectAgainWithBackoff(
    transportFactory: () => FramedClientTransport,
    policy?: ReconnectBackoffPolicy,
  ): Promise<void> {
    if (this.isOpen()) return
    const resolved = resolveReconnectPolicy(policy)
    const sleep = this.options.sleep ?? defaultSleep
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= resolved.maxAttempts; attempt += 1) {
      if (attempt > 1) {
        await sleep(reconnectDelayMs(attempt - 1, resolved))
      }
      try {
        await this.connectWithTransport(transportFactory)
        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        this.close()
        if (this.revoked || isRevocationError(error)) {
          throw lastError
        }
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

  async reconnectAndResumeWithTransport(
    transportFactory: () => FramedClientTransport,
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
        await this.connectWithTransport(transportFactory)
        const results: Record<string, unknown> = {}
        for (const sessionId of new Set(sessionIds)) {
          results[sessionId] = await this.resumeSession(sessionId)
        }
        return Object.freeze(results)
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        this.close()
        if (this.revoked || isRevocationError(error)) {
          throw lastError
        }
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

  onEvent(listener: (event: unknown) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  async uploadWorkspaceFile(options: {
    readonly sessionId: string
    readonly filename: string
    readonly bytes: Uint8Array
    readonly chunkBytes?: number | undefined
    readonly conflictPolicy?: 'rename' | 'fail' | undefined
    readonly onProgress?: ((sentBytes: number, totalBytes: number) => void) | undefined
  }): Promise<WorkspaceUploadCommitResult> {
    const filename = validateSafeUploadFilename(options.filename)
    const buf = Buffer.isBuffer(options.bytes)
      ? options.bytes
      : Buffer.from(options.bytes.buffer, options.bytes.byteOffset, options.bytes.byteLength)
    if (buf.byteLength < 1) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'workspace upload file must not be empty')
    }
    const sha256 = createHash('sha256').update(buf).digest('hex')
    const transferKey = randomUUID()

    const openResult = (await this.request(
      'workspace.upload.open',
      {
        sessionId: options.sessionId,
        filename,
        sizeBytes: buf.byteLength,
        ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}),
        sha256,
        ...(options.conflictPolicy !== undefined ? { conflictPolicy: options.conflictPolicy } : {}),
      },
      { idempotencyKey: `ws-open-${transferKey}` },
    )) as WorkspaceUploadOpenResult

    const negotiatedChunk = Math.max(1, openResult.chunkBytes)
    let offset = 0
    try {
      while (offset < buf.byteLength) {
        const end = Math.min(buf.byteLength, offset + negotiatedChunk)
        const slice = buf.subarray(offset, end)
        const chunkRes = (await this.request(
          'workspace.upload.chunk',
          {
            uploadId: openResult.uploadId,
            offset,
            dataBase64: slice.toString('base64'),
          },
          { idempotencyKey: `ws-chunk-${openResult.uploadId}-${offset}` },
        )) as WorkspaceUploadChunkResult
        offset = chunkRes.nextOffset
        options.onProgress?.(offset, buf.byteLength)
      }

      return (await this.request(
        'workspace.upload.commit',
        {
          uploadId: openResult.uploadId,
          sha256,
        },
        { idempotencyKey: `ws-commit-${openResult.uploadId}` },
      )) as WorkspaceUploadCommitResult
    } catch (err) {
      if (this.isOpen()) {
        await this.request(
          'workspace.upload.abort',
          { uploadId: openResult.uploadId },
          { idempotencyKey: `ws-abort-${openResult.uploadId}` },
        ).catch(() => {})
      }
      throw err
    }
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
    if (!this.isOpen() || !this.noiseSession || !this.transport) {
      throw new RemoteCryptoError('HANDSHAKE_STATE_INVALID', 'carrier connection is not open')
    }

    this.requestSeq += 1
    const requestId =
      options?.customId !== undefined ? String(options.customId) : `req-${this.requestSeq}`

    const requestPayload: Record<string, unknown> = {
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

    const raw = textEncoder.encode(JSON.stringify(requestPayload))
    const ciphertext = this.noiseSession.encrypt(raw)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new RemoteProtocolError('INVALID_REQUEST', `request timeout: ${method}`))
      }, this.options.requestTimeoutMs ?? 5000)

      this.pendingRequests.set(requestId, { resolve, reject, timer: timeout })

      try {
        this.transport!.send(ciphertext)
      } catch (err) {
        clearTimeout(timeout)
        this.pendingRequests.delete(requestId)
        reject(err)
      }
    })
  }

  close(): void {
    const transport = this.transport
    this.transport = undefined
    if (transport) {
      try {
        transport.close()
      } catch {}
    }
    this.handleClose()
  }

  private handleActiveMessage(transport: FramedClientTransport, raw: Uint8Array): void {
    if (this.transport !== transport || !this.noiseSession) return

    let plaintext: Uint8Array
    try {
      plaintext = this.noiseSession.decrypt(raw)
    } catch {
      this.close()
      return
    }

    let parsed: {
      id?: string | number
      type?: unknown
      reason?: unknown
      sessionId?: unknown
      error?: { name?: string; message?: string }
      result?: unknown
    }
    try {
      parsed = JSON.parse(textDecoder.decode(plaintext)) as typeof parsed
    } catch {
      return
    }

    if (parsed?.type === 'peer.revoked') {
      const reason = this.markRevoked(parsed.reason)
      const revErr = new RemoteCryptoError('DEVICE_REVOKED', reason)
      this.notifyEventListeners({ type: 'peer.revoked', reason })
      this.failPendingRequests(revErr)
      this.close()
      return
    }

    if (parsed?.type === 'stream.reset' && typeof parsed.sessionId === 'string') {
      this.clearResumeState(parsed.sessionId)
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
        pending.reject(new RemoteProtocolError(codeName as RemoteErrorCode, msg))
      } else {
        pending.resolve(parsed.result)
      }
      return
    }

    this.notifyEventListeners(parsed)
  }

  private markRevoked(rawReason: unknown): string {
    const reason =
      typeof rawReason === 'string' && rawReason.length > 0
        ? rawReason
        : 'device revoked by host'
    this.revoked = true
    this.revokedReason = reason
    return reason
  }

  private notifyEventListeners(payload: unknown): void {
    for (const listener of this.eventListeners) {
      try {
        listener(payload)
      } catch {}
    }
  }

  private failPendingRequests(err: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pendingRequests.clear()
  }

  private handleClose(source?: FramedClientTransport): void {
    if (source !== undefined && this.transport !== source) return
    this.isConnected = false
    if (source === undefined || this.transport === source) {
      this.transport = undefined
    }
    this.failPendingRequests(new RemoteCryptoError('HANDSHAKE_FAILED', 'connection closed'))
    if (this.noiseSession) {
      try {
        this.noiseSession.close()
      } catch {}
      this.noiseSession = undefined
    }
  }
}
