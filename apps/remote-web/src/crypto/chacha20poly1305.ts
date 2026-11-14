import { concatBytes, constantTimeEqual } from './bytes.ts'

const CHACHA_CONSTANTS = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574])
const POLY1305_PRIME = (1n << 130n) - 5n
const POLY1305_R_MASK = 0x0ffffffc0ffffffc0ffffffc0fffffffn

function rotl32(v: number, n: number): number {
  return ((v << n) | (v >>> (32 - n))) >>> 0
}

function readLe32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  )
}

function writeLe32(out: Uint8Array, offset: number, val: number): void {
  out[offset] = val & 0xff
  out[offset + 1] = (val >>> 8) & 0xff
  out[offset + 2] = (val >>> 16) & 0xff
  out[offset + 3] = (val >>> 24) & 0xff
}

function quarterRound(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  s[a] = (s[a]! + s[b]!) >>> 0
  s[d] = rotl32(s[d]! ^ s[a]!, 16)
  s[c] = (s[c]! + s[d]!) >>> 0
  s[b] = rotl32(s[b]! ^ s[c]!, 12)
  s[a] = (s[a]! + s[b]!) >>> 0
  s[d] = rotl32(s[d]! ^ s[a]!, 8)
  s[c] = (s[c]! + s[d]!) >>> 0
  s[b] = rotl32(s[b]! ^ s[c]!, 7)
}

export function chacha20Block(key: Uint8Array, counter: number, nonce: Uint8Array): Uint8Array {
  if (key.byteLength !== 32) {
    throw new Error(`ChaCha20 key must be 32 bytes (got ${key.byteLength})`)
  }
  if (nonce.byteLength !== 12) {
    throw new Error(`ChaCha20 nonce must be 12 bytes (got ${nonce.byteLength})`)
  }

  const initial = new Uint32Array(16)
  initial[0] = CHACHA_CONSTANTS[0]!
  initial[1] = CHACHA_CONSTANTS[1]!
  initial[2] = CHACHA_CONSTANTS[2]!
  initial[3] = CHACHA_CONSTANTS[3]!
  for (let i = 0; i < 8; i += 1) {
    initial[4 + i] = readLe32(key, i * 4)
  }
  initial[12] = counter >>> 0
  initial[13] = readLe32(nonce, 0)
  initial[14] = readLe32(nonce, 4)
  initial[15] = readLe32(nonce, 8)

  const state = new Uint32Array(initial)
  for (let i = 0; i < 10; i += 1) {
    quarterRound(state, 0, 4, 8, 12)
    quarterRound(state, 1, 5, 9, 13)
    quarterRound(state, 2, 6, 10, 14)
    quarterRound(state, 3, 7, 11, 15)
    quarterRound(state, 0, 5, 10, 15)
    quarterRound(state, 1, 6, 11, 12)
    quarterRound(state, 2, 7, 8, 13)
    quarterRound(state, 3, 4, 9, 14)
  }

  const out = new Uint8Array(64)
  for (let i = 0; i < 16; i += 1) {
    writeLe32(out, i * 4, (state[i]! + initial[i]!) >>> 0)
  }
  initial.fill(0)
  state.fill(0)
  return out
}

export function chacha20Xor(
  key: Uint8Array,
  counter: number,
  nonce: Uint8Array,
  input: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(input.byteLength)
  let blockCounter = counter >>> 0
  let offset = 0

  while (offset < input.byteLength) {
    const keystream = chacha20Block(key, blockCounter, nonce)
    const take = Math.min(64, input.byteLength - offset)
    for (let i = 0; i < take; i += 1) {
      out[offset + i] = input[offset + i]! ^ keystream[i]!
    }
    keystream.fill(0)
    offset += take
    blockCounter = (blockCounter + 1) >>> 0
  }
  return out
}

function leBytesToBigInt(bytes: Uint8Array, start: number, len: number): bigint {
  let acc = 0n
  for (let i = len - 1; i >= 0; i -= 1) {
    acc = (acc << 8n) | BigInt(bytes[start + i]!)
  }
  return acc
}

