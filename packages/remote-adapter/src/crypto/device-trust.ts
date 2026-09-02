import type { Capability } from '../protocol.js'
import { RemoteCryptoError } from './errors.js'
import { computeFingerprint } from './host-identity.js'

export interface DeviceRecord {
  readonly deviceId: string
  readonly staticPublicKey: Uint8Array
  readonly fingerprint: string
  readonly trustDomainId: string
  displayName: string
  grantedCapabilities: ReadonlySet<Capability>
  readonly pairedAt: number
  lastSeenAt: number
  revokedAt?: number | undefined
  keyVersion: number
}

export interface DeviceTrustStore {
  get(deviceId: string): Promise<DeviceRecord | undefined>
  findByPublicKey(staticPublicKey: Uint8Array): Promise<DeviceRecord | undefined>
  trust(params: {
    staticPublicKey: Uint8Array
    displayName: string
    grantedCapabilities: readonly Capability[]
    trustDomainId: string
  }): Promise<DeviceRecord>
  revoke(deviceId: string): Promise<boolean>
  adminReEnroll(params: {
    deviceId: string
    displayName?: string
    grantedCapabilities: readonly Capability[]
    trustDomainId: string
  }): Promise<DeviceRecord>
  remove(deviceId: string): Promise<boolean>
  recordSeen(deviceId: string, timestamp?: number): Promise<void>
  assertAuthorized(deviceId: string, currentTrustDomainId: string): Promise<DeviceRecord>
  list(): Promise<readonly DeviceRecord[]>
  size(): Promise<number>
}

export class InMemoryDeviceTrustStore implements DeviceTrustStore {
  private readonly devices = new Map<string, DeviceRecord>()
  private readonly clock: () => number

  constructor(
    readonly maxDevices = 128,
    options?: { clock?: () => number },
  ) {
    if (!Number.isInteger(maxDevices) || maxDevices < 1) {
      throw new Error('maxDevices must be a positive integer')
    }
    this.clock = options?.clock ?? Date.now
  }

  async get(deviceId: string): Promise<DeviceRecord | undefined> {
    return this.devices.get(deviceId)
  }

  async findByPublicKey(staticPublicKey: Uint8Array): Promise<DeviceRecord | undefined> {
    const fingerprint = computeFingerprint(staticPublicKey)
    return this.devices.get(fingerprint)
  }

  async trust(params: {
    staticPublicKey: Uint8Array
    displayName: string
    grantedCapabilities: readonly Capability[]
    trustDomainId: string
  }): Promise<DeviceRecord> {
    const fingerprint = computeFingerprint(params.staticPublicKey)
    const existing = this.devices.get(fingerprint)
    const now = this.clock()

    if (existing) {
      if (existing.revokedAt !== undefined) {
        throw new RemoteCryptoError(
          'DEVICE_REVOKED',
          'device is revoked; standard pairing cannot restore a revoked device',
        )
      }
      if (existing.trustDomainId !== params.trustDomainId) {
        throw new RemoteCryptoError(
          'TRUST_DOMAIN_STALE',
          'device belongs to a stale trust domain and must be newly paired',
        )
      }
      existing.displayName = params.displayName
      existing.grantedCapabilities = new Set(params.grantedCapabilities)
      existing.lastSeenAt = now
      existing.keyVersion += 1
      return existing
    }

    if (this.devices.size >= this.maxDevices) {
      throw new RemoteCryptoError(
        'STATE_CAPACITY_EXCEEDED',
        'trusted-device capacity is exhausted',
      )
    }

    const record: DeviceRecord = {
      deviceId: fingerprint,
      staticPublicKey: new Uint8Array(params.staticPublicKey),
      fingerprint,
      trustDomainId: params.trustDomainId,
      displayName: params.displayName,
      grantedCapabilities: new Set(params.grantedCapabilities),
      pairedAt: now,
      lastSeenAt: now,
      keyVersion: 1,
    }

    this.devices.set(fingerprint, record)
    return record
  }

  async revoke(deviceId: string): Promise<boolean> {
    const record = this.devices.get(deviceId)
    if (!record) return false
    record.revokedAt = this.clock()
    return true
  }

  async adminReEnroll(params: {
    deviceId: string
    displayName?: string
    grantedCapabilities: readonly Capability[]
    trustDomainId: string
  }): Promise<DeviceRecord> {
    const record = this.devices.get(params.deviceId)
    if (!record) {
      throw new RemoteCryptoError('DEVICE_NOT_TRUSTED', 'device does not exist for re-enrollment')
    }
    const now = this.clock()
    const updatedRecord: DeviceRecord = {
      ...record,
      trustDomainId: params.trustDomainId,
      displayName: params.displayName ?? record.displayName,
      grantedCapabilities: new Set(params.grantedCapabilities),
      revokedAt: undefined,
      lastSeenAt: now,
      keyVersion: record.keyVersion + 1,
    }
    this.devices.set(params.deviceId, updatedRecord)
    return updatedRecord
  }

  async remove(deviceId: string): Promise<boolean> {
    return this.devices.delete(deviceId)
  }

  async recordSeen(deviceId: string, timestamp?: number): Promise<void> {
    const record = this.devices.get(deviceId)
    if (record) {
      record.lastSeenAt = timestamp ?? this.clock()
    }
  }

  async assertAuthorized(deviceId: string, currentTrustDomainId: string): Promise<DeviceRecord> {
    const record = this.devices.get(deviceId)
    if (!record) {
      throw new RemoteCryptoError('DEVICE_NOT_TRUSTED', 'device is not trusted')
    }
    if (record.revokedAt !== undefined) {
      throw new RemoteCryptoError('DEVICE_REVOKED', 'device authorization is revoked')
    }
    if (record.trustDomainId !== currentTrustDomainId) {
      throw new RemoteCryptoError('TRUST_DOMAIN_STALE', 'device trust domain is stale after host rotation')
    }
    return record
  }

  async list(): Promise<readonly DeviceRecord[]> {
    return Array.from(this.devices.values())
  }

  async size(): Promise<number> {
    return this.devices.size
  }
}
