package org.dsh.community.android.crypto

import java.security.SecureRandom
import java.util.Arrays

/**
 * Pure Kotlin constant-time RFC 7748 X25519 key exchange (TweetNaCl GF(2^255-19) limbs).
 */
object Curve25519 {
    const val KEY_BYTES = 32

    private val BASEPOINT = ByteArray(KEY_BYTES).apply { this[0] = 9 }
    private val _121665 = LongArray(16).apply {
        this[0] = 0xDB41L
        this[1] = 1L
    }

    data class KeyPair(
        val publicKey: ByteArray,
        val secretKey: ByteArray,
    ) {
        fun zeroize() {
            Arrays.fill(secretKey, 0.toByte())
        }

        override fun toString(): String =
            "KeyPair(publicKey=${CryptoUtils.toHex(publicKey)}, secretKey=[REDACTED])"
    }

    fun generateKeyPair(random: SecureRandom = SecureRandom()): KeyPair {
        val secret = ByteArray(KEY_BYTES)
        random.nextBytes(secret)
        clampScalar(secret)
        val pub = scalarMultBase(secret)
        return KeyPair(publicKey = pub, secretKey = secret)
    }

    fun keyPairFromSecret(secretKey: ByteArray): KeyPair {
        require(secretKey.size == KEY_BYTES) { "X25519 secret key must be 32 bytes" }
        val secret = secretKey.copyOf()
        val pub = scalarMultBase(secret)
        return KeyPair(publicKey = pub, secretKey = secret)
    }

    fun scalarMultBase(secretKey: ByteArray): ByteArray {
        require(secretKey.size == KEY_BYTES) { "X25519 secret key must be 32 bytes" }
        return scalarMultRaw(secretKey, BASEPOINT, rejectAllZero = false)
    }

    fun sharedSecret(secretKey: ByteArray, remotePublicKey: ByteArray): ByteArray {
        require(secretKey.size == KEY_BYTES) { "X25519 secret key must be 32 bytes" }
        require(remotePublicKey.size == KEY_BYTES) { "X25519 public key must be 32 bytes" }
        return scalarMultRaw(secretKey, remotePublicKey, rejectAllZero = true)
    }

    private fun clampScalar(z: ByteArray) {
        z[0] = (z[0].toInt() and 248).toByte()
        z[31] = ((z[31].toInt() and 127) or 64).toByte()
    }

    private fun scalarMultRaw(n: ByteArray, p: ByteArray, rejectAllZero: Boolean): ByteArray {
        val z = n.copyOf()
        clampScalar(z)

        val x = LongArray(80)
        val a = LongArray(16)
        val b = LongArray(16)
        val c = LongArray(16)
        val d = LongArray(16)
        val e = LongArray(16)
        val f = LongArray(16)

        unpack25519(x, p)
        for (i in 0 until 16) {
            b[i] = x[i]
            d[i] = 0L
            a[i] = 0L
            c[i] = 0L
        }
        a[0] = 1L
        d[0] = 1L

        for (i in 254 downTo 0) {
            val r = (z[i ushr 3].toInt() ushr (i and 7)) and 1
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
            M(a, c, _121665)
            A(a, a, d)
            M(c, c, a)
            M(a, d, f)
            M(d, b, x)
            S(b, e)
            sel25519(a, b, r)
            sel25519(c, d, r)
        }

        for (i in 0 until 16) {
            x[i + 16] = a[i]
            x[i + 32] = c[i]
            x[i + 48] = b[i]
            x[i + 64] = d[i]
        }

        inv25519(x, 32, x, 32)
        M(x, 16, x, 16, x, 32)

        val out = ByteArray(KEY_BYTES)
        pack25519(out, x, 16)

        Arrays.fill(z, 0.toByte())
        Arrays.fill(x, 0L)
        if (rejectAllZero) {
            var acc = 0
            for (v in out) acc = acc or (v.toInt() and 0xFF)
            if (acc == 0) {
                throw SecurityException("X25519 small-order public key produced all-zero shared secret")
            }
        }
        return out
    }

