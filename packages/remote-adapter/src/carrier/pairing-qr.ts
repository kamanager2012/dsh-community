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
  readonly relayUrl?: string | undefined
  readonly relayRoomId?: string | undefined
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
  relayUrl?: string | undefined
  relayRoomId?: string | undefined
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
    relayUrl?: string
    relayRoomId?: string
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
  if (params.relayUrl !== undefined) {
    if (!params.relayUrl.startsWith('ws://') && !params.relayUrl.startsWith('wss://')) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid relayUrl in descriptor')
    }
    descriptor.relayUrl = params.relayUrl
  }
  if (params.relayRoomId !== undefined) {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(params.relayRoomId)) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid relayRoomId in descriptor')
    }
    descriptor.relayRoomId = params.relayRoomId
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
    relayUrl?: string
    relayRoomId?: string
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

  if (obj.relayUrl !== undefined) {
    if (
      typeof obj.relayUrl !== 'string' ||
      (!obj.relayUrl.startsWith('ws://') && !obj.relayUrl.startsWith('wss://'))
    ) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid relayUrl in descriptor')
    }
    result.relayUrl = obj.relayUrl
  }

  if (obj.relayRoomId !== undefined) {
    if (typeof obj.relayRoomId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(obj.relayRoomId)) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid relayRoomId in descriptor')
    }
    result.relayRoomId = obj.relayRoomId
  }

  return Object.freeze(result)
}

export const DSH_REMOTE_DEEP_LINK_PREFIX = 'dsh-remote://pair'

/**
 * Encodes a PairingBootstrapDescriptor into a sanitized `dsh-remote://pair?data=<base64url>`
 * deep-link URI without session or credential material.
 */
export function encodePairingDeepLink(descriptor: PairingBootstrapDescriptor): string {
  assertNoSessionOrCredentialsInDescriptor(descriptor as unknown as Record<string, unknown>)
  const encoded = Buffer.from(JSON.stringify(descriptor), 'utf8').toString('base64url')
  return `${DSH_REMOTE_DEEP_LINK_PREFIX}?data=${encoded}`
}

/**
 * Parses either raw QR descriptor JSON or a `dsh-remote://pair?...` deep-link URI.
 */
export function parsePairingInput(raw: string): PairingBootstrapDescriptor {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'empty pairing input')
  }
  if (trimmed.startsWith('dsh-remote://')) {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(trimmed)
    } catch (err) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        `invalid dsh-remote pairing URI: ${(err as Error).message}`,
      )
    }
    if (parsedUrl.hostname !== 'pair' && parsedUrl.pathname !== '/pair') {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'unsupported dsh-remote action')
    }
    const base64Data = parsedUrl.searchParams.get('data')
    if (base64Data !== null && base64Data.length > 0) {
      const jsonText = Buffer.from(base64Data, 'base64url').toString('utf8')
      return parsePairingBootstrapDescriptor(jsonText)
    }
    const descriptorParam = parsedUrl.searchParams.get('descriptor')
    if (descriptorParam !== null && descriptorParam.length > 0) {
      return parsePairingBootstrapDescriptor(descriptorParam)
    }
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'missing data parameter in dsh-remote pairing URI')
  }
  return parsePairingBootstrapDescriptor(trimmed)
}
