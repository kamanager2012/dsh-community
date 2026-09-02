import type { Capability } from '../protocol.js'
import type { DeviceRecord, DeviceTrustStore } from './device-trust.js'
import { RemoteCryptoError } from './errors.js'
import type { HostIdentityStore } from './host-identity.js'
import type { NoiseResponderSession } from './noise.js'
import type { PairingCandidate, PairingTokenRegistry } from './pairing-token.js'

export interface PairingPayload {
  readonly token: string
  readonly displayName?: string
  readonly requestedCapabilities?: readonly Capability[]
  /**
   * Adversarial attempt to substitute deviceId must be ignored/rejected.
   * Authoritative deviceId is derived exclusively from Noise authenticated static key.
   */
  readonly claimedDeviceId?: string
}

export interface PairingConfirmationParams {
  readonly candidateId: string
  readonly grantedCapabilities: readonly Capability[]
}

export interface PairingResult {
  readonly device: DeviceRecord
  readonly channelState: 'DEVICE_AUTHORIZED'
}

export class PairingCoordinator {
  private readonly clock: () => number

  constructor(
    private readonly hostIdentityStore: HostIdentityStore,
    private readonly trustStore: DeviceTrustStore,
    private readonly tokenRegistry: PairingTokenRegistry,
    options?: { clock?: () => number },
  ) {
    this.clock = options?.clock ?? Date.now
  }

  async initiatePairing(
    responder: NoiseResponderSession,
    payload: PairingPayload,
  ): Promise<PairingCandidate> {
    if (responder.getState() !== 'CHANNEL_AUTHENTICATED') {
      throw new RemoteCryptoError(
        'HANDSHAKE_STATE_INVALID',
        'cannot initiate pairing before Noise channel authentication completes',
      )
    }

    // P0-6: Authoritative identity strictly derived from Noise authenticated static key
    const peer = responder.getRemotePeer()
    const host = await this.hostIdentityStore.getPublicIdentity()

    return this.tokenRegistry.verifyCandidate({
      rawToken: payload.token,
      remoteStaticPublicKey: peer.staticPublicKey,
      displayName: payload.displayName ?? 'Remote Device',
      currentTrustDomainId: host.trustDomainId,
      currentHostGeneration: host.generation,
      requestedCapabilities: payload.requestedCapabilities,
    })
  }

  async confirmPairing(params: PairingConfirmationParams): Promise<PairingResult> {
    const candidate = this.tokenRegistry.getCandidate(params.candidateId)
    if (!candidate) {
      throw new RemoteCryptoError('PAIRING_FAILED', 'pairing candidate not found or already consumed')
    }

    const now = this.clock()

    // P0-4: Expiry check at confirmation time
    if (now > candidate.expiresAt) {
      this.tokenRegistry.burnCandidateAndToken(params.candidateId)
      throw new RemoteCryptoError('PAIRING_FAILED', 'pairing candidate has expired')
    }

    // P0-5: Host rotation check at confirmation time
    const currentHost = await this.hostIdentityStore.getPublicIdentity()
    if (
      candidate.trustDomainId !== currentHost.trustDomainId ||
      candidate.hostGeneration !== currentHost.generation
    ) {
      this.tokenRegistry.burnCandidateAndToken(params.candidateId)
      throw new RemoteCryptoError(
        'TRUST_DOMAIN_STALE',
        'host identity rotated during pairing; pairing candidate invalidated',
      )
    }

    // Capability escalation protection: cannot exceed allowed capabilities of the token
    const maxSet = new Set(candidate.maxAllowedCapabilities)
    for (const cap of params.grantedCapabilities) {
      if (!maxSet.has(cap)) {
        this.tokenRegistry.burnCandidateAndToken(params.candidateId)
        throw new RemoteCryptoError(
          'PAIRING_FAILED',
          `cannot grant capability '${cap}' exceeding token permission`,
        )
      }
    }

    // P0-7: Transactional commit to DeviceTrustStore
    let device: DeviceRecord
    try {
      device = await this.trustStore.trust({
        staticPublicKey: candidate.remoteStaticPublicKey,
        displayName: candidate.displayName,
        grantedCapabilities: params.grantedCapabilities,
        trustDomainId: candidate.trustDomainId,
      })
    } catch (error) {
      // Transaction rollback on trust store failure: burn candidate and token, fail closed
      this.tokenRegistry.burnCandidateAndToken(params.candidateId)
      throw error
    }

    // Commit succeeded: atomically burn candidate and token
    this.tokenRegistry.burnCandidateAndToken(params.candidateId)

    return {
      device,
      channelState: 'DEVICE_AUTHORIZED',
    }
  }

  rejectPairing(candidateId: string): void {
    this.tokenRegistry.burnCandidateAndToken(candidateId)
  }
}
