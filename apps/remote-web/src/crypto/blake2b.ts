import { concatBytes } from './bytes.ts'

// RFC 7693 BLAKE2b initialization vector (lo32, hi32 pairs for 8 uint64 words).
const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667,
  0x84caa73b, 0xbb67ae85,
  0xfe94f82b, 0x3c6ef372,
  0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f,
  0x2b3e6c1f, 0x9b05688c,
  0xfb41bd6b, 0x1f83d9ab,
  0x137e2179, 0x5be0cd19,
])

const SIGMA = new Uint8Array([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
  7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
  9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
  2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
  12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
  13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
  6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
  10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
])

function add64Three(
  v: Uint32Array,
  ai: number,
  bi: number,
  m: Uint32Array,
  mi: number,
): void {
  const sumLo = v[ai]! + v[bi]! + m[mi]!
  const carry = Math.floor(sumLo / 0x100000000)
  v[ai] = sumLo >>> 0
  v[ai + 1] = (v[ai + 1]! + v[bi + 1]! + m[mi + 1]! + carry) >>> 0
}

function xorRotr32(v: Uint32Array, di: number, si: number): void {
  const xLo = (v[di]! ^ v[si]!) >>> 0
  const xHi = (v[di + 1]! ^ v[si + 1]!) >>> 0
  v[di] = xHi
  v[di + 1] = xLo
}

function xorRotr24(v: Uint32Array, di: number, si: number): void {
  const xLo = (v[di]! ^ v[si]!) >>> 0
  const xHi = (v[di + 1]! ^ v[si + 1]!) >>> 0
  v[di] = ((xLo >>> 24) | (xHi << 8)) >>> 0
  v[di + 1] = ((xHi >>> 24) | (xLo << 8)) >>> 0
}

function xorRotr16(v: Uint32Array, di: number, si: number): void {
  const xLo = (v[di]! ^ v[si]!) >>> 0
  const xHi = (v[di + 1]! ^ v[si + 1]!) >>> 0
  v[di] = ((xLo >>> 16) | (xHi << 16)) >>> 0
  v[di + 1] = ((xHi >>> 16) | (xLo << 16)) >>> 0
}

function xorRotr63(v: Uint32Array, di: number, si: number): void {
  const xLo = (v[di]! ^ v[si]!) >>> 0
  const xHi = (v[di + 1]! ^ v[si + 1]!) >>> 0
  v[di] = ((xHi >>> 31) | (xLo << 1)) >>> 0
  v[di + 1] = ((xLo >>> 31) | (xHi << 1)) >>> 0
}

function mix(
  v: Uint32Array,
  m: Uint32Array,
  a: number,
  b: number,
  c: number,
  d: number,
  xi: number,
  yi: number,
): void {
  const ai = a * 2
  const bi = b * 2
  const ci = c * 2
  const di = d * 2
  add64Three(v, ai, bi, m, xi * 2)
  xorRotr32(v, di, ai)
  add64Three(v, ci, di, m, 32)
  xorRotr24(v, bi, ci)
  add64Three(v, ai, bi, m, yi * 2)
  xorRotr16(v, di, ai)
  add64Three(v, ci, di, m, 32)
  xorRotr63(v, bi, ci)
}

function compress(
  h: Uint32Array,
  block: Uint8Array,
  tLo: number,
  tHi: number,
  isLast: boolean,
): void {
  const v = new Uint32Array(32)
  const m = new Uint32Array(34) // words 0..15 + word 16 = 0 zero constant

  for (let i = 0; i < 16; i += 1) {
    v[i] = h[i]!
    v[i + 16] = IV[i]!
  }

  v[24] = (v[24]! ^ tLo) >>> 0
  v[25] = (v[25]! ^ tHi) >>> 0
  if (isLast) {
    v[28] = (~v[28]!) >>> 0
    v[29] = (~v[29]!) >>> 0
  }

  for (let i = 0; i < 32; i += 1) {
    const o = i * 4
    m[i] =
      (block[o]! |
        (block[o + 1]! << 8) |
        (block[o + 2]! << 16) |
        (block[o + 3]! << 24)) >>>
      0
  }

  for (let r = 0; r < 12; r += 1) {
    const s = r * 16
    mix(v, m, 0, 4, 8, 12, SIGMA[s]!, SIGMA[s + 1]!)
    mix(v, m, 1, 5, 9, 13, SIGMA[s + 2]!, SIGMA[s + 3]!)
    mix(v, m, 2, 6, 10, 14, SIGMA[s + 4]!, SIGMA[s + 5]!)
    mix(v, m, 3, 7, 11, 15, SIGMA[s + 6]!, SIGMA[s + 7]!)
    mix(v, m, 0, 5, 10, 15, SIGMA[s + 8]!, SIGMA[s + 9]!)
    mix(v, m, 1, 6, 11, 12, SIGMA[s + 10]!, SIGMA[s + 11]!)
    mix(v, m, 2, 7, 8, 13, SIGMA[s + 12]!, SIGMA[s + 13]!)
    mix(v, m, 3, 4, 9, 14, SIGMA[s + 14]!, SIGMA[s + 15]!)
  }

  for (let i = 0; i < 16; i += 1) {
    h[i] = (h[i]! ^ v[i]! ^ v[i + 16]!) >>> 0
  }

  v.fill(0)
  m.fill(0)
}

