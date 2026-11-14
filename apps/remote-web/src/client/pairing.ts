import { base64UrlDecode, hexToBytes, sha256Hex, utf8Decode } from '../crypto/bytes.ts'
import type { PairingBootstrapDescriptor, TrustedHostProfile } from './types.ts'

export const FORBIDDEN_QR_FIELDS = [
  'sessionId',
  'sessionToken',
  'secretKey',
  'privateKey',
  'clientSecretKey',
  'password',
  'apiKey',
  'oauthToken',
] as const

export class PairingParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PairingParseError'
  }
}

export function sanitizeDiagnosticMessage(input: string): string {
  return input
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '[redacted-hex]')
    .replace(/([?&](?:token|pair|data|bootstrapToken)=)[^&\s#]+/gi, '$1[redacted]')
}

function validateWsUrl(raw: unknown, fieldName: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new PairingParseError(`Invalid ${fieldName}: expected non-empty ws:// or wss:// URL`)
  }
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new PairingParseError(`Invalid ${fieldName}: malformed URL`)
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new PairingParseError(`Invalid ${fieldName}: only ws:// and wss:// are allowed`)
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new PairingParseError(`Invalid ${fieldName}: host required and embedded credentials forbidden`)
  }
  return parsed.toString()
}

export function validateStunOnlyUrls(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!Array.isArray(raw)) {
    throw new PairingParseError('Invalid stunUrls: expected an array of stun: URLs')
  }
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || !/^stun:[^\s]+$/i.test(item.trim())) {
      throw new PairingParseError(
        `Rejected ICE server URL "${String(item)}": only self-owned stun: URLs are permitted (no turn:/turns:)`,
      )
    }
    out.push(item.trim())
  }
  return Object.freeze(out)
}

function assertNoForbiddenFields(obj: Record<string, unknown>): void {
  for (const field of FORBIDDEN_QR_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(obj, field)) {
      throw new PairingParseError(`Forbidden field "${field}" in pairing descriptor`)
    }
  }
}

export async function parsePairingDescriptorObject(
  obj: Record<string, unknown>,
  options?: { readonly nowMs?: number | undefined; readonly allowExpired?: boolean | undefined },
): Promise<PairingBootstrapDescriptor> {
  assertNoForbiddenFields(obj)

  const { protocolVersion, hostPublicKeyHex, hostFingerprint, bootstrapToken, endpointUrl, expiresAt } = obj
  if (typeof protocolVersion !== 'number' || !Number.isInteger(protocolVersion) || protocolVersion < 1) {
    throw new PairingParseError('Invalid protocolVersion in pairing descriptor')
  }
  if (typeof hostPublicKeyHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hostPublicKeyHex)) {
    throw new PairingParseError('Invalid hostPublicKeyHex in pairing descriptor')
  }
  if (typeof hostFingerprint !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hostFingerprint)) {
    throw new PairingParseError('Invalid hostFingerprint in pairing descriptor')
  }

  const normalizedPubHex = hostPublicKeyHex.toLowerCase()
  const normalizedFpHex = hostFingerprint.toLowerCase()
  const computedFingerprint = await sha256Hex(hexToBytes(normalizedPubHex))
  if (computedFingerprint !== normalizedFpHex) {
    throw new PairingParseError('hostFingerprint does not match hostPublicKeyHex SHA-256')
  }

  if (typeof bootstrapToken !== 'string' || bootstrapToken.trim().length === 0) {
    throw new PairingParseError('Invalid bootstrapToken in pairing descriptor')
  }

  const validEndpointUrl = validateWsUrl(endpointUrl, 'endpointUrl')

  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new PairingParseError('Invalid expiresAt in pairing descriptor')
  }
  const now = options?.nowMs ?? Date.now()
  if (options?.allowExpired !== true && expiresAt <= now) {
    throw new PairingParseError('Pairing token has already expired; generate a fresh pairing link or QR code on the host')
  }

  const signalingUrl = obj.signalingUrl !== undefined ? validateWsUrl(obj.signalingUrl, 'signalingUrl') : undefined
  const relayUrl = obj.relayUrl !== undefined ? validateWsUrl(obj.relayUrl, 'relayUrl') : undefined
  const stunUrls = validateStunOnlyUrls(obj.stunUrls)

  let signalingRoomId: string | undefined
  if (obj.signalingRoomId !== undefined) {
    if (typeof obj.signalingRoomId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(obj.signalingRoomId)) {
      throw new PairingParseError('Invalid signalingRoomId in pairing descriptor')
    }
    signalingRoomId = obj.signalingRoomId
  }

  let relayRoomId: string | undefined
  if (obj.relayRoomId !== undefined) {
    if (typeof obj.relayRoomId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(obj.relayRoomId)) {
      throw new PairingParseError('Invalid relayRoomId in pairing descriptor')
    }
    relayRoomId = obj.relayRoomId
  }

  return Object.freeze({
    protocolVersion,
    hostPublicKeyHex: normalizedPubHex,
    hostFingerprint: normalizedFpHex,
    bootstrapToken: bootstrapToken.trim(),
    endpointUrl: validEndpointUrl,
    expiresAt,
    ...(signalingUrl !== undefined ? { signalingUrl } : {}),
    ...(signalingRoomId !== undefined ? { signalingRoomId } : {}),
    ...(stunUrls !== undefined ? { stunUrls } : {}),
    ...(relayUrl !== undefined ? { relayUrl } : {}),
    ...(relayRoomId !== undefined ? { relayRoomId } : {}),
  })
}

