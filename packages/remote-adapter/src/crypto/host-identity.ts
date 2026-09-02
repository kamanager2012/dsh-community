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

export class HostKeyPair {
  readonly identity: HostIdentity
  readonly secretKey!: Uint8Array

  constructor(identity: HostIdentity, secretKey: Uint8Array) {
    this.identity = identity
    Object.defineProperty(this, 'secretKey', {
      value: secretKey,
      enumerable: false,
      writable: false,
      configurable: false,
    })
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
  private currentKeyPair: HostKeyPair | undefined = undefined
  private currentGeneration = 1
  private readonly clock: () => number

  constructor(options?: { clock?: () => number }) {
    this.clock = options?.clock ?? Date.now
  }

  async loadOrCreate(): Promise<HostKeyPair> {
    if (this.currentKeyPair) {
      return this.currentKeyPair
    }
    const raw = dhHelper.generateKeyPair()
    const publicKey = new Uint8Array(raw.publicKey)
    const secretKey = new Uint8Array(raw.secretKey)
    const fingerprint = computeFingerprint(publicKey)
    const trustDomainId = computeTrustDomainId(publicKey, this.currentGeneration)
    this.currentKeyPair = new HostKeyPair(
      {
        publicKey,
        fingerprint,
        trustDomainId,
        generation: this.currentGeneration,
        createdAt: this.clock(),
      },
      secretKey,
    )
    return this.currentKeyPair
  }

  async getPublicIdentity(): Promise<HostIdentity> {
    const keyPair = await this.loadOrCreate()
    return keyPair.identity
  }

  async rotate(): Promise<HostKeyPair> {
    this.currentGeneration += 1
    const raw = dhHelper.generateKeyPair()
    const publicKey = new Uint8Array(raw.publicKey)
    const secretKey = new Uint8Array(raw.secretKey)
    const fingerprint = computeFingerprint(publicKey)
    const trustDomainId = computeTrustDomainId(publicKey, this.currentGeneration)
    this.currentKeyPair = new HostKeyPair(
      {
        publicKey,
        fingerprint,
        trustDomainId,
        generation: this.currentGeneration,
        createdAt: this.clock(),
      },
      secretKey,
    )
    return this.currentKeyPair
  }

  async destroy(): Promise<void> {
    this.currentKeyPair = undefined
  }
}
