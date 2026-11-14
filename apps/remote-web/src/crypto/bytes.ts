const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function utf8Encode(text: string): Uint8Array {
  return textEncoder.encode(text)
}

export function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes)
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) {
    total += part.byteLength
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false
  }
  let diff = 0
  for (let i = 0; i < a.byteLength; i += 1) {
    diff |= a[i]! ^ b[i]!
  }
  return diff === 0
}

export function zeroize(...buffers: readonly (Uint8Array | undefined)[]): void {
  for (const buf of buffers) {
    if (buf) {
      buf.fill(0)
    }
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.byteLength; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, '0')
  }
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Invalid hex string')
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.byteLength; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function base64Encode(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  const chunks: string[] = []
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(bytes.byteLength, i + chunkSize))
    chunks.push(String.fromCharCode(...slice))
  }
  return btoa(chunks.join(''))
}

export function base64Decode(raw: string): Uint8Array {
  const binary = atob(raw.replace(/\s+/g, ''))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

export function base64UrlDecode(raw: string): Uint8Array {
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (normalized.length % 4)) % 4
  return base64Decode(normalized + '='.repeat(padLen))
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer)
  return new Uint8Array(digest)
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return bytesToHex(await sha256(data))
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length)
  globalThis.crypto.getRandomValues(out)
  return out
}

export function randomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  const bytes = randomBytes(16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytesToHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
