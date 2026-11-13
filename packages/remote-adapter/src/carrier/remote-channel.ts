import { ConnectionEpochAllocator } from '../crypto/epoch.js'
import type { DeviceTrustStore } from '../crypto/device-trust.js'
import type { HostIdentityStore, HostKeyPair } from '../crypto/host-identity.js'
import { NoiseResponderSession } from '../crypto/noise.js'
import type { PairingCoordinator } from '../crypto/pairing-coordinator.js'
import type { RemoteAdapterCore } from '../core.js'
import type { AuthenticatedPeer } from '../protocol.js'
import type { LanCarrierBounds } from './constants.js'
import type { FramedMessageTransport } from './transport.js'

export type ConnectionSecurityState =
  | 'CONNECTED'
  | 'NOISE_HANDSHAKE'
  | 'CHANNEL_AUTHENTICATED'
  | 'PAIRING_PENDING'
  | 'DEVICE_AUTHORIZED'
  | 'ACTIVE'
  | 'CLOSED'

export interface RemoteServerChannelContext {
  readonly core: RemoteAdapterCore
  readonly trustStore: DeviceTrustStore
  readonly hostIdentityStore: HostIdentityStore
  readonly hostKeyPair: HostKeyPair
  readonly epochAllocator: ConnectionEpochAllocator
  readonly pairingCoordinator?: PairingCoordinator | undefined
  readonly bounds: LanCarrierBounds
  readonly onPeerAuthenticated: (peer: AuthenticatedPeer, channel: RemoteServerChannel) => void
  readonly onClosed: (channel: RemoteServerChannel) => void
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * Transport-independent Noise IK responder channel executing handshake,
 * pairing gate, capability authorization, backpressure, and RPC dispatch.
 */
export class RemoteServerChannel {
  readonly id: string
  private state: ConnectionSecurityState = 'CONNECTED'
  private peer: AuthenticatedPeer | undefined = undefined
  private noiseSession: NoiseResponderSession | undefined = undefined
  private handshakeTimer: NodeJS.Timeout | undefined = undefined
  private idleTimer: NodeJS.Timeout | undefined = undefined
  private pendingInboundWork = 0
  private pendingOutboundFrames = 0
  private revokeCloseTimer: NodeJS.Timeout | undefined = undefined

  constructor(
    readonly transport: FramedMessageTransport,
    private readonly ctx: RemoteServerChannelContext,
    id: string,
  ) {
    this.id = id
    this.noiseSession = new NoiseResponderSession(ctx.hostKeyPair)

    this.transport.setHandlers({
      onMessage: (payload) => {
        try {
          this.resetIdleTimeout()
          this.handleBinaryPayload(payload)
        } catch {
          this.terminate(1008, 'internal frame error')
        }
      },
      onError: () => {
        this.cleanup()
      },
      onClose: () => {
        this.cleanup()
      },
    })

    this.startHandshakeTimeout()
  }

  getState(): ConnectionSecurityState {
    return this.state
  }

  getPeer(): AuthenticatedPeer | undefined {
    return this.peer
  }

  private startHandshakeTimeout(): void {
    this.handshakeTimer = setTimeout(() => {
      if (this.state === 'CONNECTED' || this.state === 'NOISE_HANDSHAKE') {
        this.terminate(1008, 'handshake timeout')
      }
    }, this.ctx.bounds.handshakeTimeoutMs)
  }

  resetIdleTimeout(): void {
    if (this.state === 'CLOSED') return
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
    if (this.revokeCloseTimer) {
      clearTimeout(this.revokeCloseTimer)
      this.revokeCloseTimer = undefined
    }
    if (this.state === 'CLOSED') return
    this.cleanup()
    try {
      this.transport.close(code, reason)
    } catch {}
  }

