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

  constructor(
    trustStoreOrMaxDevices?: DeviceTrustStore | number,
  ) {
    if (typeof trustStoreOrMaxDevices === 'number' || trustStoreOrMaxDevices === undefined) {
      this.trustStore = new InMemoryDeviceTrustStore(trustStoreOrMaxDevices ?? 128)
    } else {
      this.trustStore = trustStoreOrMaxDevices
    }
  }

  /**
   * P0-3: Device trust enrollment strictly requires authentic 32-byte static public key.
   * Device identity is computed exclusively via computeFingerprint(staticPublicKey).
   */
  trust(
    staticPublicKey: Uint8Array,
    capabilities: readonly Capability[],
    options: { displayName?: string; trustDomainId: string },
  ): DeviceRecord {
    return this.trustStore.trustSync({
      staticPublicKey,
      displayName: options.displayName ?? 'Device',
      grantedCapabilities: capabilities,
      trustDomainId: options.trustDomainId,
    })
  }

  revoke(deviceId: string): void {
    this.trustStore.revokeSync(deviceId)
  }

  assertAuthorized(deviceId: string, method: RemoteMethod, currentTrustDomainId: string): DeviceRecord {
    return this.trustStore.assertAuthorizedSync(deviceId, currentTrustDomainId, method)
  }
}
