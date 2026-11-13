import { RemoteCryptoError } from '../crypto/errors.js'
import { computeFingerprint } from '../crypto/host-identity.js'

export interface PairingBootstrapDescriptor {
  readonly protocolVersion: number
  readonly hostPublicKeyHex: string
  readonly hostFingerprint: string
  readonly bootstrapToken: string
  readonly endpointUrl: string
  readonly expiresAt: number
  readonly signalingUrl?: string | undefined
  readonly signalingRoomId?: string | undefined
  readonly stunUrls?: readonly string[] | undefined
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
  signalingUrl?: string | undefined
  signalingRoomId?: string | undefined
  stunUrls?: readonly string[] | undefined
}): PairingBootstrapDescriptor {
  if (params.hostPublicKey.byteLength !== 32) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'host public key must be 32 bytes')
  }

  const hostPublicKeyHex = Buffer.from(params.hostPublicKey).toString('hex')
  const hostFingerprint = computeFingerprint(params.hostPublicKey)

  const descriptor: {
    protocolVersion: number
    hostPublicKeyHex: string
    hostFingerprint: string
    bootstrapToken: string
    endpointUrl: string
    expiresAt: number
    signalingUrl?: string
    signalingRoomId?: string
    stunUrls?: readonly string[]
  } = {
    protocolVersion: params.protocolVersion,
    hostPublicKeyHex,
    hostFingerprint,
    bootstrapToken: params.bootstrapToken,
    endpointUrl: params.endpointUrl,
    expiresAt: params.expiresAt,
  }

  if (params.signalingUrl !== undefined) {
    if (!params.signalingUrl.startsWith('ws://') && !params.signalingUrl.startsWith('wss://')) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid signalingUrl in descriptor')
    }
    descriptor.signalingUrl = params.signalingUrl
  }
  if (params.signalingRoomId !== undefined) {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(params.signalingRoomId)) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid signalingRoomId in descriptor')
    }
    descriptor.signalingRoomId = params.signalingRoomId
  }
  if (params.stunUrls !== undefined) {
    if (
      !Array.isArray(params.stunUrls) ||
      params.stunUrls.some((u) => typeof u !== 'string' || !/^stun:[^\s]+$/i.test(u))
    ) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid stunUrls in descriptor')
    }
    descriptor.stunUrls = Object.freeze([...params.stunUrls])
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

  const result: {
    protocolVersion: number
    hostPublicKeyHex: string
    hostFingerprint: string
    bootstrapToken: string
    endpointUrl: string
    expiresAt: number
    signalingUrl?: string
    signalingRoomId?: string
    stunUrls?: readonly string[]
  } = {
    protocolVersion,
    hostPublicKeyHex,
    hostFingerprint,
    bootstrapToken,
    endpointUrl,
    expiresAt,
  }

  if (obj.signalingUrl !== undefined) {
    if (
      typeof obj.signalingUrl !== 'string' ||
      (!obj.signalingUrl.startsWith('ws://') && !obj.signalingUrl.startsWith('wss://'))
    ) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid signalingUrl in descriptor')
    }
    result.signalingUrl = obj.signalingUrl
  }

  if (obj.signalingRoomId !== undefined) {
    if (typeof obj.signalingRoomId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(obj.signalingRoomId)) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid signalingRoomId in descriptor')
    }
    result.signalingRoomId = obj.signalingRoomId
  }

  if (obj.stunUrls !== undefined) {
    if (
      !Array.isArray(obj.stunUrls) ||
      obj.stunUrls.some((u) => typeof u !== 'string' || !/^stun:[^\s]+$/i.test(u))
    ) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid stunUrls in descriptor')
    }
    result.stunUrls = Object.freeze([...obj.stunUrls])
  }

  return Object.freeze(result)
}
