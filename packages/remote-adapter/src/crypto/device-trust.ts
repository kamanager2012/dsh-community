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

export interface StoredDeviceRecord {
  readonly deviceId: string
  readonly staticPublicKey: Uint8Array
  readonly fingerprint: string
  readonly trustDomainId: string
  displayName: string
  grantedCapabilities: Set<Capability>
  readonly pairedAt: number
  lastSeenAt: number
  revokedAt?: number | undefined
  keyVersion: number
}

export interface DeviceRecord {
  readonly deviceId: string
  readonly staticPublicKey: Uint8Array
  readonly fingerprint: string
  readonly trustDomainId: string
  readonly displayName: string
  readonly grantedCapabilities: ReadonlySet<Capability>
  readonly pairedAt: number
  readonly lastSeenAt: number
  readonly revokedAt?: number | undefined
  readonly keyVersion: number
}

export function toDeviceRecordSnapshot(stored: StoredDeviceRecord): DeviceRecord {
  return Object.freeze({
    deviceId: stored.deviceId,
    staticPublicKey: new Uint8Array(stored.staticPublicKey),
    fingerprint: stored.fingerprint,
    trustDomainId: stored.trustDomainId,
    displayName: stored.displayName,
    grantedCapabilities: new Set(stored.grantedCapabilities),
    pairedAt: stored.pairedAt,
    lastSeenAt: stored.lastSeenAt,
    revokedAt: stored.revokedAt,
    keyVersion: stored.keyVersion,
  })
}

export interface DeviceRevocationEvent {
  readonly deviceId: string
  readonly revokedAt: number
  readonly keyVersion: number
}

export type DeviceRevocationListener = (event: DeviceRevocationEvent) => void

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
  subscribeRevocations(listener: DeviceRevocationListener): () => void

  // Synchronous contract support to ensure single authoritative store across adapter core
  getSync(deviceId: string): DeviceRecord | undefined
  assertAuthorizedSync(deviceId: string, currentTrustDomainId: string, method?: RemoteMethod): DeviceRecord
  trustSync(params: {
    staticPublicKey: Uint8Array
    displayName: string
    grantedCapabilities: readonly Capability[]
    trustDomainId: string
  }): DeviceRecord
  revokeSync(deviceId: string): boolean
  recordSeenSync(deviceId: string, timestamp?: number): void
}

export class InMemoryDeviceTrustStore implements DeviceTrustStore {
  protected readonly devices = new Map<string, StoredDeviceRecord>()
  private readonly listeners = new Set<DeviceRevocationListener>()
  protected readonly clock: () => number

  constructor(
    readonly maxDevices = 128,
    options?: { clock?: () => number },
  ) {
    if (!Number.isInteger(maxDevices) || maxDevices < 1) {
      throw new Error('maxDevices must be a positive integer')
    }
    this.clock = options?.clock ?? Date.now
  }

  subscribeRevocations(listener: DeviceRevocationListener): () => void {
    if (this.listeners.size >= 32) {
      throw new RemoteCryptoError(
        'STATE_CAPACITY_EXCEEDED',
        'maximum revocation listeners exceeded',
      )
    }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  protected notifyRevocation(event: DeviceRevocationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Isolation: listener errors must never roll back security revocation
      }
    }
  }

  getSync(deviceId: string): DeviceRecord | undefined {
    const record = this.devices.get(deviceId)
    return record ? toDeviceRecordSnapshot(record) : undefined
  }

  async get(deviceId: string): Promise<DeviceRecord | undefined> {
    return this.getSync(deviceId)
  }

  async findByPublicKey(staticPublicKey: Uint8Array): Promise<DeviceRecord | undefined> {
    if (staticPublicKey.byteLength !== 32) {
      return undefined
    }
    const fingerprint = computeFingerprint(staticPublicKey)
    return this.getSync(fingerprint)
  }

  trustSync(params: {
    staticPublicKey: Uint8Array
    displayName: string
    grantedCapabilities: readonly Capability[]
    trustDomainId: string
  }): DeviceRecord {
    if (params.staticPublicKey.byteLength !== 32) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'static public key must be 32 bytes')
    }

    // P0-3: Device identity derived strictly from static public key, no arbitrary override
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
      return toDeviceRecordSnapshot(existing)
    }

    if (this.devices.size >= this.maxDevices) {
      throw new RemoteCryptoError(
        'STATE_CAPACITY_EXCEEDED',
        'trusted-device capacity is exhausted',
      )
    }

    const stored: StoredDeviceRecord = {
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

    this.devices.set(fingerprint, stored)
    return toDeviceRecordSnapshot(stored)
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
    if (record.revokedAt !== undefined) {
      // Already revoked: duplicate revoke is a no-op and does not re-emit signal
      return false
    }
    const now = this.clock()
    record.revokedAt = now
    this.notifyRevocation({
      deviceId,
      revokedAt: now,
      keyVersion: record.keyVersion,
    })
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
    record.displayName = params.displayName ?? record.displayName
    record.grantedCapabilities = new Set(params.grantedCapabilities)
    record.revokedAt = undefined
    record.lastSeenAt = now
    record.keyVersion += 1
    return toDeviceRecordSnapshot(record)
  }

  async remove(deviceId: string): Promise<boolean> {
    return this.devices.delete(deviceId)
  }

  recordSeenSync(deviceId: string, timestamp?: number): void {
    const record = this.devices.get(deviceId)
    if (record) {
      record.lastSeenAt = timestamp ?? this.clock()
    }
  }

  async recordSeen(deviceId: string, timestamp?: number): Promise<void> {
    this.recordSeenSync(deviceId, timestamp)
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
    return toDeviceRecordSnapshot(record)
  }

  async assertAuthorized(deviceId: string, currentTrustDomainId: string, method?: RemoteMethod): Promise<DeviceRecord> {
    return this.assertAuthorizedSync(deviceId, currentTrustDomainId, method)
  }

  async list(): Promise<readonly DeviceRecord[]> {
    return Array.from(this.devices.values()).map(toDeviceRecordSnapshot)
  }

  async size(): Promise<number> {
    return this.devices.size
  }
}
