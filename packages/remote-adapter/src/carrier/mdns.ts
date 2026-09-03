import { RemoteCryptoError } from '../crypto/errors.js'

export const DSH_REMOTE_SERVICE_TYPE = '_dsh-remote._tcp'

export interface DiscoveryHint {
  readonly serviceType: typeof DSH_REMOTE_SERVICE_TYPE
  readonly hostDisplayLabel: string
  readonly protocolVersion: number
  readonly endpointUrl: string
  readonly hostFingerprint: string
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
