import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
// @ts-ignore - noise-handshake/dh.js
import dh from 'noise-handshake/dh.js'
import {
  HostKeyPair,
  computeFingerprint,
  computeTrustDomainId,
  toHostIdentitySnapshot,
  toHostKeyPairSnapshot,
  type HostIdentity,
  type HostIdentityStore,
} from './host-identity.js'
import { RemoteCryptoError } from './errors.js'

interface DhModule {
  generateKeyPair(secretKey?: Uint8Array): {
    publicKey: Buffer
    secretKey: Buffer
  }
}

const dhHelper: DhModule =
  (dh as unknown as { default?: DhModule }).default ?? (dh as unknown as DhModule)

interface PersistentHostIdentityPayload {
  readonly schemaVersion: 1
  readonly generation: number
  readonly createdAt: number
  readonly publicKeyHex: string
  readonly secretKeyHex: string
  readonly fingerprint: string
  readonly trustDomainId: string
}

interface PersistentHostIdentitySchema extends PersistentHostIdentityPayload {
  readonly checksum: string
}

export interface FileHostIdentityStoreOptions {
  readonly clock?: () => number
}

function fsyncDirectory(dirPath: string): void {
  if (process.platform === 'win32') return
  let fd: number | undefined
  try {
    fd = openSync(dirPath, 'r')
    fsyncSync(fd)
  } catch (error) {
    const code = (error as { code?: string })?.code
    if (code === 'EISDIR' || code === 'ENOSYS' || code === 'EPERM') return
    throw error
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

function checksumPayload(payload: PersistentHostIdentityPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function asHex32(name: string, value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', name + ' must be 32-byte lowercase hex')
  }
  return new Uint8Array(Buffer.from(value, 'hex'))
}

function asPositiveSafeInteger(name: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', name + ' must be a positive safe integer')
  }
  return value as number
}

function serializeKeyPair(keyPair: HostKeyPair): PersistentHostIdentitySchema {
  const payload: PersistentHostIdentityPayload = {
    schemaVersion: 1,
    generation: keyPair.identity.generation,
    createdAt: keyPair.identity.createdAt,
    publicKeyHex: Buffer.from(keyPair.identity.publicKey).toString('hex'),
    secretKeyHex: Buffer.from(keyPair.secretKey).toString('hex'),
    fingerprint: keyPair.identity.fingerprint,
    trustDomainId: keyPair.identity.trustDomainId,
  }
  return Object.freeze({ ...payload, checksum: checksumPayload(payload) })
}

function parseStoredIdentity(value: unknown): HostKeyPair {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'host identity file must contain an object')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'unsupported host identity schema version')
  }

  const generation = asPositiveSafeInteger('generation', record.generation)
  const createdAt = asPositiveSafeInteger('createdAt', record.createdAt)
  const publicKey = asHex32('publicKeyHex', record.publicKeyHex)
  const secretKey = asHex32('secretKeyHex', record.secretKeyHex)
  const fingerprint = record.fingerprint
  const trustDomainId = record.trustDomainId
  const checksum = record.checksum

  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(fingerprint)) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid host identity fingerprint')
  }
  if (typeof trustDomainId !== 'string' || !/^[0-9a-f]{64}$/u.test(trustDomainId)) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid host identity trust domain')
  }
  if (typeof checksum !== 'string' || !/^[0-9a-f]{64}$/u.test(checksum)) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid host identity checksum')
  }

  const payload: PersistentHostIdentityPayload = {
    schemaVersion: 1,
    generation,
    createdAt,
    publicKeyHex: record.publicKeyHex as string,
    secretKeyHex: record.secretKeyHex as string,
    fingerprint,
    trustDomainId,
  }
  if (checksumPayload(payload) !== checksum) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'host identity checksum mismatch')
  }

  const derived = dhHelper.generateKeyPair(secretKey)
  const derivedPublic = new Uint8Array(derived.publicKey)
  if (
    derivedPublic.byteLength !== publicKey.byteLength ||
    !timingSafeEqual(Buffer.from(derivedPublic), Buffer.from(publicKey))
  ) {
    throw new RemoteCryptoError(
      'HANDSHAKE_FAILED',
      'host identity public key does not match stored private key',
    )
  }

  if (computeFingerprint(publicKey) !== fingerprint) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'host identity fingerprint mismatch')
  }
  if (computeTrustDomainId(publicKey, generation) !== trustDomainId) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'host identity trust-domain mismatch')
  }

  return new HostKeyPair(
    {
      publicKey,
      fingerprint,
      trustDomainId,
      generation,
      createdAt,
    },
    secretKey,
  )
}

