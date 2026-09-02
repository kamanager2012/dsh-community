import { createHash } from 'node:crypto'
import { inspect } from 'node:util'
// @ts-ignore - noise-handshake/dh
import dh from 'noise-handshake/dh.js'

export interface HostIdentity {
  readonly publicKey: Uint8Array
  readonly fingerprint: string
  readonly createdAt: number
}

export class HostKeyPair {
  constructor(
    readonly identity: HostIdentity,
    readonly secretKey: Uint8Array,
  ) {}

  [inspect.custom](): string {
    return `HostKeyPair { fingerprint: ${JSON.stringify(this.identity.fingerprint)}, secretKey: '[REDACTED]' }`
  }

  toString(): string {
    return this[inspect.custom]()
  }
}

export function computeFingerprint(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest('hex')
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

const dhHelper: DhModule = (dh as unknown as { default?: DhModule }).default ?? (dh as unknown as DhModule)

export class InMemoryHostIdentityStore implements HostIdentityStore {
  private currentKeyPair: HostKeyPair | undefined = undefined
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
    this.currentKeyPair = new HostKeyPair(
      {
        publicKey,
        fingerprint,
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
    const raw = dhHelper.generateKeyPair()
    const publicKey = new Uint8Array(raw.publicKey)
    const secretKey = new Uint8Array(raw.secretKey)
    const fingerprint = computeFingerprint(publicKey)
    this.currentKeyPair = new HostKeyPair(
      {
        publicKey,
        fingerprint,
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