  /**
   * Sends a best-effort encrypted `peer.revoked` notification before closing
   * the transport, while synchronously moving the channel to `CLOSED` so no
   * further RPCs or events can be processed for the revoked peer.
   */
  notifyRevoked(reason = 'device revoked', code = 1008): void {
    if (this.state === 'CLOSED') return

    const closeTransport = (): void => {
      if (this.revokeCloseTimer) {
        clearTimeout(this.revokeCloseTimer)
        this.revokeCloseTimer = undefined
      }
      try {
        this.transport.close(code, reason)
      } catch {}
    }

    const scheduleDelayedClose = (delayMs: number): void => {
      if (this.revokeCloseTimer) {
        clearTimeout(this.revokeCloseTimer)
      }
      this.revokeCloseTimer = setTimeout(closeTransport, delayMs)
      this.revokeCloseTimer.unref?.()
    }

    const canSendNotice =
      this.noiseSession !== undefined &&
      this.transport.isWritable() &&
      (this.state === 'CHANNEL_AUTHENTICATED' ||
        this.state === 'PAIRING_PENDING' ||
        this.state === 'DEVICE_AUTHORIZED' ||
        this.state === 'ACTIVE')

    let queued = false
    if (canSendNotice) {
      // Reserve fallback close before queuing write so synchronous transport flushes shrink delay cleanly.
      scheduleDelayedClose(80)
      queued = this.sendEncrypted(
        textEncoder.encode(JSON.stringify({ type: 'peer.revoked', reason })),
        () => scheduleDelayedClose(15),
      )
    }

    this.cleanup()

    if (!queued) {
      closeTransport()
    }
  }

  canWriteControlBytes(byteLength: number): boolean {
    if (this.state === 'CLOSED' || !this.transport.isWritable()) return false
    if (
      this.transport.getBufferedBytes() + byteLength > this.ctx.bounds.maxBufferedEventBytes ||
      this.pendingOutboundFrames >= this.ctx.bounds.maxOutboundQueue
    ) {
      this.terminate(1008, 'slow client: buffer high-water mark exceeded')
      return false
    }
    return true
  }

  trackControlSend(): () => void {
    this.pendingOutboundFrames += 1
    let done = false
    return () => {
      if (done) return
      done = true
      this.pendingOutboundFrames = Math.max(0, this.pendingOutboundFrames - 1)
    }
  }

  private sendEncrypted(plaintext: Uint8Array, onFlushed?: () => void): boolean {
    if (this.state === 'CLOSED' || !this.noiseSession || !this.transport.isWritable()) {
      return false
    }

    // P0-4: Check outbound frame size BEFORE encryption & allocation
    // Noise adds 16-byte Poly1305 MAC to plaintext
    const expectedCipherLength = plaintext.byteLength + 16
    if (expectedCipherLength > this.ctx.bounds.maxFrameBytes) {
      this.terminate(1009, 'outbound frame size exceeds maxFrameBytes')
      return false
    }

    if (
      this.transport.getBufferedBytes() + expectedCipherLength > this.ctx.bounds.maxBufferedEventBytes ||
      this.pendingOutboundFrames >= this.ctx.bounds.maxOutboundQueue
    ) {
      this.terminate(1008, 'slow client: outbound buffer high-water mark exceeded')
      return false
    }

    let ciphertext: Uint8Array
    try {
      ciphertext = this.noiseSession.encrypt(plaintext)
    } catch {
      this.terminate(1008, 'encryption failure')
      return false
    }

    if (ciphertext.byteLength > this.ctx.bounds.maxFrameBytes) {
      this.terminate(1009, 'outbound ciphertext exceeds maxFrameBytes')
      return false
    }

    const done = this.trackControlSend()
    try {
      this.transport.send(ciphertext, () => {
        done()
        onFlushed?.()
      })
      return true
    } catch {
      done()
      this.terminate(1008, 'transport send failed')
      return false
    }
  }

  sendEvent(event: unknown): void {
    if (this.state !== 'ACTIVE') return
    const raw = textEncoder.encode(JSON.stringify(event))
    this.sendEncrypted(raw)
  }

