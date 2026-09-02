import { randomBytes } from 'node:crypto'
import { inspect } from 'node:util'
import type { Capability } from '../protocol.js'
import { RemoteCryptoError } from './errors.js'

export interface PairingTokenRecord {
  readonly token: string
  readonly expiresAt: number
  readonly allowedCapabilities: readonly Capability[]
  consumed: boolean
}

export class PairingToken {
  constructor(
    readonly token: string,
    readonly expiresAt: number,
    readonly allowedCapabilities: readonly Capability[],
  ) {}

  [inspect.custom](): string {
    return `PairingToken { expiresAt: ${this.expiresAt}, capabilities: ${JSON.stringify(this.allowedCapabilities)}, token: '[REDACTED]' }`
  }

  toString(): string {
    return this[inspect.custom]()
  }
}

export class PairingTokenRegistry {
  private readonly tokens = new Map<string, PairingTokenRecord>()
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

  private pruneExpired(now: number): void {
    for (const [key, record] of this.tokens.entries()) {
      if (now > record.expiresAt) {
        this.tokens.delete(key)
      }
    }
  }

  createToken(options?: {
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

    const ttl = options?.ttlMs ?? this.defaultTtlMs
    const expiresAt = now + ttl
    const allowedCapabilities = options?.allowedCapabilities ?? ['observe', 'prompt', 'approve', 'answer-question']
    const token = randomBytes(32).toString('hex')

    const record: PairingTokenRecord = {
      token,
      expiresAt,
      allowedCapabilities: [...allowedCapabilities],
      consumed: false,
    }

    this.tokens.set(token, record)
    return new PairingToken(token, expiresAt, allowedCapabilities)
  }

  consume(token: string): { ok: true; capabilities: readonly Capability[] } | { ok: false; code: 'PAIRING_TOKEN_INVALID' | 'PAIRING_TOKEN_EXPIRED' | 'PAIRING_TOKEN_USED' } {
    const now = this.clock()
    const record = this.tokens.get(token)

    if (!record) {
      return { ok: false, code: 'PAIRING_TOKEN_INVALID' }
    }

    if (record.consumed) {
      this.tokens.delete(token)
      return { ok: false, code: 'PAIRING_TOKEN_USED' }
    }

    if (now > record.expiresAt) {
      this.tokens.delete(token)
      return { ok: false, code: 'PAIRING_TOKEN_EXPIRED' }
    }

    record.consumed = true
    this.tokens.delete(token)
    return { ok: true, capabilities: record.allowedCapabilities }
  }
}
