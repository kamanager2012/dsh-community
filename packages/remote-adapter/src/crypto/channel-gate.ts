import type { RemoteMethod } from '../protocol.js'
import type { DeviceRecord, DeviceTrustStore } from './device-trust.js'
import { RemoteCryptoError } from './errors.js'

export type ChannelAuthorizationState =
  | 'CHANNEL_AUTHENTICATED'
  | 'PAIRING_PENDING'
  | 'DEVICE_AUTHORIZED'
  | 'ACTIVE'

export class ChannelSecurityGate {
  private state: ChannelAuthorizationState = 'CHANNEL_AUTHENTICATED'
  private authorizedDevice: DeviceRecord | undefined = undefined

  constructor(
    readonly remoteDeviceId: string,
    readonly currentTrustDomainId: string,
    private readonly trustStore: DeviceTrustStore,
  ) {}

  getState(): ChannelAuthorizationState {
    return this.state
  }

  getAuthorizedDevice(): DeviceRecord | undefined {
    return this.authorizedDevice
  }

  async evaluate(): Promise<ChannelAuthorizationState> {
    const record = await this.trustStore.get(this.remoteDeviceId)
    if (!record) {
      this.state = 'PAIRING_PENDING'
      return this.state
    }

    if (record.revokedAt !== undefined) {
      throw new RemoteCryptoError('DEVICE_REVOKED', 'device is revoked')
    }

    if (record.trustDomainId !== this.currentTrustDomainId) {
      throw new RemoteCryptoError('TRUST_DOMAIN_STALE', 'device trust domain is stale after host rotation')
    }

    this.authorizedDevice = record
    this.state = 'DEVICE_AUTHORIZED'
    return this.state
  }

  activate(): void {
    if (this.state !== 'DEVICE_AUTHORIZED') {
      throw new RemoteCryptoError(
        'UNAUTHORIZED_CHANNEL',
        `cannot activate channel in state ${this.state}`,
      )
    }
    this.state = 'ACTIVE'
  }

  assertCanDispatchRpc(method: RemoteMethod): void {
    if (this.state !== 'ACTIVE') {
      throw new RemoteCryptoError(
        'UNAUTHORIZED_CHANNEL',
        `unauthorized channel in state '${this.state}' cannot execute RPC method '${method}'`,
      )
    }
  }
}
