import { createHash, randomUUID, type Hash } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  type Dirent,
} from 'node:fs'
import { extname, basename, join, sep } from 'node:path'
import { RemoteProtocolError } from './errors.js'
import type {
  WorkspaceUploadAbortResult,
  WorkspaceUploadChunkResult,
  WorkspaceUploadCommitResult,
  WorkspaceUploadOpenResult,
} from './protocol.js'

export const WORKSPACE_UPLOAD_SUBDIR = '.dsh-uploads'
export const DEFAULT_MAX_WORKSPACE_UPLOAD_BYTES = 20 * 1024 * 1024
export const HARD_MAX_WORKSPACE_UPLOAD_BYTES = 64 * 1024 * 1024
export const MAX_WORKSPACE_UPLOAD_CHUNK_BYTES = 32 * 1024
export const MAX_OPEN_UPLOADS_PER_DEVICE = 4
export const MAX_OPEN_UPLOADS_GLOBAL = 16
export const WORKSPACE_UPLOAD_IDLE_TTL_MS = 5 * 60_000

const BASE64_STRICT_RE = /^[A-Za-z0-9+/]+={0,2}$/u
const UNSAFE_FILENAME_RE = /[/\\\u0000-\u001f\u007f]/u
const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/u

interface ActiveUploadState {
  readonly uploadId: string
  readonly deviceId: string
  readonly sessionId: string
  readonly filename: string
  readonly uploadDir: string
  readonly tempPath: string
  readonly sizeBytes: number
  readonly chunkBytes: number
  readonly expectedSha256?: string | undefined
  readonly conflictPolicy: 'rename' | 'fail'
  readonly hash: Hash
  fd: number | undefined
  receivedBytes: number
  lastActivityMs: number
  lastChunkStartOffset?: number | undefined
  lastChunkEndOffset?: number | undefined
  lastChunkSha256?: string | undefined
}

export interface WorkspaceUploadManagerOptions {
  readonly maxUploadBytes?: number | undefined
  readonly defaultChunkBytes?: number | undefined
  readonly maxOpenPerDevice?: number | undefined
  readonly maxOpenGlobal?: number | undefined
  readonly idleTtlMs?: number | undefined
  readonly clock?: (() => number) | undefined
}

export function validateSafeUploadFilename(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'filename must be a non-empty string')
  }
  if (raw !== raw.trim()) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'filename must not have leading or trailing whitespace')
  }
  if (Buffer.byteLength(raw, 'utf8') > 255) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'filename exceeds 255 bytes')
  }
  if (raw === '.' || raw === '..' || raw.includes('..')) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'filename must not contain path traversal segments')
  }
  if (raw.startsWith('.tmp-')) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'filename must not use reserved .tmp- prefix')
  }
  if (UNSAFE_FILENAME_RE.test(raw) || basename(raw) !== raw) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'filename must be a safe basename without separators or control characters')
  }
  return raw
}

export function decodeStrictUploadChunkBase64(dataBase64: string, maxChunkBytes: number): Buffer {
  if (typeof dataBase64 !== 'string' || dataBase64.length === 0) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'dataBase64 must be a non-empty string')
  }
  const compact = dataBase64.replace(/\s+/gu, '')
  if (compact.length % 4 !== 0 || !BASE64_STRICT_RE.test(compact)) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'dataBase64 is malformed')
  }
  const decoded = Buffer.from(compact, 'base64')
  if (decoded.byteLength === 0 || decoded.byteLength > maxChunkBytes) {
    throw new RemoteProtocolError(
      'INVALID_REQUEST',
      `decoded chunk size (${decoded.byteLength}) must be 1..${maxChunkBytes} bytes`,
    )
  }
  return decoded
}

function isRealPathInside(rootRealPath: string, candidateRealPath: string): boolean {
  const prefix = rootRealPath.endsWith(sep) ? rootRealPath : `${rootRealPath}${sep}`
  return candidateRealPath.startsWith(prefix)
}

