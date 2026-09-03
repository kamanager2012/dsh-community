import type { Socket } from 'node:net'
import { RemoteCryptoError } from '../crypto/errors.js'
import { RemoteProtocolError } from '../errors.js'
import { NoiseResponderSession } from '../crypto/noise.js'
import { ConnectionEpochAllocator } from '../crypto/epoch.js'
import type { DeviceTrustStore } from '../crypto/device-trust.js'
import type { HostIdentityStore, HostKeyPair } from '../crypto/host-identity.js'
import type { PairingCoordinator } from '../crypto/pairing-coordinator.js'
import type { RemoteAdapterCore } from '../core.js'
import type { AuthenticatedPeer, RemoteRequest } from '../protocol.js'
import {
  encodeWebSocketFrame,
  encodeCloseFrame,
  WebSocketFrameParser,
  WebSocketOpcode,
  type WebSocketFrame,
} from './websocket-frame.js'
import type { LanCarrierBounds } from './constants.js'

export type ConnectionSecurityState =
  | 'CONNECTED'
  | 'NOISE_HANDSHAKE'
  | 'CHANNEL_AUTHENTICATED'
  | 'PAIRING_PENDING'
  | 'DEVICE_AUTHORIZED'
  | 'ACTIVE'
  | 'CLOSED'

export interface LanConnectionContext {
  readonly core: RemoteAdapterCore
  readonly trustStore: DeviceTrustStore
  readonly hostIdentityStore: HostIdentityStore
  readonly hostKeyPair: HostKeyPair
  readonly epochAllocator: ConnectionEpochAllocator
  readonly pairingCoordinator?: PairingCoordinator | undefined
  readonly bounds: LanCarrierBounds
  readonly onPeerAuthenticated: (peer: AuthenticatedPeer, conn: LanConnection) => void
  readonly onClosed: (conn: LanConnection) => void
}

export class LanConnection {
  readonly id: string
  private state: ConnectionSecurityState = 'CONNECTED'
  private peer: AuthenticatedPeer | undefined = undefined
  private noiseSession: NoiseResponderSession | undefined = undefined
  private readonly parser: WebSocketFrameParser
  private handshakeTimer: NodeJS.Timeout | undefined = undefined
  private idleTimer: NodeJS.Timeout | undefined = undefined
  private pendingInboundWork = 0
  private pendingOutboundFrames = 0

  constructor(
    readonly socket: Socket,
    private readonly ctx: LanConnectionContext,
    id: string,
    initialHead?: Buffer,
  ) {
    this.id = id
    this.noiseSession = new NoiseResponderSession(ctx.hostKeyPair)

    this.parser = new WebSocketFrameParser(
      ctx.bounds.maxFrameBytes,
      true, // client-to-server frames must be masked
      {
        onFrame: (frame) => {
          try {
            this.handleFrame(frame)
          } catch {
            this.terminate(1008, 'internal frame error')
          }
        },
        onTextFrameRejected: () => {
          this.terminate(1003, 'text WebSocket frames are strictly forbidden')
        },
        onOversizedFrame: (size, limit) => {
          this.terminate(1009, `frame size (${size}) exceeds limit (${limit})`)
        },
        onProtocolError: (reason) => {
          this.terminate(1002, `protocol error: ${reason}`)
        },
      },
    )

    this.setupSocketListeners()
    this.startHandshakeTimeout()

    // Process initial head if any was buffered during HTTP upgrade
    if (initialHead && initialHead.length > 0) {
      try {
        this.parser.push(initialHead)
      } catch {
        this.terminate(1008, 'error processing initial head')
      }
    }
  }

  getState(): ConnectionSecurityState {
    return this.state
  }

  getPeer(): AuthenticatedPeer | undefined {
    return this.peer
  }

  private setupSocketListeners(): void {
    this.socket.on('data', (chunk: Buffer) => {
      try {
        this.resetIdleTimeout()
        this.parser.push(chunk)
      } catch {
        this.terminate(1008, 'internal socket processing error')
      }
    })

    this.socket.on('error', () => {
      this.cleanup()
    })

    this.socket.on('close', () => {
      this.cleanup()
    })
  }

