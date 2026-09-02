import { createHash, randomBytes } from 'node:crypto'
import { inspect } from 'node:util'
import type { Capability } from '../protocol.js'
import { RemoteCryptoError } from './errors.js'
import { computeFingerprint } from './host-identity.js'

export const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000 // 5 minutes
export const MAX_PAIRING_TTL_MS = 5 * 60 * 1000 // 5 minutes ceiling (300,000 ms)

export type PairingCandidateState = 'PENDING' | 'CONFIRMING' | 'CONSUMED'

interface StoredPairingCandidate {
  readonly candidateId: string
  readonly remoteStaticPublicKey: Uint8Array
  readonly deviceId: string
  readonly displayName: string
  readonly maxAllowedCapabilities: readonly Capability[]
  readonly tokenHash: string
  readonly trustDomainId: string
  readonly hostGeneration: number
  readonly expiresAt: number
  state: PairingCandidateState
}

export interface PairingCandidateView {
  readonly candidateId: string
  readonly remoteStaticPublicKey: Uint8Array
  readonly deviceId: string
  readonly displayName: string
  readonly maxAllowedCapabilities: readonly Capability[]
  readonly tokenHash: string
  readonly trustDomainId: string
  readonly hostGeneration: number
  readonly expiresAt: number
  readonly state: PairingCandidateState
}

export type PairingCandidate = PairingCandidateView

export interface ClaimedCandidateTransaction {
  readonly candidateId: string
  readonly remoteStaticPublicKey: Uint8Array
  readonly deviceId: string
  readonly displayName: string
  readonly maxAllowedCapabilities: readonly Capability[]
  readonly tokenHash: string
  readonly trustDomainId: string
  readonly hostGeneration: number
  readonly expiresAt: number
  commit(): void
  rollback(): void
}

function toCandidateView(stored: StoredPairingCandidate): PairingCandidateView {
  return Object.freeze({
    candidateId: stored.candidateId,
    remoteStaticPublicKey: new Uint8Array(stored.remoteStaticPublicKey),
    deviceId: stored.deviceId,
    displayName: stored.displayName,
    maxAllowedCapabilities: Object.freeze([...stored.maxAllowedCapabilities]),
    tokenHash: stored.tokenHash,
    trustDomainId: stored.trustDomainId,
    hostGeneration: stored.hostGeneration,
    expiresAt: stored.expiresAt,
    state: stored.state,
  })
}

interface StoredTokenRecord {
  readonly tokenHash: string
  readonly expiresAt: number
  readonly allowedCapabilities: readonly Capability[]
  readonly trustDomainId: string
  readonly hostGeneration: number
  inReviewCandidateId?: string | undefined
}

export class PairingToken {
  readonly tokenHash: string
  readonly expiresAt: number
  readonly allowedCapabilities: readonly Capability[]
  readonly trustDomainId: string
  readonly hostGeneration: number
  private readonly rawToken!: string