function resolveConfinedUploadDir(workspaceRoot: string): string {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'session workspace root is unavailable')
  }
  let rootReal: string
  try {
    const rootStat = statSync(workspaceRoot)
    if (!rootStat.isDirectory()) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'session workspace root is not a real directory')
    }
    rootReal = realpathSync(workspaceRoot)
  } catch (err) {
    if (err instanceof RemoteProtocolError) throw err
    throw new RemoteProtocolError('INVALID_REQUEST', 'session workspace root does not exist')
  }

  const uploadDir = join(rootReal, WORKSPACE_UPLOAD_SUBDIR)
  if (!existsSync(uploadDir)) {
    try {
      mkdirSync(uploadDir, { mode: 0o750 })
    } catch (err) {
      // Allow harmless race if another concurrent upload created it simultaneously.
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw new RemoteProtocolError('INVALID_REQUEST', 'failed to initialize workspace upload directory')
      }
    }
  }

  let dirReal: string
  try {
    const dirStat = lstatSync(uploadDir)
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'workspace upload directory must not be a symlink')
    }
    dirReal = realpathSync(uploadDir)
  } catch (err) {
    if (err instanceof RemoteProtocolError) throw err
    throw new RemoteProtocolError('INVALID_REQUEST', 'workspace upload directory is inaccessible')
  }

  if (!isRealPathInside(rootReal, dirReal)) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'workspace upload directory escaped session root')
  }
  return dirReal
}

function splitNameAndExtension(filename: string): { readonly stem: string; readonly ext: string } {
  const ext = extname(filename)
  if (ext.length === 0 || ext === filename) {
    return { stem: filename, ext: '' }
  }
  return {
    stem: filename.slice(0, filename.length - ext.length),
    ext,
  }
}

function writeAllBytes(fd: number, data: Buffer): void {
  let offset = 0
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset)
    if (written <= 0) {
      throw new Error('short write while staging workspace upload')
    }
    offset += written
  }
}

/**
 * Bounded, authenticated chunked file uploader for Host session workspaces.
 * Confines writes strictly to `<realpath(sessionCwd)>/.dsh-uploads` without
 * symlinks, enforces chunk & byte budgets, and verifies SHA-256 on commit.
 */
export class WorkspaceUploadManager {
  private readonly maxUploadBytes: number
  private readonly defaultChunkBytes: number
  private readonly maxOpenPerDevice: number
  private readonly maxOpenGlobal: number
  private readonly idleTtlMs: number
  private readonly clock: () => number
  private readonly uploads = new Map<string, ActiveUploadState>()

  constructor(options: WorkspaceUploadManagerOptions = {}) {
    const requestedMax = options.maxUploadBytes ?? DEFAULT_MAX_WORKSPACE_UPLOAD_BYTES
    this.maxUploadBytes = Math.max(
      1024,
      Math.min(HARD_MAX_WORKSPACE_UPLOAD_BYTES, Math.trunc(requestedMax)),
    )
    const requestedChunk = options.defaultChunkBytes ?? MAX_WORKSPACE_UPLOAD_CHUNK_BYTES
    this.defaultChunkBytes = Math.max(
      1,
      Math.min(MAX_WORKSPACE_UPLOAD_CHUNK_BYTES, Math.trunc(requestedChunk)),
    )
    this.maxOpenPerDevice = Math.max(1, Math.trunc(options.maxOpenPerDevice ?? MAX_OPEN_UPLOADS_PER_DEVICE))
    this.maxOpenGlobal = Math.max(this.maxOpenPerDevice, Math.trunc(options.maxOpenGlobal ?? MAX_OPEN_UPLOADS_GLOBAL))
    this.idleTtlMs = Math.max(1_000, Math.trunc(options.idleTtlMs ?? WORKSPACE_UPLOAD_IDLE_TTL_MS))
    this.clock = options.clock ?? Date.now
  }

