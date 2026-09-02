import { createHash } from 'node:crypto'
import { inspect } from 'node:util'
// @ts-ignore - noise-handshake/dh.js
import dh from 'noise-handshake/dh.js'

export interface HostIdentity {
  readonly publicKey: Uint8Array
  readonly fingerprint: string
  readonly trustDomainId: string
  readonly generation: number
  readonly createdAt: number
}

export function toHostIdentitySnapshot(identity: HostIdentity): HostIdentity {
  return Object.freeze({
    publicKey: new Uint8Array(identity.publicKey),
    fingerprint: identity.fingerprint,
    trustDomainId: identity.trustDomainId,
    generation: identity.generation,
    createdAt: identity.createdAt,
  })
}

export class HostKeyPair {
  readonly identity: HostIdentity
  readonly secretKey!: Uint8Array

  constructor(identity: HostIdentity, secretKey: Uint8Array) {
    this.identity = toHostIdentitySnapshot(identity)
    Object.defineProperty(this, 'secretKey', {
      value: new Uint8Array(secretKey),
      enumerable: false,
      writable: false,
      configurable: false,
    })
    Object.freeze(this)
  }

  toJSON(): { identity: HostIdentity } {
    return { identity: this.identity }
  }

  [inspect.custom](): string {
    return `HostKeyPair { fingerprint: ${JSON.stringify(this.identity.fingerprint)}, trustDomainId: ${JSON.stringify(this.identity.trustDomainId)}, generation: ${this.identity.generation}, secretKey: '[REDACTED]' }`
  }

  toString(): string {
    return this[inspect.custom]()
  }
}

export function toHostKeyPairSnapshot(keyPair: HostKeyPair): HostKeyPair {
  return new HostKeyPair(keyPair.identity, keyPair.secretKey)
}

export function computeFingerprint(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest('hex')
}

export function computeTrustDomainId(publicKey: Uint8Array, generation: number): string {
  return createHash('sha256')
    .update(publicKey)
    .update(`:gen:${generation}`)
    .digest('hex')
}

export interface HostIdentityStore {
  loadOrCreate(): Promise<HostKeyPair>
  getPublicIdentity(): Promise<HostIdentity>
  rotate(): Promise<HostKeyPair>
  destroy(): Promise<void>
}

interface DhModule {
  generateKeyPair(secretKey?: Uint8Array): {
    publicKey: Buffer
    secretKey: Buffer
  }
}

const dhHelper: DhModule =
  (dh as unknown as { default?: DhModule }).default ?? (dh as unknown as DhModule)

export class InMemoryHostIdentityStore implements HostIdentityStore {
  private masterKeyPair: HostKeyPair | undefined = undefined
  private currentGeneration = 1
  private readonly clock: () => number

  constructor(options?: { clock?: () => number }) {
    this.clock = options?.clock ?? Date.now
  }

  async loadOrCreate(): Promise<HostKeyPair> {
    if (this.masterKeyPair) {
      return toHostKeyPairSnapshot(this.masterKeyPair)
    }
    const raw = dhHelper.generateKeyPair()
    const publicKey = new Uint8Array(raw.publicKey)
    const secretKey = new Uint8Array(raw.secretKey)
    const fingerprint = computeFingerprint(publicKey)
    const trustDomainId = computeTrustDomainId(publicKey, this.currentGeneration)
    this.masterKeyPair = new HostKeyPair(
      {
        publicKey,
        fingerprint,
        trustDomainId,
        generation: this.currentGeneration,
        createdAt: this.clock(),
      },
      secretKey,
    )
    return toHostKeyPairSnapshot(this.masterKeyPair)
  }

  async getPublicIdentity(): Promise<HostIdentity> {
    if (!this.masterKeyPair) {
      await this.loadOrCreate()
    }
    return toHostIdentitySnapshot(this.masterKeyPair!.identity)
  }

  async rotate(): Promise<HostKeyPair> {
    this.currentGeneration += 1
    const raw = dhHelper.generateKeyPair()
    const publicKey = new Uint8Array(raw.publicKey)
    const secretKey = new Uint8Array(raw.secretKey)
    const fingerprint = computeFingerprint(publicKey)
    const trustDomainId = computeTrustDomainId(publicKey, this.currentGeneration)
    this.masterKeyPair = new HostKeyPair(
      {
        publicKey,
        fingerprint,
        trustDomainId,
        generation: this.currentGeneration,
        createdAt: this.clock(),
      },
      secretKey,
    )
    return toHostKeyPairSnapshot(this.masterKeyPair)
  }

  async destroy(): Promise<void> {
    this.masterKeyPair = undefined
  }
}