export function poly1305Tag(oneTimeKey32: Uint8Array, msg: Uint8Array): Uint8Array {
  if (oneTimeKey32.byteLength !== 32) {
    throw new Error('Poly1305 key must be 32 bytes')
  }
  const r = leBytesToBigInt(oneTimeKey32, 0, 16) & POLY1305_R_MASK
  const s = leBytesToBigInt(oneTimeKey32, 16, 16)

  let acc = 0n
  for (let offset = 0; offset < msg.byteLength; offset += 16) {
    const chunkLen = Math.min(16, msg.byteLength - offset)
    const blockVal = leBytesToBigInt(msg, offset, chunkLen) | (1n << BigInt(chunkLen * 8))
    acc = ((acc + blockVal) * r) % POLY1305_PRIME
  }

  let final = acc + s
  const tag = new Uint8Array(16)
  for (let i = 0; i < 16; i += 1) {
    tag[i] = Number(final & 0xffn)
    final >>= 8n
  }
  return tag
}

function pad16ZeroLen(len: number): number {
  const rem = len % 16
  return rem === 0 ? 0 : 16 - rem
}

function writeLe64(out: Uint8Array, offset: number, val: number): void {
  const lo = val >>> 0
  const hi = Math.floor(val / 0x100000000) >>> 0
  writeLe32(out, offset, lo)
  writeLe32(out, offset + 4, hi)
}

function computePoly1305MacData(aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const aadPad = new Uint8Array(pad16ZeroLen(aad.byteLength))
  const ctPad = new Uint8Array(pad16ZeroLen(ciphertext.byteLength))
  const lengths = new Uint8Array(16)
  writeLe64(lengths, 0, aad.byteLength)
  writeLe64(lengths, 8, ciphertext.byteLength)
  return concatBytes(aad, aadPad, ciphertext, ctPad, lengths)
}

/**
 * Noise_IK_25519_ChaChaPoly_BLAKE2b nonce format matching `noise-handshake/cipher.js`:
 * 12 bytes with little-endian uint32 counter at bytes [4..7] and zero padding elsewhere.
 */
export function buildNoiseNonce(counter: number): Uint8Array {
  if (!Number.isSafeInteger(counter) || counter < 0 || counter > 0xffffffff) {
    throw new Error(`Invalid Noise nonce counter: ${counter}`)
  }
  const nonce = new Uint8Array(12)
  const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength)
  view.setUint32(4, counter, true)
  return nonce
}

export function chacha20Poly1305Encrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const polyKeyBlock = chacha20Block(key, 0, nonce)
  const otk = polyKeyBlock.subarray(0, 32)
  const ciphertext = chacha20Xor(key, 1, nonce, plaintext)
  const macData = computePoly1305MacData(aad, ciphertext)
  const tag = poly1305Tag(otk, macData)
  polyKeyBlock.fill(0)
  return concatBytes(ciphertext, tag)
}

export function chacha20Poly1305Decrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertextAndTag: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array {
  if (ciphertextAndTag.byteLength < 16) {
    throw new Error('ChaCha20-Poly1305 ciphertext truncated (< 16 bytes)')
  }
  const ctLen = ciphertextAndTag.byteLength - 16
  const ciphertext = ciphertextAndTag.subarray(0, ctLen)
  const receivedTag = ciphertextAndTag.subarray(ctLen)

  const polyKeyBlock = chacha20Block(key, 0, nonce)
  const otk = polyKeyBlock.subarray(0, 32)
  const macData = computePoly1305MacData(aad, ciphertext)
  const expectedTag = poly1305Tag(otk, macData)
  polyKeyBlock.fill(0)

  if (!constantTimeEqual(receivedTag, expectedTag)) {
    throw new Error('ChaCha20-Poly1305 authentication failed')
  }
  return chacha20Xor(key, 1, nonce, ciphertext)
}