  open(options: {
    readonly deviceId: string
    readonly sessionId: string
    readonly workspaceRoot: string
    readonly filename: string
    readonly sizeBytes: number
    readonly chunkBytes?: number | undefined
    readonly sha256?: string | undefined
    readonly conflictPolicy?: 'rename' | 'fail' | undefined
  }): WorkspaceUploadOpenResult {
    this.sweepExpired()

    const filename = validateSafeUploadFilename(options.filename)
    if (!Number.isSafeInteger(options.sizeBytes) || options.sizeBytes < 1 || options.sizeBytes > this.maxUploadBytes) {
      throw new RemoteProtocolError(
        'INVALID_REQUEST',
        `sizeBytes must be an integer between 1 and ${this.maxUploadBytes}`,
      )
    }

    let expectedSha256: string | undefined
    if (options.sha256 !== undefined) {
      if (!SHA256_HEX_RE.test(options.sha256)) {
        throw new RemoteProtocolError('INVALID_REQUEST', 'sha256 must be a 64-character hex digest')
      }
      expectedSha256 = options.sha256.toLowerCase()
    }

    const conflictPolicy = options.conflictPolicy ?? 'rename'
    if (conflictPolicy !== 'rename' && conflictPolicy !== 'fail') {
      throw new RemoteProtocolError('INVALID_REQUEST', 'conflictPolicy must be rename or fail')
    }

    let chunkBytes = this.defaultChunkBytes
    if (options.chunkBytes !== undefined) {
      if (!Number.isSafeInteger(options.chunkBytes) || options.chunkBytes < 1) {
        throw new RemoteProtocolError('INVALID_REQUEST', 'chunkBytes must be a positive integer')
      }
      chunkBytes = Math.min(MAX_WORKSPACE_UPLOAD_CHUNK_BYTES, options.chunkBytes)
    }

    if (this.uploads.size >= this.maxOpenGlobal) {
      throw new RemoteProtocolError('STATE_CAPACITY_EXCEEDED', 'global open workspace upload limit reached')
    }
    let deviceCount = 0
    for (const active of this.uploads.values()) {
      if (active.deviceId === options.deviceId) deviceCount += 1
    }
    if (deviceCount >= this.maxOpenPerDevice) {
      throw new RemoteProtocolError('STATE_CAPACITY_EXCEEDED', 'per-device open workspace upload limit reached')
    }

    const uploadDir = resolveConfinedUploadDir(options.workspaceRoot)
    this.pruneOrphanStagingFiles(uploadDir)
    if (conflictPolicy === 'fail' && existsSync(join(uploadDir, filename))) {
      throw new RemoteProtocolError('INVALID_REQUEST', `target file already exists: ${WORKSPACE_UPLOAD_SUBDIR}/${filename}`)
    }

    const uploadId = `upl-${randomUUID()}`
    const tempPath = join(uploadDir, `.tmp-${uploadId}`)
    let fd: number
    try {
      fd = openSync(
        tempPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      )
    } catch {
      throw new RemoteProtocolError('INVALID_REQUEST', 'failed to create workspace upload staging file')
    }

    this.uploads.set(uploadId, {
      uploadId,
      deviceId: options.deviceId,
      sessionId: options.sessionId,
      filename,
      uploadDir,
      tempPath,
      sizeBytes: options.sizeBytes,
      chunkBytes,
      expectedSha256,
      conflictPolicy,
      hash: createHash('sha256'),
      fd,
      receivedBytes: 0,
      lastActivityMs: this.clock(),
    })

    return {
      uploadId,
      sessionId: options.sessionId,
      chunkBytes,
      maxBytes: this.maxUploadBytes,
      relativePath: `${WORKSPACE_UPLOAD_SUBDIR}/${filename}`,
    }
  }

