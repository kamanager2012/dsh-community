import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Capability, RemoteMethod } from '../protocol.js'
import {
  InMemoryDeviceTrustStore,
  toDeviceRecordSnapshot,
  type DeviceRecord,
  type StoredDeviceRecord,
} from './device-trust.js'
import { RemoteCryptoError } from './errors.js'
import { computeFingerprint } from './host-identity.js'

export interface SerializedDeviceRecord {
  readonly deviceId: string
  readonly staticPublicKeyHex: string
  readonly fingerprint: string
  readonly trustDomainId: string
  readonly displayName: string
  readonly grantedCapabilities: readonly Capability[]
  readonly pairedAt: number
  readonly lastSeenAt: number
  readonly revokedAt?: number | null | undefined
  readonly keyVersion: number
}

export interface PersistentDeviceTrustSchema {
  readonly schemaVersion: 1
  readonly devices: readonly SerializedDeviceRecord[]
}

export interface FileDeviceTrustStoreOptions {
  readonly maxDevices?: number
  readonly clock?: () => number
}

export class FileDeviceTrustStore extends InMemoryDeviceTrustStore {
  readonly filePath: string

  constructor(filePath: string, options?: FileDeviceTrustStoreOptions) {
    super(options?.maxDevices ?? 128, options)
    this.filePath = filePath
    this.loadFromDisk()
  }

  private loadFromDisk(): void {
    if (!existsSync(this.filePath)) {
      return
    }

    let parsed: unknown
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        `failed to parse persistent device trust store: ${(err as Error).message}`,
      )
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      !Array.isArray((parsed as { devices?: unknown }).devices)
    ) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'corrupted persistent device trust store: invalid schema format or version',
      )
    }

    const schema = parsed as PersistentDeviceTrustSchema
    if (schema.devices.length > this.maxDevices) {
      throw new RemoteCryptoError(
        'STATE_CAPACITY_EXCEEDED',
        `stored devices (${schema.devices.length}) exceed configured capacity (${this.maxDevices})`,
      )
    }

    for (const dev of schema.devices) {
      if (
        typeof dev.deviceId !== 'string' ||
        typeof dev.staticPublicKeyHex !== 'string' ||
        typeof dev.trustDomainId !== 'string' ||
        typeof dev.displayName !== 'string' ||
        !Array.isArray(dev.grantedCapabilities)
      ) {
        throw new RemoteCryptoError(
          'HANDSHAKE_FAILED',
          'corrupted persistent device record in store',
        )
      }

      const keyBuf = Buffer.from(dev.staticPublicKeyHex, 'hex')
      if (keyBuf.byteLength !== 32) {
        throw new RemoteCryptoError(
          'HANDSHAKE_FAILED',
          `invalid public key length (${keyBuf.byteLength}) in persistent store`,
        )
      }
      const staticPublicKey = new Uint8Array(keyBuf)
      const expectedFingerprint = computeFingerprint(staticPublicKey)
      if (dev.deviceId !== expectedFingerprint) {
        throw new RemoteCryptoError(
          'HANDSHAKE_FAILED',
          `mismatched deviceId (${dev.deviceId}) vs computed fingerprint (${expectedFingerprint}) in persistent store`,
        )
      }

      const stored: StoredDeviceRecord = {
        deviceId: dev.deviceId,
        staticPublicKey,
        fingerprint: dev.deviceId,
        trustDomainId: dev.trustDomainId,
        displayName: dev.displayName,
        grantedCapabilities: new Set(dev.grantedCapabilities),
        pairedAt: dev.pairedAt,
        lastSeenAt: dev.lastSeenAt,
        revokedAt: dev.revokedAt === null ? undefined : dev.revokedAt,
        keyVersion: dev.keyVersion ?? 1,
      }
      this.devices.set(dev.deviceId, stored)
    }
  }

  private persistToDisk(): void {
    const records: SerializedDeviceRecord[] = []
    for (const stored of this.devices.values()) {
      records.push({
        deviceId: stored.deviceId,
        staticPublicKeyHex: Buffer.from(stored.staticPublicKey).toString('hex'),
        fingerprint: stored.fingerprint,
        trustDomainId: stored.trustDomainId,
        displayName: stored.displayName,
        grantedCapabilities: Array.from(stored.grantedCapabilities),
        pairedAt: stored.pairedAt,
        lastSeenAt: stored.lastSeenAt,
        revokedAt: stored.revokedAt ?? null,
        keyVersion: stored.keyVersion,
      })
    }

    const payload: PersistentDeviceTrustSchema = {
      schemaVersion: 1,
      devices: records,
    }

    const raw = JSON.stringify(payload, null, 2)
    const dir = dirname(this.filePath)
    const tmpPath = join(dir, `.tmp.${randomBytes(8).toString('hex')}`)

    let fd: number | undefined
    try {
      fd = openSync(tmpPath, 'w', 0o600)
      writeFileSync(fd, raw, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined

      renameSync(tmpPath, this.filePath)

      // Sync parent directory to persist directory entry if supported
      try {
        const dirFd = openSync(dir, 'r')
        fsyncSync(dirFd)
        closeSync(dirFd)
      } catch {
        // Platform fallback (e.g. Windows directory opening)
      }
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // Ignore
        }
      }
      if (existsSync(tmpPath)) {
        try {
          unlinkSync(tmpPath)
        } catch {
          // Ignore
        }
      }
      throw err
    }
  }

  override trustSync(params: {
    staticPublicKey: Uint8Array
    displayName: string
    grantedCapabilities: readonly Capability[]
    trustDomainId: string
  }): DeviceRecord {
    const record = super.trustSync(params)
    this.persistToDisk()
    return record
  }

  override revokeSync(deviceId: string): boolean {
    const revoked = super.revokeSync(deviceId)
    if (revoked) {
      this.persistToDisk()
    }
    return revoked
  }

  override async adminReEnroll(params: {
    deviceId: string
    displayName?: string
    grantedCapabilities: readonly Capability[]
    trustDomainId: string
  }): Promise<DeviceRecord> {
    const record = await super.adminReEnroll(params)
    this.persistToDisk()
    return record
  }

  override async remove(deviceId: string): Promise<boolean> {
    const removed = await super.remove(deviceId)
    if (removed) {
      this.persistToDisk()
    }
    return removed
  }
}
