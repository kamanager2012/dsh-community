import { randomBytes } from './bytes.ts'

export interface X25519KeyPair {
  readonly publicKey: Uint8Array
  readonly secretKey: Uint8Array
}

// RFC 7748 X25519 base point (u = 9)
const BASE_POINT_U = new Uint8Array(32)
BASE_POINT_U[0] = 9

const D2 = new Float64Array(16)
D2[0] = 0xdb41
D2[1] = 1

function gf(): Float64Array {
  return new Float64Array(16)
}

function set25519(r: Float64Array, a: Float64Array): void {
  for (let i = 0; i < 16; i += 1) {
    r[i] = a[i]!
  }
}

function car25519(o: Float64Array): void {
  for (let i = 0; i < 16; i += 1) {
    o[i]! += 65536
    const c = Math.floor(o[i]! / 65536)
    o[(i + 1) * (i < 15 ? 1 : 0)]! += c - 1 + 37 * (c - 1) * (i === 15 ? 1 : 0)
    o[i]! -= c * 65536
  }
}

function sel25519(p: Float64Array, q: Float64Array, b: number): void {
  const c = ~(b - 1)
  for (let i = 0; i < 16; i += 1) {
    const t = c & ((p[i]! | 0) ^ (q[i]! | 0))
    p[i] = (p[i]! | 0) ^ t
    q[i] = (q[i]! | 0) ^ t
  }
}

function pack25519(o: Uint8Array, n: Float64Array): void {
  const m = gf()
  const t = gf()
  for (let i = 0; i < 16; i += 1) {
    t[i] = n[i]!
  }
  car25519(t)
  car25519(t)
  car25519(t)
  for (let j = 0; j < 2; j += 1) {
    m[0] = t[0]! - 0xffed
    for (let i = 1; i < 15; i += 1) {
      m[i] = t[i]! - 0xffff - ((m[i - 1]! >> 16) & 1)
      m[i - 1]! &= 0xffff
    }
    m[15] = t[15]! - 0x7fff - ((m[14]! >> 16) & 1)
    const b = (m[15]! >> 16) & 1
    m[14]! &= 0xffff
    sel25519(t, m, 1 - b)
  }
  for (let i = 0; i < 16; i += 1) {
    o[2 * i] = t[i]! & 0xff
    o[2 * i + 1] = t[i]! >> 8
  }
}

function unpack25519(o: Float64Array, n: Uint8Array): void {
  for (let i = 0; i < 16; i += 1) {
    o[i] = n[2 * i]! + (n[2 * i + 1]! << 8)
  }
  // RFC 7748 section 5: clear bit 255
  o[15]! &= 0x7fff
}

function A(o: Float64Array, a: Float64Array, b: Float64Array): void {
  for (let i = 0; i < 16; i += 1) {
    o[i] = a[i]! + b[i]!
  }
}

function Z(o: Float64Array, a: Float64Array, b: Float64Array): void {
  for (let i = 0; i < 16; i += 1) {
    o[i] = a[i]! - b[i]!
  }
}

function M(o: Float64Array, a: Float64Array, b: Float64Array): void {
  const t = new Float64Array(31)
  for (let i = 0; i < 16; i += 1) {
    for (let j = 0; j < 16; j += 1) {
      t[i + j]! += a[i]! * b[j]!
    }
  }
  for (let i = 0; i < 15; i += 1) {
    t[i]! += 38 * t[i + 16]!
  }
  for (let i = 0; i < 16; i += 1) {
    o[i] = t[i]!
  }
  car25519(o)
  car25519(o)
}

function S(o: Float64Array, a: Float64Array): void {
  M(o, a, a)
}

function inv25519(o: Float64Array, i: Float64Array): void {
  const c = gf()
  for (let a = 0; a < 16; a += 1) {
    c[a] = i[a]!
  }
  for (let a = 253; a >= 0; a -= 1) {
    S(c, c)
    if (a !== 2 && a !== 4) {
      M(c, c, i)
    }
  }
  for (let a = 0; a < 16; a += 1) {
    o[a] = c[a]!
  }
}

export function clampX25519Scalar(secretKey: Uint8Array): Uint8Array {
  if (secretKey.byteLength !== 32) {
    throw new Error(`X25519 secret key must be 32 bytes (got ${secretKey.byteLength})`)
  }
  const z = new Uint8Array(secretKey)
  z[0] = z[0]! & 248
  z[31] = (z[31]! & 127) | 64
  return z
}

export function x25519ScalarMult(secretKey: Uint8Array, point: Uint8Array): Uint8Array {
  if (secretKey.byteLength !== 32) {
    throw new Error(`X25519 secret key must be 32 bytes (got ${secretKey.byteLength})`)
  }
  if (point.byteLength !== 32) {
    throw new Error(`X25519 public key must be 32 bytes (got ${point.byteLength})`)
  }

  const z = clampX25519Scalar(secretKey)
  const x = new Float64Array(80)
  const a = gf()
  const b = gf()
  const c = gf()
  const d = gf()
  const e = gf()
  const f = gf()

  unpack25519(x, point)
  for (let i = 0; i < 16; i += 1) {
    b[i] = x[i]!
    d[i] = 0
    a[i] = 0
    c[i] = 0
  }
  a[0] = 1
  d[0] = 1

  for (let i = 254; i >= 0; --i) {
    const r = (z[i >>> 3]! >>> (i & 7)) & 1
    sel25519(a, b, r)
    sel25519(c, d, r)
    A(e, a, c)
    Z(a, a, c)
    A(c, b, d)
    Z(b, b, d)
    S(d, e)
    S(f, a)
    M(a, c, a)
    M(c, b, e)
    A(e, a, c)
    Z(a, a, c)
    S(b, a)
    Z(c, d, f)
    M(a, c, D2)
    A(a, a, d)
    M(c, c, a)
    M(a, d, f)
    M(d, b, x)
    S(b, e)
    sel25519(a, b, r)
    sel25519(c, d, r)
  }

  for (let i = 0; i < 16; i += 1) {
    x[i + 16] = a[i]!
    x[i + 32] = c[i]!
    x[i + 48] = b[i]!
    x[i + 64] = d[i]!
  }

  inv25519(x.subarray(32, 48), x.subarray(32, 48))
  M(x.subarray(16, 32), x.subarray(16, 32), x.subarray(32, 48))

  const out = new Uint8Array(32)
  pack25519(out, x.subarray(16, 32))
  z.fill(0)
  return out
}

export function x25519ScalarMultBase(secretKey: Uint8Array): Uint8Array {
  return x25519ScalarMult(secretKey, BASE_POINT_U)
}

export function x25519SharedSecret(secretKey: Uint8Array, remotePublicKey: Uint8Array): Uint8Array {
  const shared = x25519ScalarMult(secretKey, remotePublicKey)
  let nonZero = 0
  for (let i = 0; i < 32; i += 1) {
    nonZero |= shared[i]!
  }
  if (nonZero === 0) {
    shared.fill(0)
    throw new Error('X25519 rejected low-order or invalid peer public key')
  }
  return shared
}

export function generateX25519KeyPair(): X25519KeyPair {
  const secretKey = clampX25519Scalar(randomBytes(32))
  const publicKey = x25519ScalarMultBase(secretKey)
  return { publicKey, secretKey }
}
