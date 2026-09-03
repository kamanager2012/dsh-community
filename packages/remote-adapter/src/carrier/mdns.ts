import { RemoteCryptoError } from '../crypto/errors.js'

export const DSH_REMOTE_SERVICE_TYPE = '_dsh-remote._tcp'

export interface DiscoveryHint {
  readonly serviceType: typeof DSH_REMOTE_SERVICE_TYPE
  readonly hostDisplayLabel: string
  readonly protocolVersion: number
  readonly endpointUrl: string
  readonly hostFingerprint: string
}

export interface MdnsAdvertisementRecord {
  readonly name: string
  readonly type: typeof DSH_REMOTE_SERVICE_TYPE
  readonly host: string
  readonly port: number
  readonly txt: Record<string, string>
}

export interface MdnsAdvertiser {
  publish(record: MdnsAdvertisementRecord): Promise<void>
  unpublish(): Promise<void>
  destroy(): Promise<void>
  isPublished(): boolean
  getPublishedRecord(): MdnsAdvertisementRecord | undefined
}

const FORBIDDEN_SECRET_KEYS = Object.freeze([
  'token',
  'pairingtoken',
  'bootstraptoken',
  'sessionid',
  'session',
  'prompt',
  'secret',
  'secretkey',
  'privatekey',
  'privkey',
  'credential',
  'credentials',
  'password',
  'apikey',
  'auth',
  'authorization',
])

export function assertNoSecretsInDiscoveryHint(hint: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(hint)) {
    const lowerKey = key.toLowerCase()
    for (const forbidden of FORBIDDEN_SECRET_KEYS) {
      if (lowerKey === forbidden || lowerKey.includes(forbidden)) {
        throw new RemoteCryptoError(
          'HANDSHAKE_FAILED',
          `mDNS discovery hint must never broadcast sensitive secret field: '${key}'`,
        )
      }
    }

    if (typeof value === 'object' && value !== null) {
      assertNoSecretsInDiscoveryHint(value as Record<string, unknown>)
    }
  }
}

export function createDiscoveryHint(params: {
  hostDisplayLabel: string
  protocolVersion: number
  endpointUrl: string
  hostFingerprint: string
}): DiscoveryHint {
  const hint: DiscoveryHint = {
    serviceType: DSH_REMOTE_SERVICE_TYPE,
    hostDisplayLabel: params.hostDisplayLabel,
    protocolVersion: params.protocolVersion,
    endpointUrl: params.endpointUrl,
    hostFingerprint: params.hostFingerprint,
  }

  assertNoSecretsInDiscoveryHint(hint as unknown as Record<string, unknown>)
  return Object.freeze(hint)
}

export class InMemoryMdnsAdvertiser implements MdnsAdvertiser {
  private publishedRecord: MdnsAdvertisementRecord | undefined = undefined
  private isDestroyed = false

  async publish(record: MdnsAdvertisementRecord): Promise<void> {
    if (this.isDestroyed) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'cannot publish on destroyed mDNS advertiser')
    }

    // Strictly validate record for absence of any secret materials
    assertNoSecretsInDiscoveryHint(record as unknown as Record<string, unknown>)

    this.publishedRecord = Object.freeze({
      ...record,
      txt: Object.freeze({ ...record.txt }),
    })
  }

  async unpublish(): Promise<void> {
    this.publishedRecord = undefined
  }

  async destroy(): Promise<void> {
    this.publishedRecord = undefined
    this.isDestroyed = true
  }

  isPublished(): boolean {
    return this.publishedRecord !== undefined && !this.isDestroyed
  }

  getPublishedRecord(): MdnsAdvertisementRecord | undefined {
    return this.publishedRecord
  }
}