  private startHandshakeTimeout(): void {
    this.handshakeTimer = setTimeout(() => {
      if (this.state === 'CONNECTED' || this.state === 'NOISE_HANDSHAKE') {
        this.terminate(1008, 'handshake timeout')
      }
    }, this.ctx.bounds.handshakeTimeoutMs)
  }

  private resetIdleTimeout(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
    }
    this.idleTimer = setTimeout(() => {
      this.terminate(1000, 'idle timeout')
    }, this.ctx.bounds.idleTimeoutMs)
  }

  private cleanup(): void {
    if (this.state === 'CLOSED') return
    this.state = 'CLOSED'

    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = undefined
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }

    if (this.peer) {
      try {
        this.ctx.core.closeConnection(this.peer)
      } catch {}
    }

    if (this.noiseSession) {
      try {
        this.noiseSession.close()
      } catch {}
      this.noiseSession = undefined
    }

    try {
      this.ctx.onClosed(this)
    } catch {}
  }

  terminate(code = 1000, reason = ''): void {
    if (this.state === 'CLOSED') return

    try {
      if (this.socket.writable) {
        const closeFrame = encodeCloseFrame(code, reason)
        this.socket.write(closeFrame)
      }
    } catch {}

    this.cleanup()
    try {
      this.socket.destroy()
    } catch {}
  }

  private sendEncrypted(plaintext: Uint8Array): void {
    if (this.state === 'CLOSED' || !this.noiseSession) {
      return
    }

    // P0-4: Check outbound frame size BEFORE encryption & allocation
    // Noise adds 16-byte Poly1305 MAC to plaintext
    const expectedCipherLength = plaintext.byteLength + 16
    if (expectedCipherLength > this.ctx.bounds.maxFrameBytes) {
      this.terminate(1009, 'outbound frame size exceeds maxFrameBytes')
      return
    }

    // Outbound queue & buffer check
    if (
      this.socket.writableLength + expectedCipherLength > this.ctx.bounds.maxBufferedEventBytes ||
      this.pendingOutboundFrames >= this.ctx.bounds.maxOutboundQueue
    ) {
      this.terminate(1008, 'slow client: outbound buffer high-water mark exceeded')
      return
    }

    let ciphertext: Uint8Array
    try {
      ciphertext = this.noiseSession.encrypt(plaintext)
    } catch {
      this.terminate(1008, 'encryption failure')
      return
    }

    if (ciphertext.byteLength > this.ctx.bounds.maxFrameBytes) {
      this.terminate(1009, 'outbound ciphertext exceeds maxFrameBytes')
      return
    }

    const frame = encodeWebSocketFrame(ciphertext, WebSocketOpcode.BINARY)
    this.pendingOutboundFrames += 1

    this.socket.write(frame, () => {
      this.pendingOutboundFrames = Math.max(0, this.pendingOutboundFrames - 1)
    })
  }

  sendEvent(event: unknown): void {
    if (this.state !== 'ACTIVE') return
    const raw = new TextEncoder().encode(JSON.stringify(event))
    this.sendEncrypted(raw)
  }

  private handleFrame(frame: WebSocketFrame): void {
    if (this.state === 'CLOSED') return

    switch (frame.opcode) {
      case WebSocketOpcode.CLOSE: {
        this.terminate(1000, 'client closed')
        return
      }

      case WebSocketOpcode.PING: {
        // P0-3: Bound PONG write using unified bounds check
        if (
          this.socket.writableLength + frame.payload.byteLength > this.ctx.bounds.maxBufferedEventBytes ||
          this.pendingOutboundFrames >= this.ctx.bounds.maxOutboundQueue
        ) {
          this.terminate(1008, 'slow client: buffer high-water mark exceeded on ping')
          return
        }

        const pong = encodeWebSocketFrame(frame.payload, WebSocketOpcode.PONG)
        this.pendingOutboundFrames += 1
        this.socket.write(pong, () => {
          this.pendingOutboundFrames = Math.max(0, this.pendingOutboundFrames - 1)
        })
        return
      }

      case WebSocketOpcode.PONG: {
        return
      }

      case WebSocketOpcode.BINARY: {
        this.handleBinaryPayload(frame.payload)
        return
      }

      default: {
        this.terminate(1002, `unsupported opcode ${frame.opcode}`)
        return
      }
    }
  }

  private handleBinaryPayload(payload: Uint8Array): void {
    // Plaintext JSON guard at carrier boundary: reject if starts with ASCII '{'
    if (payload.length > 0 && payload[0] === 0x7b) {
      this.terminate(1003, 'unencrypted plaintext JSON frame rejected; binary Noise ciphertext required')
      return
    }

    if (this.state === 'CONNECTED' || this.state === 'NOISE_HANDSHAKE') {
      this.handleHandshakeMessage(payload)
      return
    }

    // P0-2: Unified Inbound Work Budget for PAIRING_PENDING, ACTIVE, and all async work
    if (this.pendingInboundWork >= this.ctx.bounds.maxInboundQueue) {
      this.terminate(1008, 'inbound work budget exceeded')
      return
    }

    this.pendingInboundWork += 1

    const workPromise =
      this.state === 'PAIRING_PENDING'
        ? this.handlePairingPendingPayload(payload)
        : this.state === 'ACTIVE'
          ? this.handleActivePayload(payload)
          : Promise.reject(new Error(`cannot process frames in state ${this.state}`))

    workPromise
      .catch(() => {
        this.terminate(1008, 'inbound work execution failure')
      })
      .finally(() => {
        this.pendingInboundWork = Math.max(0, this.pendingInboundWork - 1)
      })
  }

  private handleHandshakeMessage(message1: Uint8Array): void {
    if (message1.byteLength > this.ctx.bounds.maxHandshakeBytes) {
      this.terminate(1009, 'handshake message exceeds maxHandshakeBytes')
      return
    }

    if (!this.noiseSession) {
      this.terminate(1008, 'missing noise session')
      return
    }

    this.state = 'NOISE_HANDSHAKE'

    let remotePeer: { staticPublicKey: Uint8Array; deviceId: string }
    let message2: Uint8Array

    try {
      remotePeer = this.noiseSession.readMessage1(message1)
      message2 = this.noiseSession.writeMessage2()
    } catch {
      this.terminate(1008, 'handshake authentication failed')
      return
    }

    // Handshake succeeded: send Message 2 back to client
    const frame = encodeWebSocketFrame(message2, WebSocketOpcode.BINARY)
    this.socket.write(frame)

    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = undefined
    }

    this.state = 'CHANNEL_AUTHENTICATED'

    const epoch = this.ctx.epochAllocator.allocateNext()
    this.peer = this.ctx.epochAllocator.bindPeer(remotePeer.deviceId, epoch)

    try {
      this.ctx.onPeerAuthenticated(this.peer, this)
    } catch {
      this.terminate(1008, 'peer authentication hook failed')
      return
    }

    // Evaluate device authorization (contained against store throw)
    this.evaluateAuthorization()

    if ((this.state as ConnectionSecurityState) === 'CLOSED') return

    // Send encrypted handshake completion frame informing client of connectionEpoch
    this.sendEncrypted(
      new TextEncoder().encode(
        JSON.stringify({
          type: 'handshake.complete',
          connectionEpoch: epoch,
          state: this.state,
        }),
      ),
    )
  }

  private evaluateAuthorization(): void {
    if (!this.peer) return

    let record: ReturnType<DeviceTrustStore['getSync']>
    try {
      record = this.ctx.trustStore.getSync(this.peer.deviceId)
    } catch {
      // P0-6: Contain poisoned store exceptions
      this.terminate(1008, 'trust store error during device lookup')
      return
    }

    const hostTrustDomain = this.ctx.hostKeyPair.identity.trustDomainId

    if (!record) {
      this.state = 'PAIRING_PENDING'
      return
    }

    if (record.revokedAt !== undefined) {
      this.terminate(1008, 'device is revoked')
      return
    }

    if (record.trustDomainId !== hostTrustDomain) {
      this.state = 'PAIRING_PENDING'
      return
    }

    try {
      this.ctx.trustStore.recordSeenSync(this.peer.deviceId)
    } catch {
      this.terminate(1008, 'trust store error during record seen')
      return
    }

    this.state = 'DEVICE_AUTHORIZED'
    this.state = 'ACTIVE'
  }

  private async handlePairingPendingPayload(ciphertext: Uint8Array): Promise<void> {
    if (!this.noiseSession || !this.peer) {
      this.terminate(1008, 'unauthenticated channel')
      return
    }

    let plaintext: Uint8Array
    try {
      plaintext = this.noiseSession.decrypt(ciphertext)
    } catch {
      this.terminate(1008, 'ciphertext verification failed')
      return
    }

    let parsed: any
    try {
      parsed = JSON.parse(new TextDecoder().decode(plaintext))
    } catch {
      this.terminate(1002, 'malformed payload')
      return
    }

    // Channel is unpaired: only pairing methods allowed
    const method = parsed?.method
    if (method === 'pairing.request') {
      await this.handlePairingRequest(parsed)
      return
    }

    // Ordinary RPC rejected in PAIRING_PENDING
    const errorResponse = {
      jsonrpc: '2.0',
      id: parsed?.id ?? null,
      error: {
        code: -32001,
        name: 'UNAUTHORIZED_CHANNEL',
        message: `UNAUTHORIZED_CHANNEL: channel is in state PAIRING_PENDING and cannot dispatch application RPC '${method}'`,
      },
    }
    this.sendEncrypted(new TextEncoder().encode(JSON.stringify(errorResponse)))
  }

  private async handlePairingRequest(request: any): Promise<void> {
    if (!this.ctx.pairingCoordinator || !this.noiseSession) {
      const errResp = {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: 'pairing coordinator not configured on host' },
      }
      this.sendEncrypted(new TextEncoder().encode(JSON.stringify(errResp)))
      return
    }

    try {
      const candidate = await this.ctx.pairingCoordinator.initiatePairing(this.noiseSession, {
        token: request.params?.token,
        displayName: request.params?.displayName,
      })

      const successResp = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          candidateId: candidate.candidateId,
          expiresAt: candidate.expiresAt,
          maxAllowedCapabilities: candidate.maxAllowedCapabilities,
        },
      }
      this.sendEncrypted(new TextEncoder().encode(JSON.stringify(successResp)))
    } catch (err) {
      const code = (err as any).code ?? 'PAIRING_FAILED'
      const errResp = {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32000,
          name: code,
          message: `${code}: ${(err as Error).message}`,
        },
      }
      this.sendEncrypted(new TextEncoder().encode(JSON.stringify(errResp)))
    }
  }

  private async handleActivePayload(ciphertext: Uint8Array): Promise<void> {
    if (!this.noiseSession || !this.peer) {
      this.terminate(1008, 'session not authenticated')
      return
    }

    let plaintext: Uint8Array
    try {
      plaintext = this.noiseSession.decrypt(ciphertext)
    } catch {
      // Crypto authentication failure: close immediately, drop cipher
      this.terminate(1008, 'ciphertext verification failed')
      return
    }

    let requestObj: unknown
    try {
      requestObj = JSON.parse(new TextDecoder().decode(plaintext))
    } catch {
      this.terminate(1002, 'malformed JSON payload')
      return
    }

    try {
      const result = await this.ctx.core.handle(this.peer, requestObj)
      const requestId = (requestObj as Record<string, unknown>)?.id

      const successResp = {
        jsonrpc: '2.0',
        id: requestId,
        result,
      }
      this.sendEncrypted(new TextEncoder().encode(JSON.stringify(successResp)))
    } catch (err) {
      const requestId = (requestObj as Record<string, unknown>)?.id
      const errCode = (err as any).code ?? 'INVALID_REQUEST'
      const errResp = {
        jsonrpc: '2.0',
        id: requestId ?? null,
        error: {
          code: -32000,
          name: errCode,
          message: `${errCode}: ${(err as Error).message}`,
        },
      }
      this.sendEncrypted(new TextEncoder().encode(JSON.stringify(errResp)))
    }
  }
}
