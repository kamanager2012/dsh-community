import type { Capability } from '../protocol.js'
import { RemoteCryptoError } from './errors.js'
import { computeFingerprint } from './host-identity.js'

export interface DeviceRecord {
  readonly deviceId: string
  readonly staticPublicKey: Uint8Array
  readonly fingerprint: string
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
  }): Promise<DeviceRecord>
  revoke(deviceId: string): Promise<boolean>
  recordSeen(deviceId: string, timestamp?: number): Promise<void>
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
  }): Promise<DeviceRecord> {
    const fingerprint = computeFingerprint(params.staticPublicKey)
    const existing = this.devices.get(fingerprint)
    const now = this.clock()

    if (existing) {
      existing.displayName = params.displayName
      existing.grantedCapabilities = new Set(params.grantedCapabilities)
      existing.lastSeenAt = now
      existing.keyVersion += 1
      existing.revokedAt = undefined
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

  async recordSeen(deviceId: string, timestamp?: number): Promise<void> {
    const record = this.devices.get(deviceId)
    if (record) {
      record.lastSeenAt = timestamp ?? this.clock()
    }
  }

  async list(): Promise<readonly DeviceRecord[]> {
    return Array.from(this.devices.values())
  }

  async size(): Promise<number> {
    return this.devices.size
  }
}