function writeFileDurably(filePath: string, text: string): void {
  const fd = openSync(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  )
  try {
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  if (process.platform !== 'win32') chmodSync(filePath, 0o600)
}

export class FileHostIdentityStore implements HostIdentityStore {
  readonly filePath: string
  private readonly clock: () => number
  private cached: HostKeyPair | undefined = undefined
  private poisonedReason: string | undefined = undefined
  private lock: Promise<void> = Promise.resolve()

  constructor(filePath: string, options?: FileHostIdentityStoreOptions) {
    if (!isAbsolute(filePath)) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'host identity filePath must be absolute',
      )
    }
    this.filePath = filePath
    this.clock = options?.clock ?? Date.now
  }

  async loadOrCreate(): Promise<HostKeyPair> {
    return this.exclusive(async () => {
      this.assertHealthy()
      if (this.cached) return toHostKeyPairSnapshot(this.cached)
      this.recoverIfNeeded()
      const existing = this.readExisting()
      if (existing) {
        this.cached = existing
        return toHostKeyPairSnapshot(existing)
      }
      const created = this.generateKeyPair(1)
      this.commitKeyPair(created)
      this.cached = created
      return toHostKeyPairSnapshot(created)
    })
  }

  async getPublicIdentity(): Promise<HostIdentity> {
    const pair = await this.loadOrCreate()
    return toHostIdentitySnapshot(pair.identity)
  }

  async rotate(): Promise<HostKeyPair> {
    return this.exclusive(async () => {
      this.assertHealthy()
      this.recoverIfNeeded()
      const current = this.cached ?? this.readExisting()
      const generation = (current?.identity.generation ?? 0) + 1
      const rotated = this.generateKeyPair(generation)
      this.commitKeyPair(rotated)
      this.cached = rotated
      return toHostKeyPairSnapshot(rotated)
    })
  }

  async destroy(): Promise<void> {
    await this.exclusive(async () => {
      this.assertHealthy()
      const dir = dirname(this.filePath)
      const base = basename(this.filePath)
      for (const path of [
        this.filePath,
        join(dir, '.' + base + '.journal'),
        join(dir, '.' + base + '.committed'),
      ]) {
        if (existsSync(path)) unlinkSync(path)
      }
      if (existsSync(dir)) fsyncDirectory(dir)
      this.cached = undefined
    })
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock
    let release!: () => void
    this.lock = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private assertHealthy(): void {
    if (this.poisonedReason) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'host identity store is poisoned: ' + this.poisonedReason,
      )
    }
  }

  private generateKeyPair(generation: number): HostKeyPair {
    const raw = dhHelper.generateKeyPair()
    const publicKey = new Uint8Array(raw.publicKey)
    const secretKey = new Uint8Array(raw.secretKey)
    const fingerprint = computeFingerprint(publicKey)
    return new HostKeyPair(
      {
        publicKey,
        fingerprint,
        trustDomainId: computeTrustDomainId(publicKey, generation),
        generation,
        createdAt: this.clock(),
      },
      secretKey,
    )
  }

  private readExisting(): HostKeyPair | undefined {
    if (!existsSync(this.filePath)) return undefined

    const stat = lstatSync(this.filePath)
    if (stat.isSymbolicLink()) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'host identity file cannot be a symlink')
    }

    let flags = constants.O_RDONLY
    if (typeof constants.O_NOFOLLOW === 'number') flags |= constants.O_NOFOLLOW
    const fd = openSync(this.filePath, flags)
    try {
      const fileStat = fstatSync(fd)
      if (!fileStat.isFile()) {
        throw new RemoteCryptoError('HANDSHAKE_FAILED', 'host identity target must be a regular file')
      }
      if (process.platform !== 'win32') {
        if (typeof process.getuid === 'function' && fileStat.uid !== process.getuid()) {
          throw new RemoteCryptoError('HANDSHAKE_FAILED', 'host identity file owner mismatch')
        }
        if ((fileStat.mode & 0o777) !== 0o600) {
          throw new RemoteCryptoError('HANDSHAKE_FAILED', 'host identity file must use mode 0600')
        }
      }
      const raw = readFileSync(fd, 'utf8')
      return parseStoredIdentity(JSON.parse(raw))
    } catch (error) {
      if (error instanceof RemoteCryptoError) throw error
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'failed to read host identity: ' + String((error as Error).message),
      )
    } finally {
      closeSync(fd)
    }
  }

  private commitKeyPair(keyPair: HostKeyPair): void {
    const dir = dirname(this.filePath)
    const base = basename(this.filePath)
    mkdirSync(dir, { recursive: true, mode: 0o700 })

    const journalPath = join(dir, '.' + base + '.journal')
    const backupPath = join(dir, '.' + base + '.committed')
    const targetTmp = join(dir, '.' + base + '.tmp.' + randomBytes(8).toString('hex'))
    const committedJournalTmp = join(
      dir,
      '.' + base + '.journal.committed.' + randomBytes(8).toString('hex'),
    )
    let committed = false
    let hasPriorCommit = false

    try {
      if (existsSync(journalPath)) this.recoverIfNeeded()
      hasPriorCommit = existsSync(this.filePath)

      if (hasPriorCommit) {
        copyFileSync(this.filePath, backupPath)
        if (process.platform !== 'win32') chmodSync(backupPath, 0o600)
        const backupFd = openSync(backupPath, 'r')
        try {
          fsyncSync(backupFd)
        } finally {
          closeSync(backupFd)
        }
        fsyncDirectory(dir)
      }

      writeFileDurably(
        journalPath,
        JSON.stringify({ state: 'COMMITTING', hasPriorCommit }),
      )
      fsyncDirectory(dir)

      writeFileDurably(targetTmp, JSON.stringify(serializeKeyPair(keyPair)))
      renameSync(targetTmp, this.filePath)
      if (process.platform !== 'win32') chmodSync(this.filePath, 0o600)
      fsyncDirectory(dir)

      writeFileDurably(
        committedJournalTmp,
        JSON.stringify({ state: 'COMMITTED', hasPriorCommit }),
      )
      renameSync(committedJournalTmp, journalPath)
      fsyncDirectory(dir)
      committed = true
    } catch (error) {
      if (!committed) {
        for (const path of [targetTmp, committedJournalTmp]) {
          try {
            if (existsSync(path)) unlinkSync(path)
          } catch {}
        }
        try {
          this.rollbackKnownTransaction(hasPriorCommit)
        } catch (rollbackError) {
          this.poisonedReason =
            'rollback durability failure: ' + String((rollbackError as Error).message)
          throw new RemoteCryptoError(
            'HANDSHAKE_FAILED',
            'host identity transaction failed and rollback was not durable',
          )
        }
        throw new RemoteCryptoError(
          'HANDSHAKE_FAILED',
          'host identity transaction failed: ' + String((error as Error).message),
        )
      }
    }

    try {
      if (existsSync(backupPath)) unlinkSync(backupPath)
      if (existsSync(journalPath)) unlinkSync(journalPath)
      fsyncDirectory(dir)
    } catch {
      // COMMITTED marker is durable. Cleanup debt is idempotently resolved on restart.
    }
  }

  private rollbackKnownTransaction(hasPriorCommit: boolean): void {
    const dir = dirname(this.filePath)
    const base = basename(this.filePath)
    const journalPath = join(dir, '.' + base + '.journal')
    const backupPath = join(dir, '.' + base + '.committed')

    if (hasPriorCommit && existsSync(backupPath)) {
      renameSync(backupPath, this.filePath)
      if (process.platform !== 'win32') {
        const fd = openSync(this.filePath, 'r')
        try {
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
      }
      fsyncDirectory(dir)
    } else if (!hasPriorCommit && existsSync(this.filePath)) {
      unlinkSync(this.filePath)
      fsyncDirectory(dir)
    }

    if (existsSync(backupPath)) unlinkSync(backupPath)
    if (existsSync(journalPath)) unlinkSync(journalPath)
    fsyncDirectory(dir)
  }

  private recoverIfNeeded(): void {
    const dir = dirname(this.filePath)
    const base = basename(this.filePath)
    const journalPath = join(dir, '.' + base + '.journal')
    const backupPath = join(dir, '.' + base + '.committed')
    if (!existsSync(journalPath)) return

    let record: { state?: string; hasPriorCommit?: boolean }
    try {
      record = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        state?: string
        hasPriorCommit?: boolean
      }
    } catch (error) {
      if (existsSync(backupPath)) {
        record = { state: 'COMMITTING', hasPriorCommit: true }
      } else {
        this.poisonedReason = 'unparseable recovery journal without a durable backup'
        throw new RemoteCryptoError(
          'HANDSHAKE_FAILED',
          'host identity recovery journal is corrupt and cannot be resolved safely',
        )
      }
    }

    if (record.state === 'COMMITTED') {
      try {
        if (existsSync(backupPath)) unlinkSync(backupPath)
        unlinkSync(journalPath)
        fsyncDirectory(dir)
      } catch {
        // Keep committed target. Cleanup can retry on next startup.
      }
      return
    }

    if (record.state !== 'COMMITTING' || typeof record.hasPriorCommit !== 'boolean') {
      this.poisonedReason = 'invalid host identity recovery journal state'
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'host identity recovery journal has invalid state',
      )
    }

    try {
      this.rollbackKnownTransaction(record.hasPriorCommit)
    } catch (error) {
      this.poisonedReason =
        'startup rollback durability failure: ' + String((error as Error).message)
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'failed to recover host identity last-known-good state',
      )
    }
  }
}