  constructor(
    rawToken: string,
    tokenHash: string,
    expiresAt: number,
    allowedCapabilities: readonly Capability[],
    trustDomainId: string,
    hostGeneration: number,
  ) {
    this.tokenHash = tokenHash
    this.expiresAt = expiresAt
    this.allowedCapabilities = Object.freeze([...allowedCapabilities])
    this.trustDomainId = trustDomainId
    this.hostGeneration = hostGeneration
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
      hostGeneration: this.hostGeneration,
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
  private readonly candidates = new Map<string, StoredPairingCandidate>()
  private readonly clock: () => number

  constructor(
    readonly maxPending = 16,
    readonly defaultTtlMs = DEFAULT_PAIRING_TTL_MS,
    readonly maxTtlMs = MAX_PAIRING_TTL_MS,
    options?: { clock?: () => number },
  ) {
    if (!Number.isInteger(maxPending) || maxPending < 1) {
      throw new Error('maxPending must be a positive integer')
    }
    if (
      !Number.isInteger(maxTtlMs) ||
      !Number.isFinite(maxTtlMs) ||
      maxTtlMs < 1 ||
      maxTtlMs > MAX_PAIRING_TTL_MS
    ) {
      throw new RemoteCryptoError(
        'STATE_CAPACITY_EXCEEDED',
        `maxTtlMs must be an integer between 1 and ${MAX_PAIRING_TTL_MS}`,
      )
    }
    if (
      !Number.isInteger(defaultTtlMs) ||
      !Number.isFinite(defaultTtlMs) ||
      defaultTtlMs < 1 ||
      defaultTtlMs > maxTtlMs
    ) {
      throw new Error(`defaultTtlMs must be a positive integer <= ${maxTtlMs}`)
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
    hostGeneration: number
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

    let ttl = this.defaultTtlMs
    if (params.ttlMs !== undefined) {
      if (
        !Number.isInteger(params.ttlMs) ||
        !Number.isFinite(params.ttlMs) ||
        params.ttlMs <= 0 ||
        params.ttlMs > this.maxTtlMs
      ) {
        throw new RemoteCryptoError(
          'STATE_CAPACITY_EXCEEDED',
          `custom TTL must be a finite integer between 1 and ${this.maxTtlMs} ms`,
        )
      }
      ttl = params.ttlMs
    }

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
      hostGeneration: params.hostGeneration,
      inReviewCandidateId: undefined,
    }

    this.tokens.set(tokenHash, record)
    return new PairingToken(
      rawToken,
      tokenHash,
      expiresAt,
      allowedCapabilities,
      params.trustDomainId,
      params.hostGeneration,
    )
  }

  verifyCandidate(params: {
    rawToken: string
    remoteStaticPublicKey: Uint8Array
    displayName: string
    currentTrustDomainId: string
    currentHostGeneration: number
    requestedCapabilities?: readonly Capability[] | undefined
  }): PairingCandidateView {
    const now = this.clock()
    const tokenHash = this.hashToken(params.rawToken)
    const record = this.tokens.get(tokenHash)

    // Uniform external security error: do not disclose whether token is missing, expired, or used
    if (!record || now > record.expiresAt || record.inReviewCandidateId !== undefined) {
      if (record && now > record.expiresAt) {
        this.tokens.delete(tokenHash)
      }
      throw new RemoteCryptoError('PAIRING_FAILED', 'pairing verification failed')
    }

    if (
      record.trustDomainId !== params.currentTrustDomainId ||
      record.hostGeneration !== params.currentHostGeneration
    ) {
      this.tokens.delete(tokenHash)
      throw new RemoteCryptoError('PAIRING_FAILED', 'pairing verification failed')
    }

    // P0-6: Authoritative deviceId is strictly derived from Noise authenticated public key
    const derivedDeviceId = computeFingerprint(params.remoteStaticPublicKey)
    const candidateId = `cand-${randomBytes(16).toString('hex')}`

    // Internal stored record (defensively copied)
    const storedCandidate: StoredPairingCandidate = {
      candidateId,
      remoteStaticPublicKey: new Uint8Array(params.remoteStaticPublicKey),
      deviceId: derivedDeviceId,
      displayName: params.displayName,
      maxAllowedCapabilities: [...record.allowedCapabilities],
      tokenHash,
      trustDomainId: record.trustDomainId,
      hostGeneration: record.hostGeneration,
      expiresAt: record.expiresAt,
      state: 'PENDING',
    }

    record.inReviewCandidateId = candidateId
    this.candidates.set(candidateId, storedCandidate)

    return toCandidateView(storedCandidate)
  }

  getCandidate(candidateId: string): PairingCandidateView | undefined {
    const stored = this.candidates.get(candidateId)
    return stored ? toCandidateView(stored) : undefined
  }

  /**
   * P0-2: Synchronously claim candidate for confirmation before any async operation.
   * Enforces single-winner state transition: PENDING -> CONFIRMING -> CONSUMED.
   * Returns a safe transaction handle with defensive snapshot copies.
   */
  claimCandidateForConfirmation(candidateId: string): ClaimedCandidateTransaction {
    const candidate = this.candidates.get(candidateId)
    if (!candidate) {
      throw new RemoteCryptoError('PAIRING_FAILED', 'pairing candidate not found or already consumed')
    }

    if (candidate.state !== 'PENDING') {
      throw new RemoteCryptoError(
        'PAIRING_FAILED',
        `candidate is in state '${candidate.state}' and cannot be claimed for confirmation`,
      )
    }

    const now = this.clock()
    if (now > candidate.expiresAt) {
      candidate.state = 'CONSUMED'
      this.burnCandidateAndToken(candidateId)
      throw new RemoteCryptoError('PAIRING_FAILED', 'pairing candidate has expired')
    }

    // Atomically transition to CONFIRMING in the current tick
    candidate.state = 'CONFIRMING'

    const txRemoteStaticPublicKey = new Uint8Array(candidate.remoteStaticPublicKey)
    const txMaxCapabilities = Object.freeze([...candidate.maxAllowedCapabilities])
    let finalized = false

    return Object.freeze({
      candidateId: candidate.candidateId,
      remoteStaticPublicKey: txRemoteStaticPublicKey,
      deviceId: candidate.deviceId,
      displayName: candidate.displayName,
      maxAllowedCapabilities: txMaxCapabilities,
      tokenHash: candidate.tokenHash,
      trustDomainId: candidate.trustDomainId,
      hostGeneration: candidate.hostGeneration,
      expiresAt: candidate.expiresAt,
      commit: () => {
        if (finalized) return
        finalized = true
        candidate.state = 'CONSUMED'
        this.burnCandidateAndToken(candidateId)
      },
      rollback: () => {
        if (finalized) return
        finalized = true
        candidate.state = 'CONSUMED'
        this.burnCandidateAndToken(candidateId)
      },
    })
  }

  /**
   * P0-2: Synchronously reject candidate. Single-winner race against confirmation.
   * If already CONFIRMING or CONSUMED, reject fails and cannot reverse in-flight confirmation.
   */
  rejectCandidate(candidateId: string): boolean {
    const candidate = this.candidates.get(candidateId)
    if (!candidate) {
      return false
    }

    if (candidate.state !== 'PENDING') {
      return false
    }

    candidate.state = 'CONSUMED'
    this.burnCandidateAndToken(candidateId)
    return true
  }

  burnCandidateAndToken(candidateId: string): void {
    const candidate = this.candidates.get(candidateId)
    if (candidate) {
      this.tokens.delete(candidate.tokenHash)
      this.candidates.delete(candidateId)
    }
  }
}