  private handleBinaryPayload(payload: Uint8Array): void {
    if (payload.byteLength > this.ctx.bounds.maxFrameBytes) {
      this.terminate(1009, `frame size (${payload.byteLength}) exceeds limit (${this.ctx.bounds.maxFrameBytes})`)
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

    try {
      this.transport.send(message2)
    } catch {
      this.terminate(1008, 'failed sending handshake message 2')
      return
    }

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

    this.evaluateAuthorization()

    if ((this.state as ConnectionSecurityState) === 'CLOSED') return

    this.sendEncrypted(
      textEncoder.encode(
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
      this.terminate(1008, 'trust store error during device lookup')
      return
    }

    const hostTrustDomain = this.ctx.hostKeyPair.identity.trustDomainId

    if (!record) {
      this.state = 'PAIRING_PENDING'
      return
    }

    if (record.revokedAt !== undefined) {
      this.notifyRevoked('device is revoked', 1008)
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

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(textDecoder.decode(plaintext)) as Record<string, unknown>
    } catch {
      this.terminate(1002, 'malformed payload')
      return
    }

    const method = parsed?.method
    if (method === 'pairing.request') {
      await this.handlePairingRequest(parsed)
      return
    }

    const errorResponse = {
      jsonrpc: '2.0',
      id: parsed?.id ?? null,
      error: {
        code: -32001,
        name: 'UNAUTHORIZED_CHANNEL',
        message: `UNAUTHORIZED_CHANNEL: channel is in state PAIRING_PENDING and cannot dispatch application RPC '${String(method)}'`,
      },
    }
    this.sendEncrypted(textEncoder.encode(JSON.stringify(errorResponse)))
  }

  private async handlePairingRequest(request: Record<string, unknown>): Promise<void> {
    if (!this.ctx.pairingCoordinator || !this.noiseSession) {
      const errResp = {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: 'pairing coordinator not configured on host' },
      }
      this.sendEncrypted(textEncoder.encode(JSON.stringify(errResp)))
      return
    }

    try {
      const params = (request.params as Record<string, unknown> | undefined) ?? {}
      const initiatePayload: {
        token: string
        displayName?: string
      } = {
        token: params.token as string,
      }
      if (typeof params.displayName === 'string') {
        initiatePayload.displayName = params.displayName
      }
      const candidate = await this.ctx.pairingCoordinator.initiatePairing(
        this.noiseSession,
        initiatePayload,
      )

      const successResp = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          candidateId: candidate.candidateId,
          expiresAt: candidate.expiresAt,
          maxAllowedCapabilities: candidate.maxAllowedCapabilities,
        },
      }
      this.sendEncrypted(textEncoder.encode(JSON.stringify(successResp)))
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'PAIRING_FAILED'
      const errResp = {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32000,
          name: code,
          message: `${code}: ${(err as Error).message}`,
        },
      }
      this.sendEncrypted(textEncoder.encode(JSON.stringify(errResp)))
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
      this.terminate(1008, 'ciphertext verification failed')
      return
    }

    let requestObj: unknown
    try {
      requestObj = JSON.parse(textDecoder.decode(plaintext))
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
      this.sendEncrypted(textEncoder.encode(JSON.stringify(successResp)))
    } catch (err) {
      const requestId = (requestObj as Record<string, unknown>)?.id
      const errCode = (err as { code?: string }).code ?? 'INVALID_REQUEST'
      const errResp = {
        jsonrpc: '2.0',
        id: requestId ?? null,
        error: {
          code: -32000,
          name: errCode,
          message: `${errCode}: ${(err as Error).message}`,
        },
      }
      this.sendEncrypted(textEncoder.encode(JSON.stringify(errResp)))
    }
  }
}

/**
 * Shared revocation teardown across all carrier maps: notifies each live
 * connection/channel bound to `deviceId` and clears the device entry while
 * isolating individual close failures.
 */
export function revokeDeviceChannels<
  T extends { notifyRevoked(reason?: string, code?: number): void },
>(
  deviceMap: Map<string, Set<T>>,
  deviceId: string,
  reason = 'device revoked',
  code = 1008,
): void {
  const entries = deviceMap.get(deviceId)
  if (!entries) return
  for (const entry of Array.from(entries)) {
    try {
      entry.notifyRevoked(reason, code)
    } catch {
      // Fault isolation: one connection error does not block sibling revocations
    }
  }
  deviceMap.delete(deviceId)
}
