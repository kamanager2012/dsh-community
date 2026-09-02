import {
  InMemoryDeviceTrustStore,
  requiredCapability,
  type DeviceRecord,
  type DeviceTrustStore,
} from './crypto/device-trust.js'
import type { Capability, RemoteMethod } from './protocol.js'

export { requiredCapability }

/**
 * Single authoritative authorization adapter over DeviceTrustStore.
 * Holds zero independent device state to prevent any split-brain truth.
 */
export class DeviceRegistry {
  readonly trustStore: DeviceTrustStore
  currentTrustDomainId: string

  constructor(
    trustStoreOrMaxDevices?: DeviceTrustStore | number,
    currentTrustDomainId = 'default-trust-domain',
  ) {
    if (typeof trustStoreOrMaxDevices === 'number' || trustStoreOrMaxDevices === undefined) {
      this.trustStore = new InMemoryDeviceTrustStore(trustStoreOrMaxDevices ?? 128)
    } else {
      this.trustStore = trustStoreOrMaxDevices
    }
    this.currentTrustDomainId = currentTrustDomainId
  }

  trust(
    deviceId: string,
    capabilities: readonly Capability[],
    options?: { staticPublicKey?: Uint8Array; displayName?: string; trustDomainId?: string },
  ): DeviceRecord {
    const domainId = options?.trustDomainId ?? this.currentTrustDomainId
    const staticPublicKey =
      options?.staticPublicKey ??
      Buffer.from(deviceId.padEnd(32, '0').slice(0, 32), 'utf8')
    const displayName = options?.displayName ?? 'Device'

    return this.trustStore.trustSync({
      staticPublicKey,
      displayName,
      grantedCapabilities: capabilities,
      trustDomainId: domainId,
      deviceId,
    })
  }

  revoke(deviceId: string): void {
    this.trustStore.revokeSync(deviceId)
  }

  assertAuthorized(deviceId: string, method: RemoteMethod): DeviceRecord {
    return this.trustStore.assertAuthorizedSync(deviceId, this.currentTrustDomainId, method)
  }
}