function decodeBase64UrlJson(encoded: string): Record<string, unknown> {
  const bytes = base64UrlDecode(encoded)
  const text = utf8Decode(bytes)
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PairingParseError('Pairing descriptor payload must decode to a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Parses:
 * 1. `dsh-remote://pair?data=<base64url>` or `?descriptor=<json>`
 * 2. Companion Web URLs containing `#pair=<base64url|dsh-remote://...>`
 * 3. Direct base64url `#pair=` payload or raw JSON bootstrap descriptor
 */
export async function parsePairingInput(
  raw: string,
  options?: { readonly nowMs?: number | undefined; readonly allowExpired?: boolean | undefined },
): Promise<PairingBootstrapDescriptor> {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new PairingParseError('Empty pairing input')
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      throw new PairingParseError('Invalid pairing web URL')
    }
    const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
    const hashParams = new URLSearchParams(hash)
    const pairParam = hashParams.get('pair')
    if (!pairParam) {
      throw new PairingParseError('Missing #pair= fragment in web URL')
    }
    return parsePairingInput(pairParam, options)
  }

  if (trimmed.startsWith('pair=')) {
    const extracted = new URLSearchParams(trimmed).get('pair') ?? trimmed.slice(5)
    return parsePairingInput(extracted, options)
  }

  if (trimmed.startsWith('dsh-remote://')) {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(trimmed)
    } catch (err) {
      throw new PairingParseError(`Invalid dsh-remote URI: ${(err as Error).message}`)
    }
    if (parsedUrl.hostname !== 'pair' && parsedUrl.pathname !== '/pair') {
      throw new PairingParseError('Unsupported dsh-remote URI action')
    }
    const base64Data = parsedUrl.searchParams.get('data')
    if (base64Data && base64Data.length > 0) {
      return parsePairingDescriptorObject(decodeBase64UrlJson(base64Data), options)
    }
    const rawDesc = parsedUrl.searchParams.get('descriptor')
    if (rawDesc && rawDesc.length > 0) {
      const parsed = JSON.parse(rawDesc) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new PairingParseError('descriptor parameter must be a JSON object')
      }
      return parsePairingDescriptorObject(parsed as Record<string, unknown>, options)
    }
    throw new PairingParseError('Missing data or descriptor parameter in dsh-remote URI')
  }

  if (trimmed.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (err) {
      throw new PairingParseError(`Invalid pairing descriptor JSON: ${(err as Error).message}`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new PairingParseError('Pairing descriptor must be a JSON object')
    }
    return parsePairingDescriptorObject(parsed as Record<string, unknown>, options)
  }

  // Also accept raw base64url encoded JSON descriptor (used directly inside `#pair=<base64url>`)
  return parsePairingDescriptorObject(decodeBase64UrlJson(trimmed), options)
}

/**
 * Extracts `#pair=...` payload from `window.location.hash` and immediately scrubs
 * the fragment from browser history via `history.replaceState` so tokens never remain visible.
 */
export function consumePairFragmentFromLocation(loc: {
  readonly location: Location
  readonly history: History
}): string | undefined {
  const hash = loc.location.hash
  if (!hash || !hash.includes('pair=')) {
    return undefined
  }
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const payload = params.get('pair')?.trim()
  params.delete('pair')
  const remaining = params.toString()
  const cleanUrl = `${loc.location.pathname}${loc.location.search}${remaining ? `#${remaining}` : ''}`
  try {
    loc.history.replaceState(null, '', cleanUrl)
  } catch {
    // Ignore read-only history restrictions in constrained contexts
  }
  return payload && payload.length > 0 ? payload : undefined
}

export function descriptorToTrustedProfile(
  descriptor: PairingBootstrapDescriptor,
  existing?: TrustedHostProfile,
  labelOverride?: string,
): TrustedHostProfile {
  const now = Date.now()
  let fallbackLabel = `Host ${descriptor.hostFingerprint.slice(0, 8)}`
  try {
    const parsed = new URL(descriptor.endpointUrl)
    if (parsed.hostname) {
      fallbackLabel = parsed.hostname
    }
  } catch {}
  return {
    hostFingerprint: descriptor.hostFingerprint,
    hostPublicKeyHex: descriptor.hostPublicKeyHex,
    label: labelOverride?.trim() || existing?.label || fallbackLabel,
    endpointUrl: descriptor.endpointUrl,
    ...(descriptor.relayUrl !== undefined ? { relayUrl: descriptor.relayUrl } : {}),
    ...(descriptor.relayRoomId !== undefined ? { relayRoomId: descriptor.relayRoomId } : {}),
    ...(descriptor.signalingUrl !== undefined ? { signalingUrl: descriptor.signalingUrl } : {}),
    ...(descriptor.signalingRoomId !== undefined ? { signalingRoomId: descriptor.signalingRoomId } : {}),
    ...(descriptor.stunUrls !== undefined ? { stunUrls: descriptor.stunUrls } : {}),
    lastEpoch: existing?.lastEpoch ?? 0,
    pairedAt: existing?.pairedAt ?? now,
    lastConnectedAt: now,
    ...(existing?.preferredTransport !== undefined ? { preferredTransport: existing.preferredTransport } : {}),
  }
}