export function blake2b64(data: Uint8Array): Uint8Array {
  const h = new Uint32Array(IV)
  // Parameter block: digest_length = 64, key_length = 0, fanout = 1, depth = 1 -> 0x01010040
  h[0] = (h[0]! ^ 0x01010040) >>> 0

  const block = new Uint8Array(128)
  let tLo = 0
  let tHi = 0
  let offset = 0

  while (data.byteLength - offset > 128) {
    block.set(data.subarray(offset, offset + 128))
    offset += 128
    const nextLo = tLo + 128
    if (nextLo >= 0x100000000) {
      tLo = (nextLo - 0x100000000) >>> 0
      tHi = (tHi + 1) >>> 0
    } else {
      tLo = nextLo >>> 0
    }
    compress(h, block, tLo, tHi, false)
  }

  const remaining = data.byteLength - offset
  block.fill(0)
  if (remaining > 0) {
    block.set(data.subarray(offset), 0)
  }
  const nextLo = tLo + remaining
  if (nextLo >= 0x100000000) {
    tLo = (nextLo - 0x100000000) >>> 0
    tHi = (tHi + 1) >>> 0
  } else {
    tLo = nextLo >>> 0
  }
  compress(h, block, tLo, tHi, true)
  block.fill(0)

  const out = new Uint8Array(64)
  for (let i = 0; i < 16; i += 1) {
    const word = h[i]!
    const o = i * 4
    out[o] = word & 0xff
    out[o + 1] = (word >>> 8) & 0xff
    out[o + 2] = (word >>> 16) & 0xff
    out[o + 3] = (word >>> 24) & 0xff
  }
  h.fill(0)
  return out
}

const HMAC_BLOCK_BYTES = 128
const HMAC_HASH_BYTES = 64

export function hmacBlake2b(key: Uint8Array, ...chunks: readonly Uint8Array[]): Uint8Array {
  const normalizedKey = key.byteLength > HMAC_BLOCK_BYTES ? blake2b64(key) : key
  const ipad = new Uint8Array(HMAC_BLOCK_BYTES)
  const opad = new Uint8Array(HMAC_BLOCK_BYTES)
  for (let i = 0; i < HMAC_BLOCK_BYTES; i += 1) {
    const k = i < normalizedKey.byteLength ? normalizedKey[i]! : 0
    ipad[i] = k ^ 0x36
    opad[i] = k ^ 0x5c
  }
  const inner = blake2b64(concatBytes(ipad, ...chunks))
  const mac = blake2b64(concatBytes(opad, inner))
  ipad.fill(0)
  opad.fill(0)
  inner.fill(0)
  if (normalizedKey !== key) {
    normalizedKey.fill(0)
  }
  return mac
}

/**
 * Exact match to `noise-handshake/hkdf.js` for Noise_IK_25519_ChaChaPoly_BLAKE2b.
 */
export function hkdfBlake2b(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  outputLength: number,
): Uint8Array {
  const prk = hmacBlake2b(salt, ikm)
  const out = new Uint8Array(outputLength)
  const blocks = Math.ceil(outputLength / HMAC_HASH_BYTES)
  let prev = info
  const counter = new Uint8Array(1)

  for (let i = 0; i < blocks; i += 1) {
    counter[0] = i + 1
    const digest = hmacBlake2b(prk, prev, info, counter)
    const start = i * HMAC_HASH_BYTES
    const copyLen = Math.min(HMAC_HASH_BYTES, outputLength - start)
    out.set(digest.subarray(0, copyLen), start)
    if (prev !== info) {
      prev.fill(0)
    }
    prev = digest
  }

  if (prev !== info) {
    prev.fill(0)
  }
  prk.fill(0)
  return out
}
