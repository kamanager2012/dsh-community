import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
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

export const VALID_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'observe',
  'prompt',
  'approve',
  'answer-question',
])

export interface SerializedDeviceRecord {
  readonly deviceId: string
  readonly staticPublicKeyHex: string
  readonly fingerprint: string
  readonly trustDomainId: string
  readonly displayName: string
  readonly grantedCapabilities: readonly string[]
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
  readonly recoveryMode?: 'auto-rollback' | 'fail-closed'
  readonly faultInjector?: (
    stage: 'before-write' | 'before-rename' | 'after-rename-before-dir-fsync'
  ) => void
}

export class FileDeviceTrustStore extends InMemoryDeviceTrustStore {
  readonly filePath: string
  private readonly storeOptions: FileDeviceTrustStoreOptions | undefined
  private isPoisoned = false
  private poisonReason: string | undefined = undefined

  constructor(filePath: string, options?: FileDeviceTrustStoreOptions) {
    if (!isAbsolute(filePath)) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        `filePath must be an absolute path, got: ${filePath}`,
      )
    }
    super(options?.maxDevices ?? 128, options)
    this.filePath = filePath
    this.storeOptions = options
    this.loadFromDisk()
  }

  private assertNotPoisoned(): void {
    if (this.isPoisoned) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        `device trust store is in a fail-closed poisoned state: ${this.poisonReason}`,
      )
    }
  }

  public static rollbackJournal(
    dir: string,
    targetPath: string,
    journalPath: string,
    backupPath: string,
  ): boolean {
    if (!existsSync(journalPath)) {
      return false
    }

    let journalData: { hasPriorCommit?: boolean } = {}
    try {
      const raw = readFileSync(journalPath, 'utf8')
      journalData = JSON.parse(raw)
    } catch {
      // Fallback
    }

    if (existsSync(backupPath)) {
      renameSync(backupPath, targetPath)
      if (process.platform !== 'win32') {
        try {
          const fd = openSync(targetPath, 'r')
          fsyncSync(fd)
          closeSync(fd)
        } catch {}
      }
    } else if (journalData.hasPriorCommit === false) {
      if (existsSync(targetPath)) {
        try {
          unlinkSync(targetPath)
        } catch {}
      }
    }

    try {
      unlinkSync(journalPath)
    } catch {}

    if (process.platform !== 'win32') {
      try {
        const dirFd = openSync(dir, 'r')
        fsyncSync(dirFd)
        closeSync(dirFd)
      } catch {}
    }

    return true
  }

  private loadFromDisk(): void {
    const dir = dirname(this.filePath)
    const base = basename(this.filePath)
    const journalPath = join(dir, `.${base}.journal`)
    const backupPath = join(dir, `.${base}.committed`)

    if (existsSync(journalPath)) {
      if (this.storeOptions?.recoveryMode === 'fail-closed') {
        this.isPoisoned = true
        this.poisonReason =
          'durable uncertainty detected: uncommitted transaction journal found on restart'
        throw new RemoteCryptoError(
          'HANDSHAKE_FAILED',
          'device trust store has uncommitted transaction journal on restart; recovery required',
        )
      }

      // Default: auto-rollback to last-known-good committed state
      FileDeviceTrustStore.rollbackJournal(dir, this.filePath, journalPath, backupPath)
    }

    if (!existsSync(this.filePath)) {
      return
    }

    // Defense-in-depth symlink check
    const lstats = lstatSync(this.filePath)
    if (lstats.isSymbolicLink()) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'symlinks are not permitted for device trust store file',
      )
    }

    // P1: TOCTOU protection using O_NOFOLLOW where supported, reading from verified fd
    let openFlags = constants.O_RDONLY
    if (typeof constants.O_NOFOLLOW === 'number') {
      openFlags |= constants.O_NOFOLLOW
    }

    let fd: number | undefined
    try {
      fd = openSync(this.filePath, openFlags)
    } catch (err) {
      const code = (err as { code?: string })?.code
      if (code === 'ELOOP' || code === 'SYMLINK_LOOP') {
        throw new RemoteCryptoError(
          'HANDSHAKE_FAILED',
          'symlinks are not permitted for device trust store file',
        )
      }
      throw err
    }

    let parsed: unknown
    try {
      const stats = fstatSync(fd)
      if (!stats.isFile()) {
        throw new RemoteCryptoError(
          'HANDSHAKE_FAILED',
          'device trust store target must be a regular file',
        )
      }

      // P1: POSIX ownership and strict 0600 permissions check
      if (process.platform !== 'win32') {
        if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
          throw new RemoteCryptoError(
            'HANDSHAKE_FAILED',
            `device trust store file owner (uid ${stats.uid}) does not match current user (uid ${process.getuid()})`,
          )
        }
        if ((stats.mode & 0o777) !== 0o600) {
          throw new RemoteCryptoError(
            'HANDSHAKE_FAILED',
            `insecure file permissions (${(stats.mode & 0o777).toString(8)}); expected strict 0600`,
          )
        }
      }

      const raw = readFileSync(fd, 'utf8')
      parsed = JSON.parse(raw)
    } catch (err) {
      if (err instanceof RemoteCryptoError) {
        throw err
      }
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        `failed to parse persistent device trust store: ${(err as Error).message}`,
      )
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // Ignore
        }
      }
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

    const seenIds = new Set<string>()

    for (const dev of schema.devices) {
      if (
        typeof dev !== 'object' ||
        dev === null ||
        typeof dev.deviceId !== 'string' ||
        typeof dev.fingerprint !== 'string' ||
        typeof dev.staticPublicKeyHex !== 'string' ||
        typeof dev.trustDomainId !== 'string' ||
        typeof dev.displayName !== 'string' ||
        !Array.isArray(dev.grantedCapabilities) ||
        !Number.isInteger(dev.pairedAt) ||
        dev.pairedAt <= 0 ||
        !Number.isInteger(dev.lastSeenAt) ||
        dev.lastSeenAt < dev.pairedAt ||
        !Number.isInteger(dev.keyVersion) ||
        dev.keyVersion < 1
      ) {
        throw new RemoteCryptoError(
          'HANDSHAKE_FAILED',
          'corrupted persistent device record in store',
        )
      }

      // P1: Strict 64 hex characters validation for staticPublicKeyHex
      if (!/^[0-9a-fA-F]{64}$/.test(dev.staticPublicKeyHex)) {
        throw new RemoteCryptoError(
          'HANDSHAKE_FAILED',
          `invalid staticPublicKeyHex format (expected exactly 64 hex characters): ${dev.staticPublicKeyHex}`,
        )
      }

      if (dev.revokedAt !== undefined && dev.revokedAt !== null) {
        if (!Number.isInteger(dev.revokedAt) || (dev.revokedAt as number) <= 0) {
          throw new RemoteCryptoError(
            'HANDSHAKE_FAILED',
            'corrupted revokedAt timestamp in persistent store',
          )
        }
      }

      if (seenIds.has(dev.deviceId)) {
        throw new RemoteCryptoError(
          'HANDSHAKE_FAILED',
          `duplicate device record found in persistent store for deviceId: ${dev.deviceId}`,
        )
      }
      seenIds.add(dev.deviceId)

      if (dev.deviceId !== dev.fingerprint) {
        throw new RemoteCryptoError(
          'HANDSHAKE_FAILED',
          `mismatched deviceId (${dev.deviceId}) vs fingerprint (${dev.fingerprint}) in persistent store`,
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

      const capabilitySet = new Set<Capability>()
      for (const cap of dev.grantedCapabilities) {
        if (!VALID_CAPABILITIES.has(cap as Capability)) {
          throw new RemoteCryptoError(
            'HANDSHAKE_FAILED',
            `unknown or malformed capability '${cap}' in persistent device store`,
          )
        }
        capabilitySet.add(cap as Capability)
      }

      const stored: StoredDeviceRecord = {
        deviceId: dev.deviceId,
        staticPublicKey,
        fingerprint: dev.deviceId,
        trustDomainId: dev.trustDomainId,
        displayName: dev.displayName,
        grantedCapabilities: capabilitySet,
        pairedAt: dev.pairedAt,
        lastSeenAt: dev.lastSeenAt,
        revokedAt: dev.revokedAt === null ? undefined : dev.revokedAt,
        keyVersion: dev.keyVersion,
      }
      this.devices.set(dev.deviceId, stored)
    }
  }

  /**
   * P0-3 & P0-4: Durable commit transaction with fail-closed poisoning and automatic rollback.
   * Maintains last-known-good backup and transaction journal.
   * If directory fsync fails, in-process instance is poisoned AND disk is rolled back to last-known-good.
   * If process crashes before rollback completes, restart automatically recovers last-known-good state.
   */
  private commitDurableTransaction(stagedDevices: Map<string, StoredDeviceRecord>): void {
    this.assertNotPoisoned()

    const records: SerializedDeviceRecord[] = []
    for (const stored of stagedDevices.values()) {
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
    const base = basename(this.filePath)
    const journalPath = join(dir, `.${base}.journal`)
    const backupPath = join(dir, `.${base}.committed`)
    const tmpPath = join(dir, `.tmp.${randomBytes(8).toString('hex')}`)

    const hasPriorCommit = existsSync(this.filePath)
    if (hasPriorCommit) {
      try {
        copyFileSync(this.filePath, backupPath)
        chmodSync(backupPath, 0o600)
        const backupFd = openSync(backupPath, 'r')
        fsyncSync(backupFd)
        closeSync(backupFd)
      } catch (err) {
        throw new RemoteCryptoError(
          'HANDSHAKE_FAILED',
          `failed to create committed backup before transaction: ${(err as Error).message}`,
        )
      }
    }

    try {
      const journalPayload = JSON.stringify({
        state: 'COMMITTING',
        target: this.filePath,
        backup: backupPath,
        hasPriorCommit,
      })
      const journalFd = openSync(journalPath, 'wx', 0o600)
      writeFileSync(journalFd, journalPayload, 'utf8')
      fsyncSync(journalFd)
      closeSync(journalFd)
    } catch (err) {
      if (existsSync(backupPath)) {
        try {
          unlinkSync(backupPath)
        } catch {}
      }
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        `failed to create transaction journal: ${(err as Error).message}`,
      )
    }

    let fd: number | undefined
    try {
      this.storeOptions?.faultInjector?.('before-write')

      // Exclusive create flag 'wx' prevents clobbering existing temporary files
      fd = openSync(tmpPath, 'wx', 0o600)
      writeFileSync(fd, raw, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined

      this.storeOptions?.faultInjector?.('before-rename')

      renameSync(tmpPath, this.filePath)

      try {
        this.storeOptions?.faultInjector?.('after-rename-before-dir-fsync')

        // P0-4: POSIX parent directory fsync.
        if (process.platform !== 'win32') {
          let dirFd: number | undefined
          try {
            dirFd = openSync(dir, 'r')
            fsyncSync(dirFd)
            closeSync(dirFd)
            dirFd = undefined
          } catch (err) {
            if (dirFd !== undefined) {
              try {
                closeSync(dirFd)
              } catch {
                // Ignore
              }
            }
            const code = (err as { code?: string })?.code
            if (code === 'EISDIR' || code === 'ENOSYS' || code === 'EPERM') {
              // Documented platform/filesystem limitation
            } else {
              throw err
            }
          }
        }

        // Durable transaction committed cleanly! Clean up journal and backup
        if (existsSync(journalPath)) {
          try {
            unlinkSync(journalPath)
          } catch {}
        }
        if (existsSync(backupPath)) {
          try {
            unlinkSync(backupPath)
          } catch {}
        }
        if (process.platform !== 'win32') {
          try {
            const dirFd = openSync(dir, 'r')
            fsyncSync(dirFd)
            closeSync(dirFd)
          } catch {}
        }
      } catch (err) {
        this.isPoisoned = true
        this.poisonReason = `parent directory fsync or post-rename failure: ${(err as Error).message}`

        // Roll back target on disk immediately to restore last-known-good state!
        try {
          FileDeviceTrustStore.rollbackJournal(dir, this.filePath, journalPath, backupPath)
        } catch {
          // If disk rollback fails here, loadFromDisk on restart will perform it
        }

        throw new RemoteCryptoError(
          'HANDSHAKE_FAILED',
          `durable commit failed: parent directory fsync failed after rename: ${(err as Error).message}`,
        )
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
      if (!this.isPoisoned) {
        if (existsSync(journalPath)) {
          try {
            unlinkSync(journalPath)
          } catch {}
        }
        if (existsSync(backupPath)) {
          try {
            unlinkSync(backupPath)
          } catch {}
        }
      }
      throw err
    }

    // Only commit live memory state after durable disk persistence succeeds!
    this.devices.clear()
    for (const [id, rec] of stagedDevices.entries()) {
      this.devices.set(id, rec)
    }
  }

  private cloneDevices(): Map<string, StoredDeviceRecord> {
    const cloned = new Map<string, StoredDeviceRecord>()
    for (const [id, rec] of this.devices.entries()) {
      cloned.set(id, {
        deviceId: rec.deviceId,
        staticPublicKey: new Uint8Array(rec.staticPublicKey),
        fingerprint: rec.fingerprint,
        trustDomainId: rec.trustDomainId,
        displayName: rec.displayName,
        grantedCapabilities: new Set(rec.grantedCapabilities),
        pairedAt: rec.pairedAt,
        lastSeenAt: rec.lastSeenAt,
        revokedAt: rec.revokedAt,
        keyVersion: rec.keyVersion,
      })
    }
    return cloned
  }

  override getSync(deviceId: string): DeviceRecord | undefined {
    this.assertNotPoisoned()
    return super.getSync(deviceId)
  }

  override assertAuthorizedSync(deviceId: string, currentTrustDomainId: string, method?: RemoteMethod): DeviceRecord {
    this.assertNotPoisoned()
    return super.assertAuthorizedSync(deviceId, currentTrustDomainId, method)
  }

  override trustSync(params: {
    staticPublicKey: Uint8Array
    displayName: string
    grantedCapabilities: readonly Capability[]
    trustDomainId: string
  }): DeviceRecord {
    this.assertNotPoisoned()
    if (params.staticPublicKey.byteLength !== 32) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'static public key must be 32 bytes')
    }

    const fingerprint = computeFingerprint(params.staticPublicKey)
    const staged = this.cloneDevices()
    const existing = staged.get(fingerprint)
    const now = this.clock()

    let resultRecord: StoredDeviceRecord

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
      resultRecord = existing
    } else {
      if (staged.size >= this.maxDevices) {
        throw new RemoteCryptoError(
          'STATE_CAPACITY_EXCEEDED',
          'trusted-device capacity is exhausted',
        )
      }

      resultRecord = {
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
      staged.set(fingerprint, resultRecord)
    }

    // Persist staged state first; updates this.devices only on success
    this.commitDurableTransaction(staged)
    return toDeviceRecordSnapshot(resultRecord)
  }

  override revokeSync(deviceId: string): boolean {
    this.assertNotPoisoned()
    const existing = this.devices.get(deviceId)
    if (!existing) return false
    if (existing.revokedAt !== undefined) {
      return false
    }

    const staged = this.cloneDevices()
    const target = staged.get(deviceId)
    if (!target) return false

    const now = this.clock()
    target.revokedAt = now

    // Persist to disk first
    this.commitDurableTransaction(staged)

    // Only notify listeners AFTER durable disk commit succeeds!
    this.notifyRevocation({
      deviceId,
      revokedAt: now,
      keyVersion: target.keyVersion,
    })
    return true
  }

  override async adminReEnroll(params: {
    deviceId: string
    displayName?: string
    grantedCapabilities: readonly Capability[]
    trustDomainId: string
  }): Promise<DeviceRecord> {
    this.assertNotPoisoned()
    const existing = this.devices.get(params.deviceId)
    if (!existing) {
      throw new RemoteCryptoError('DEVICE_NOT_TRUSTED', 'device does not exist for re-enrollment')
    }

    const staged = this.cloneDevices()
    const target = staged.get(params.deviceId)
    if (!target) {
      throw new RemoteCryptoError('DEVICE_NOT_TRUSTED', 'device does not exist for re-enrollment')
    }

    const now = this.clock()
    target.displayName = params.displayName ?? target.displayName
    target.grantedCapabilities = new Set(params.grantedCapabilities)
    target.revokedAt = undefined
    target.lastSeenAt = now
    target.keyVersion += 1

    this.commitDurableTransaction(staged)
    return toDeviceRecordSnapshot(target)
  }

  override async remove(deviceId: string): Promise<boolean> {
    this.assertNotPoisoned()
    if (!this.devices.has(deviceId)) {
      return false
    }

    const staged = this.cloneDevices()
    staged.delete(deviceId)

    this.commitDurableTransaction(staged)
    return true
  }

  /**
   * P0-4: Durable lastSeenAt contract.
   * Persists updated lastSeenAt timestamp to disk and updates live memory on success.
   */
  override recordSeenSync(deviceId: string, timestamp?: number): void {
    this.assertNotPoisoned()
    const existing = this.devices.get(deviceId)
    if (!existing) return

    const staged = this.cloneDevices()
    const target = staged.get(deviceId)
    if (!target) return

    target.lastSeenAt = timestamp ?? this.clock()
    this.commitDurableTransaction(staged)
  }

  override async recordSeen(deviceId: string, timestamp?: number): Promise<void> {
    this.recordSeenSync(deviceId, timestamp)
  }

  override async list(): Promise<readonly DeviceRecord[]> {
    this.assertNotPoisoned()
    return super.list()
  }

  override async size(): Promise<number> {
    this.assertNotPoisoned()
    return super.size()
  }
}