    private fun unpack25519(o: LongArray, n: ByteArray) {
        for (i in 0 until 16) {
            val lo = n[2 * i].toLong() and 0xFFL
            val hi = n[2 * i + 1].toLong() and 0xFFL
            o[i] = lo or (hi shl 8)
        }
        // RFC 7748 section 5: clear bit 255 of u-coordinate
        o[15] = o[15] and 0x7FFFL
    }

    private fun pack25519(o: ByteArray, n: LongArray, nOff: Int) {
        val m = LongArray(16)
        val t = LongArray(16)
        for (i in 0 until 16) t[i] = n[nOff + i]
        car25519(t)
        car25519(t)
        car25519(t)
        for (j in 0 until 2) {
            m[0] = t[0] - 0xFFEDL
            for (i in 1 until 15) {
                m[i] = t[i] - 0xFFFFL - ((m[i - 1] shr 16) and 1L)
                m[i - 1] = m[i - 1] and 0xFFFFL
            }
            m[15] = t[15] - 0x7FFFL - ((m[14] shr 16) and 1L)
            val b = ((m[15] shr 16) and 1L).toInt()
            m[14] = m[14] and 0xFFFFL
            sel25519(t, m, 1 - b)
        }
        for (i in 0 until 16) {
            o[2 * i] = (t[i] and 0xFFL).toByte()
            o[2 * i + 1] = ((t[i] ushr 8) and 0xFFL).toByte()
        }
    }

    private fun car25519(o: LongArray) {
        for (i in 0 until 16) {
            o[i] += 1L shl 16
            val c = o[i] shr 16
            val nextIdx = if (i < 15) i + 1 else 0
            val factor = if (i < 15) 1L else 38L
            o[nextIdx] += (c - 1L) * factor
            o[i] -= c shl 16
        }
    }

    private fun sel25519(p: LongArray, q: LongArray, b: Int) {
        val c = ((b and 1) - 1).toLong().inv()
        for (i in 0 until 16) {
            val t = c and (p[i] xor q[i])
            p[i] = p[i] xor t
            q[i] = q[i] xor t
        }
    }

    private fun A(o: LongArray, a: LongArray, b: LongArray) {
        for (i in 0 until 16) o[i] = a[i] + b[i]
    }

    private fun Z(o: LongArray, a: LongArray, b: LongArray) {
        for (i in 0 until 16) o[i] = a[i] - b[i]
    }

    private fun M(o: LongArray, a: LongArray, b: LongArray) {
        M(o, 0, a, 0, b, 0)
    }

    private fun M(
        o: LongArray,
        oOff: Int,
        a: LongArray,
        aOff: Int,
        b: LongArray,
        bOff: Int,
    ) {
        val t = LongArray(31)
        for (i in 0 until 16) {
            val ai = a[aOff + i]
            for (j in 0 until 16) {
                t[i + j] += ai * b[bOff + j]
            }
        }
        for (i in 0 until 15) {
            t[i] += 38L * t[i + 16]
        }
        for (i in 0 until 16) {
            o[oOff + i] = t[i]
        }
        if (oOff == 0) {
            car25519(o)
            car25519(o)
        } else {
            val tmp = LongArray(16)
            System.arraycopy(o, oOff, tmp, 0, 16)
            car25519(tmp)
            car25519(tmp)
            System.arraycopy(tmp, 0, o, oOff, 16)
        }
    }

    private fun S(o: LongArray, a: LongArray) {
        M(o, a, a)
    }

    private fun inv25519(o: LongArray, oOff: Int, iArr: LongArray, iOff: Int) {
        val c = LongArray(16)
        for (a in 0 until 16) c[a] = iArr[iOff + a]
        for (a in 253 downTo 0) {
            S(c, c)
            if (a != 2 && a != 4) {
                M(c, 0, c, 0, iArr, iOff)
            }
        }
        for (a in 0 until 16) o[oOff + a] = c[a]
    }
}
