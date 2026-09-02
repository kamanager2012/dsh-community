import { createHash, randomBytes } from 'node:crypto'
import { inspect } from 'node:util'
import type { Capability } from '../protocol.js'
import { RemoteCryptoError } from './errors.js'

export interface PairingCandidate {
  readonly candidateId: string
  readonly clientDeviceId: string
  readonly clientDisplayName: string
  readonly maxAllowedCapabilities: readonly Capability[]
  readonly tokenHash: string
  readonly expiresAt: number
}

interface StoredTokenRecord {
  readonly tokenHash: string
  readonly expiresAt: number
  readonly allowedCapabilities: readonly Capability[]
  readonly trustDomainId: string
  inReviewCandidateId?: string | undefined
}

export class PairingToken {
  readonly tokenHash: string
  readonly expiresAt: number
  readonly allowedCapabilities: readonly Capability[]
  readonly trustDomainId: string
  private readonly rawToken!: string

  constructor(
    rawToken: string,
    tokenHash: string,
    expiresAt: number,
    allowedCapabilities: readonly Capability[],
    trustDomainId: string,
  ) {
    this.tokenHash = tokenHash
    this.expiresAt = expiresAt
    this.allowedCapabilities = allowedCapabilities
    this.trustDomainId = trustDomainId
    Object.defineProperty(this, 'rawToken', {
      value: rawToken,
      enumerable: false,
      writable: false,
      configurable: false,
    })
  }

  get token(): string {
    return (this as unknown as { rawToken: string }).rawToken
  }

  toJSON(): object {
    return {
      tokenHash: this.tokenHash,
      expiresAt: this.expiresAt,
      capabilities: this.allowedCapabilities,
      trustDomainId: this.trustDomainId,
    }
  }

  [inspect.custom](): string {
    return `PairingToken { tokenHash: ${JSON.stringify(this.tokenHash)}, expiresAt: ${this.expiresAt}, capabilities: ${JSON.stringify(this.allowedCapabilities)}, token: '[REDACTED]' }`
  }

  toString(): string {
    return this[inspect.custom]()
  }
}

export class PairingTokenRegistry {
  private readonly tokens = new Map<string, StoredTokenRecord>()
  private readonly candidates = new Map<string, PairingCandidate>()
  private readonly clock: () => number

  constructor(
    readonly maxPending = 16,
    readonly defaultTtlMs = 5 * 60 * 1000,
    options?: { clock?: () => number },
  ) {
    if (!Number.isInteger(maxPending) || maxPending < 1) {
      throw new Error('maxPending must be a positive integer')
    }
    if (!Number.isInteger(defaultTtlMs) || defaultTtlMs < 1) {
      throw new Error('defaultTtlMs must be a positive integer')
    }
    this.clock = options?.clock ?? Date.now
  }

  get size(): number {
    return this.tokens.size
  }

  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex')
  }

  private pruneExpired(now: number): void {
    for (const [hash, record] of this.tokens.entries()) {
      if (now > record.expiresAt) {
        this.tokens.delete(hash)
        if (record.inReviewCandidateId) {
          this.candidates.delete(record.inReviewCandidateId)
        }
      }
    }
  }

  createToken(params: {
    trustDomainId: string
    ttlMs?: number
    allowedCapabilities?: readonly Capability[]
  }): PairingToken {
    const now = this.clock()
    this.pruneExpired(now)

    if (this.tokens.size >= this.maxPending) {
      throw new RemoteCryptoError(
        'STATE_CAPACITY_EXCEEDED',
        'pairing-token registry capacity is exhausted',
      )
    }

    const ttl = params.ttlMs ?? this.defaultTtlMs
    const expiresAt = now + ttl
    // Least privilege default: 'observe' only. Never default to approve/full.
    const allowedCapabilities = params.allowedCapabilities ?? ['observe']
    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = this.hashToken(rawToken)

    const record: StoredTokenRecord = {
      tokenHash,
      expiresAt,
      allowedCapabilities: [...allowedCapabilities],
      trustDomainId: params.trustDomainId,
      inReviewCandidateId: undefined,
    }

    this.tokens.set(tokenHash, record)
    return new PairingToken(
      rawToken,
      tokenHash,
      expiresAt,
      allowedCapabilities,
      params.trustDomainId,
    )
  }

  verifyCandidate(params: {
    rawToken: string
    clientDeviceId: string
    clientDisplayName: string
    currentTrustDomainId: string
  }): { ok: true; candidate: PairingCandidate } | { ok: false; error: RemoteCryptoError } {
    const now = this.clock()
    const tokenHash = this.hashToken(params.rawToken)
    const record = this.tokens.get(tokenHash)

    // Uniform external security error: do not disclose whether token is missing, expired, or used
    if (!record || now > record.expiresAt || record.inReviewCandidateId !== undefined) {
      if (record && now > record.expiresAt) {
        this.tokens.delete(tokenHash)
      }
      return {
        ok: false,
        error: new RemoteCryptoError('PAIRING_FAILED', 'pairing verification failed'),
      }
    }

    if (record.trustDomainId !== params.currentTrustDomainId) {
      this.tokens.delete(tokenHash)
      return {
        ok: false,
        error: new RemoteCryptoError('PAIRING_FAILED', 'pairing verification failed'),
      }
    }

    const candidateId = `cand-${randomBytes(16).toString('hex')}`
    const candidate: PairingCandidate = {
      candidateId,
      clientDeviceId: params.clientDeviceId,
      clientDisplayName: params.clientDisplayName,
      maxAllowedCapabilities: record.allowedCapabilities,
      tokenHash,
      expiresAt: record.expiresAt,
    }

    record.inReviewCandidateId = candidateId
    this.candidates.set(candidateId, candidate)

    return { ok: true, candidate }
  }

  confirmCandidate(params: {
    candidateId: string
    confirmedCapabilities: readonly Capability[]
  }): { ok: true; grantedCapabilities: readonly Capability[] } | { ok: false; error: RemoteCryptoError } {
    const candidate = this.candidates.get(params.candidateId)
    if (!candidate) {
      return {
        ok: false,
        error: new RemoteCryptoError('PAIRING_FAILED', 'pairing candidate not found or expired'),
      }
    }

    const maxSet = new Set(candidate.maxAllowedCapabilities)
    for (const cap of params.confirmedCapabilities) {
      if (!maxSet.has(cap)) {
        return {
          ok: false,
          error: new RemoteCryptoError(
            'PAIRING_FAILED',
            `cannot grant capability '${cap}' exceeding token permission`,
          ),
        }
      }
    }

    // Atomically burn token and candidate
    this.tokens.delete(candidate.tokenHash)
    this.candidates.delete(params.candidateId)

    return {
      ok: true,
      grantedCapabilities: [...params.confirmedCapabilities],
    }
  }

  rejectCandidate(candidateId: string): void {
    const candidate = this.candidates.get(candidateId)
    if (candidate) {
      this.tokens.delete(candidate.tokenHash)
      this.candidates.delete(candidateId)
    }
  }
}
