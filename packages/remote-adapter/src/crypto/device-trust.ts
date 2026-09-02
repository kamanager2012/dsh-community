import type { Capability, RemoteMethod } from '../protocol.js'
import { RemoteCryptoError } from './errors.js'
import { computeFingerprint } from './host-identity.js'
import { RemoteProtocolError } from '../errors.js'

export const requiredCapability: Readonly<Partial<Record<RemoteMethod, Capability>>> = {
  'session.list': 'observe',
  'session.attach': 'observe',
  'prompt.submit': 'prompt',
  'approval.respond': 'approve',
  'question.respond': 'answer-question',
  'stream.ack': 'observe',
}

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
  assertAuthorized(deviceId: string, currentTrustDomainId: string, method?: RemoteMethod): Promise<DeviceRecord>
  list(): Promise<readonly DeviceRecord[]>
  size(): Promise<number>

  // Synchronous contract support to ensure single authoritative store across adapter core
  getSync(deviceId: string): DeviceRecord | undefined
  assertAuthorizedSync(deviceId: string, currentTrustDomainId: string, method?: RemoteMethod): DeviceRecord
  trustSync(params: {
    staticPublicKey: Uint8Array
    displayName: string
    grantedCapabilities: readonly Capability[]
    trustDomainId: string
    deviceId?: string
  }): DeviceRecord
  revokeSync(deviceId: string): boolean
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

  getSync(deviceId: string): DeviceRecord | undefined {
    return this.devices.get(deviceId)
  }

  async get(deviceId: string): Promise<DeviceRecord | undefined> {
    return this.getSync(deviceId)
  }

  async findByPublicKey(staticPublicKey: Uint8Array): Promise<DeviceRecord | undefined> {
    const fingerprint = computeFingerprint(staticPublicKey)
    return this.devices.get(fingerprint)
  }

  trustSync(params: {
    staticPublicKey: Uint8Array
    displayName: string
    grantedCapabilities: readonly Capability[]
    trustDomainId: string
    deviceId?: string
  }): DeviceRecord {
    const fingerprint = params.deviceId ?? computeFingerprint(params.staticPublicKey)
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

  async trust(params: {
    staticPublicKey: Uint8Array
    displayName: string
    grantedCapabilities: readonly Capability[]
    trustDomainId: string
  }): Promise<DeviceRecord> {
    return this.trustSync(params)
  }

  revokeSync(deviceId: string): boolean {
    const record = this.devices.get(deviceId)
    if (!record) return false
    record.revokedAt = this.clock()
    return true
  }

  async revoke(deviceId: string): Promise<boolean> {
    return this.revokeSync(deviceId)
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

  assertAuthorizedSync(deviceId: string, currentTrustDomainId: string, method?: RemoteMethod): DeviceRecord {
    const record = this.devices.get(deviceId)
    if (!record) {
      throw new RemoteProtocolError('DEVICE_UNKNOWN', 'device is not trusted')
    }
    if (record.revokedAt !== undefined) {
      throw new RemoteProtocolError('DEVICE_REVOKED', 'device authorization is revoked')
    }
    if (currentTrustDomainId && record.trustDomainId !== currentTrustDomainId) {
      throw new RemoteProtocolError('TRUST_DOMAIN_STALE', 'device trust domain is stale after host rotation')
    }
    if (method) {
      const required = requiredCapability[method]
      if (required && !record.grantedCapabilities.has(required)) {
        throw new RemoteProtocolError(
          'CAPABILITY_DENIED',
          `device lacks required capability: ${required}`,
        )
      }
    }
    return record
  }

  async assertAuthorized(deviceId: string, currentTrustDomainId: string, method?: RemoteMethod): Promise<DeviceRecord> {
    return this.assertAuthorizedSync(deviceId, currentTrustDomainId, method)
  }

  async list(): Promise<readonly DeviceRecord[]> {
    return Array.from(this.devices.values())
  }

  async size(): Promise<number> {
    return this.devices.size
  }
}
