import { RemoteCryptoError } from '../crypto/errors.js'
import { computeFingerprint } from '../crypto/host-identity.js'

export interface PairingBootstrapDescriptor {
  readonly protocolVersion: number
  readonly hostPublicKeyHex: string
  readonly hostFingerprint: string
  readonly bootstrapToken: string
  readonly endpointUrl: string
  readonly expiresAt: number
}

const FORBIDDEN_QR_FIELDS = Object.freeze([
  'session',
  'sessionid',
  'prompt',
  'credential',
  'credentials',
  'secret',
  'secretkey',
  'privatekey',
  'password',
  'tokensecret',
])

export function assertNoSessionOrCredentialsInDescriptor(data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    const lower = key.toLowerCase()
    for (const forbidden of FORBIDDEN_QR_FIELDS) {
      if (lower === forbidden || lower.includes(forbidden)) {
        throw new RemoteCryptoError(
          'HANDSHAKE_FAILED',
          `pairing bootstrap descriptor must never contain session or credential field: '${key}'`,
        )
      }
    }
    if (typeof value === 'object' && value !== null) {
      assertNoSessionOrCredentialsInDescriptor(value as Record<string, unknown>)
    }
  }
}

export function createPairingBootstrapDescriptor(params: {
  protocolVersion: number
  hostPublicKey: Uint8Array
  bootstrapToken: string
  endpointUrl: string
  expiresAt: number
}): PairingBootstrapDescriptor {
  if (params.hostPublicKey.byteLength !== 32) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'host public key must be 32 bytes')
  }

  const hostPublicKeyHex = Buffer.from(params.hostPublicKey).toString('hex')
  const hostFingerprint = computeFingerprint(params.hostPublicKey)

  const descriptor: PairingBootstrapDescriptor = {
    protocolVersion: params.protocolVersion,
    hostPublicKeyHex,
    hostFingerprint,
    bootstrapToken: params.bootstrapToken,
    endpointUrl: params.endpointUrl,
    expiresAt: params.expiresAt,
  }

  assertNoSessionOrCredentialsInDescriptor(descriptor as unknown as Record<string, unknown>)
  return Object.freeze(descriptor)
}

export function parsePairingBootstrapDescriptor(raw: string): PairingBootstrapDescriptor {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new RemoteCryptoError(
      'HANDSHAKE_FAILED',
      `invalid pairing bootstrap descriptor JSON: ${(err as Error).message}`,
    )
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'descriptor must be an object')
  }

  const obj = parsed as Record<string, unknown>
  assertNoSessionOrCredentialsInDescriptor(obj)

  const { protocolVersion, hostPublicKeyHex, hostFingerprint, bootstrapToken, endpointUrl, expiresAt } = obj

  if (typeof protocolVersion !== 'number' || protocolVersion < 1) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid protocolVersion in descriptor')
  }

  if (typeof hostPublicKeyHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hostPublicKeyHex)) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid hostPublicKeyHex in descriptor')
  }

  if (typeof hostFingerprint !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hostFingerprint)) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid hostFingerprint in descriptor')
  }

  const computedFingerprint = computeFingerprint(new Uint8Array(Buffer.from(hostPublicKeyHex, 'hex')))
  if (computedFingerprint !== hostFingerprint) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'hostFingerprint does not match hostPublicKeyHex')
  }

  if (typeof bootstrapToken !== 'string' || bootstrapToken.length === 0) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid bootstrapToken in descriptor')
  }

  if (typeof endpointUrl !== 'string' || (!endpointUrl.startsWith('ws://') && !endpointUrl.startsWith('wss://'))) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid endpointUrl in descriptor')
  }

  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid expiresAt in descriptor')
  }

  return Object.freeze({
    protocolVersion,
    hostPublicKeyHex,
    hostFingerprint,
    bootstrapToken,
    endpointUrl,
    expiresAt,
  })
}
