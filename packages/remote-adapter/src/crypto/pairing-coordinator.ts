import type { Capability } from '../protocol.js'
import type { DeviceRecord, DeviceTrustStore } from './device-trust.js'
import { RemoteCryptoError } from './errors.js'
import type { HostIdentityStore } from './host-identity.js'
import type { NoiseResponderSession } from './noise.js'
import type { PairingCandidateView, PairingTokenRegistry } from './pairing-token.js'

export interface PairingConfirmationParams {
  readonly candidateId: string
  readonly grantedCapabilities: readonly Capability[]
}

export interface PairingResult {
  readonly channelState: 'DEVICE_AUTHORIZED'
  readonly device: DeviceRecord
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
    payload: {
      token: string
      displayName?: string
      requestedCapabilities?: readonly Capability[]
      claimedDeviceId?: string
    },
  ): Promise<PairingCandidateView> {
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
    // P0-2: Synchronously claim candidate BEFORE ANY AWAIT (Single-winner race guarantee)
    const tx = this.tokenRegistry.claimCandidateForConfirmation(params.candidateId)

    try {
      // P0-5: Host rotation check at confirmation time
      const currentHost = await this.hostIdentityStore.getPublicIdentity()
      if (
        tx.trustDomainId !== currentHost.trustDomainId ||
        tx.hostGeneration !== currentHost.generation
      ) {
        tx.rollback()
        throw new RemoteCryptoError(
          'TRUST_DOMAIN_STALE',
          'host identity rotated during pairing; pairing candidate invalidated',
        )
      }

      // Capability escalation protection: cannot exceed allowed capabilities of the token
      const maxSet = new Set(tx.maxAllowedCapabilities)
      for (const cap of params.grantedCapabilities) {
        if (!maxSet.has(cap)) {
          tx.rollback()
          throw new RemoteCryptoError(
            'CAPABILITY_DENIED',
            `requested capability '${cap}' exceeds token allowlist`,
          )
        }
      }

      // P0-7: Atomic commit into single authoritative DeviceTrustStore
      const deviceRecord = await this.trustStore.trust({
        staticPublicKey: tx.remoteStaticPublicKey,
        displayName: tx.displayName,
        grantedCapabilities: params.grantedCapabilities,
        trustDomainId: tx.trustDomainId,
      })

      // Finalize transaction: mark CONSUMED and clean token
      tx.commit()

      return {
        channelState: 'DEVICE_AUTHORIZED',
        device: deviceRecord,
      }
    } catch (error) {
      tx.rollback()
      throw error
    }
  }

  async rejectPairing(candidateId: string): Promise<boolean> {
    return this.tokenRegistry.rejectCandidate(candidateId)
  }
}