  appendChunk(options: {
    readonly deviceId: string
    readonly uploadId: string
    readonly offset: number
    readonly dataBase64: string
  }): WorkspaceUploadChunkResult {
    this.sweepExpired()
    const active = this.requireOwnedUpload(options.deviceId, options.uploadId)
    if (!Number.isSafeInteger(options.offset) || options.offset < 0) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'offset must be a non-negative integer')
    }
    const decoded = decodeStrictUploadChunkBase64(options.dataBase64, active.chunkBytes)
    const chunkSha256 = createHash('sha256').update(decoded).digest('hex')

    // O(1) retry idempotency for the immediately preceding chunk across carrier drops,
    // without storing raw 32 KiB chunks in IdempotencyStore.
    if (
      active.lastChunkStartOffset !== undefined &&
      options.offset === active.lastChunkStartOffset &&
      options.offset + decoded.byteLength === active.lastChunkEndOffset
    ) {
      if (chunkSha256 === active.lastChunkSha256) {
        active.lastActivityMs = this.clock()
        return {
          uploadId: active.uploadId,
          receivedBytes: active.receivedBytes,
          nextOffset: active.receivedBytes,
        }
      }
      throw new RemoteProtocolError(
        'IDEMPOTENCY_CONFLICT',
        'retried chunk offset carried conflicting bytes',
      )
    }

    if (options.offset !== active.receivedBytes) {
      throw new RemoteProtocolError(
        'INVALID_REQUEST',
        `chunk offset mismatch: expected ${active.receivedBytes}, received ${options.offset}`,
      )
    }
    if (active.receivedBytes + decoded.byteLength > active.sizeBytes) {
      this.cleanupUpload(active.uploadId)
      throw new RemoteProtocolError(
        'INVALID_REQUEST',
        `chunk exceeds declared upload size (${active.sizeBytes} bytes)`,
      )
    }
    if (active.fd === undefined) {
      this.cleanupUpload(active.uploadId)
      throw new RemoteProtocolError('INVALID_REQUEST', 'upload file descriptor is closed')
    }

    try {
      writeAllBytes(active.fd, decoded)
    } catch {
      this.cleanupUpload(active.uploadId)
      throw new RemoteProtocolError('INVALID_REQUEST', 'failed to write workspace upload chunk')
    }

    active.hash.update(decoded)
    active.lastChunkStartOffset = options.offset
    active.lastChunkEndOffset = options.offset + decoded.byteLength
    active.lastChunkSha256 = chunkSha256
    active.receivedBytes += decoded.byteLength
    active.lastActivityMs = this.clock()

    return {
      uploadId: active.uploadId,
      receivedBytes: active.receivedBytes,
      nextOffset: active.receivedBytes,
    }
  }

  commit(options: {
    readonly deviceId: string
    readonly uploadId: string
    readonly sha256?: string | undefined
  }): WorkspaceUploadCommitResult {
    this.sweepExpired()
    const active = this.requireOwnedUpload(options.deviceId, options.uploadId)

    let commitSha256: string | undefined
    if (options.sha256 !== undefined) {
      if (!SHA256_HEX_RE.test(options.sha256)) {
        throw new RemoteProtocolError('INVALID_REQUEST', 'sha256 must be a 64-character hex digest')
      }
      commitSha256 = options.sha256.toLowerCase()
    }

    if (
      active.expectedSha256 !== undefined &&
      commitSha256 !== undefined &&
      active.expectedSha256 !== commitSha256
    ) {
      this.cleanupUpload(active.uploadId)
      throw new RemoteProtocolError('INVALID_REQUEST', 'open and commit sha256 digests do not match')
    }

    const expected = commitSha256 ?? active.expectedSha256
    if (active.receivedBytes !== active.sizeBytes) {
      this.cleanupUpload(active.uploadId)
      throw new RemoteProtocolError(
        'INVALID_REQUEST',
        `upload incomplete: received ${active.receivedBytes} of ${active.sizeBytes} bytes`,
      )
    }

    this.closeDescriptorOnly(active)
    const actualSha256 = active.hash.digest('hex')
    if (expected !== undefined && actualSha256 !== expected) {
      this.cleanupUpload(active.uploadId)
      throw new RemoteProtocolError('INVALID_REQUEST', 'uploaded file sha256 verification failed')
    }

    const finalFilename = this.publishStagedFile(active)
    this.uploads.delete(active.uploadId)

    return {
      uploadId: active.uploadId,
      sessionId: active.sessionId,
      relativePath: `${WORKSPACE_UPLOAD_SUBDIR}/${finalFilename}`,
      bytesWritten: active.receivedBytes,
      sha256: actualSha256,
    }
  }

  abort(options: { readonly deviceId: string; readonly uploadId: string }): WorkspaceUploadAbortResult {
    this.sweepExpired()
    const active = this.uploads.get(options.uploadId)
    if (!active) {
      return { uploadId: options.uploadId, aborted: false }
    }
    if (active.deviceId !== options.deviceId) {
      throw new RemoteProtocolError('CAPABILITY_DENIED', 'upload belongs to a different device')
    }
    this.cleanupUpload(active.uploadId)
    return { uploadId: active.uploadId, aborted: true }
  }

  revokeDevice(deviceId: string): number {
    let cleaned = 0
    for (const [uploadId, active] of this.uploads.entries()) {
      if (active.deviceId === deviceId) {
        this.cleanupUpload(uploadId)
        cleaned += 1
      }
    }
    return cleaned
  }

  activeCount(): number {
    this.sweepExpired()
    return this.uploads.size
  }

  disposeAll(): void {
    for (const uploadId of [...this.uploads.keys()]) {
      this.cleanupUpload(uploadId)
    }
  }

  private sweepExpired(): void {
    const now = this.clock()
    for (const [uploadId, active] of this.uploads.entries()) {
      if (now - active.lastActivityMs > this.idleTtlMs) {
        this.cleanupUpload(uploadId)
      }
    }
  }

  private pruneOrphanStagingFiles(uploadDir: string): void {
    const now = this.clock()
    const activeTempPaths = new Set<string>()
    for (const active of this.uploads.values()) {
      if (active.uploadDir === uploadDir) {
        activeTempPaths.add(active.tempPath)
      }
    }
    let entries: Dirent[]
    try {
      entries = readdirSync(uploadDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.name.startsWith('.tmp-upl-')) continue
      const candidatePath = join(uploadDir, entry.name)
      if (activeTempPaths.has(candidatePath)) continue
      try {
        const st = lstatSync(candidatePath)
        if (st.isSymbolicLink() || !st.isFile()) continue
        if (now - st.mtimeMs >= this.idleTtlMs) {
          unlinkSync(candidatePath)
        }
      } catch {}
    }
  }

  private requireOwnedUpload(deviceId: string, uploadId: string): ActiveUploadState {
    const active = this.uploads.get(uploadId)
    if (!active) {
      throw new RemoteProtocolError('INVALID_REQUEST', `unknown or expired uploadId: ${uploadId}`)
    }
    if (active.deviceId !== deviceId) {
      throw new RemoteProtocolError('CAPABILITY_DENIED', 'upload belongs to a different device')
    }
    return active
  }

  private closeDescriptorOnly(active: ActiveUploadState): void {
    if (active.fd !== undefined) {
      const fd = active.fd
      active.fd = undefined
      try {
        closeSync(fd)
      } catch {}
    }
  }

  private cleanupUpload(uploadId: string): void {
    const active = this.uploads.get(uploadId)
    if (!active) return
    this.uploads.delete(uploadId)
    this.closeDescriptorOnly(active)
    try {
      if (existsSync(active.tempPath)) {
        unlinkSync(active.tempPath)
      }
    } catch {}
  }

  private publishStagedFile(active: ActiveUploadState): string {
    const { stem, ext } = splitNameAndExtension(active.filename)
    const maxAttempts = active.conflictPolicy === 'fail' ? 1 : 256
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const candidateName = attempt === 0 ? active.filename : `${stem} (${attempt})${ext}`
      const candidatePath = join(active.uploadDir, candidateName)
      try {
        // Atomic link avoids POSIX renameSync overwriting an existing file on race.
        linkSync(active.tempPath, candidatePath)
        try {
          unlinkSync(active.tempPath)
        } catch {}
        return candidateName
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'EEXIST') {
          continue
        }
        if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP') {
          if (!existsSync(candidatePath)) {
            renameSync(active.tempPath, candidatePath)
            return candidateName
          }
          continue
        }
        this.cleanupUpload(active.uploadId)
        throw new RemoteProtocolError('INVALID_REQUEST', 'failed to finalize workspace upload file')
      }
    }
    this.cleanupUpload(active.uploadId)
    throw new RemoteProtocolError(
      'INVALID_REQUEST',
      active.conflictPolicy === 'fail'
        ? `target file already exists: ${WORKSPACE_UPLOAD_SUBDIR}/${active.filename}`
        : `unable to allocate unique destination name for ${active.filename}`,
    )
  }
}
