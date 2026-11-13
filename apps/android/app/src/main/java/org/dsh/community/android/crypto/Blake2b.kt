package org.dsh.community.android.crypto

import java.security.MessageDigest
import java.util.Arrays

/**
 * Pure Kotlin RFC 7693 BLAKE2b (64-byte digest), HMAC-BLAKE2b, and HKDF-BLAKE2b
 * wire-compatible with `noise-handshake` (`Noise_IK_25519_ChaChaPoly_BLAKE2b`).
 */
object Blake2b {
    const val HASH_LEN = 64
    const val BLOCK_LEN = 128

    private val IV = longArrayOf(
        0x6a09e667f3bcc908UL.toLong(),
        0xbb67ae8584caa73bUL.toLong(),
        0x3c6ef372fe94f82bUL.toLong(),
        0xa54ff53a5f1d36f1UL.toLong(),
        0x510e527fade682d1UL.toLong(),
        0x9b05688c2b3e6c1fUL.toLong(),
        0x1f83d9abfb41bd6bUL.toLong(),
        0x5be0cd19137e2179UL.toLong(),
    )

    private val SIGMA = arrayOf(
        intArrayOf(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15),
        intArrayOf(14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3),
        intArrayOf(11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4),
        intArrayOf(7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8),
        intArrayOf(9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13),
        intArrayOf(2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9),
        intArrayOf(12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11),
        intArrayOf(13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10),
        intArrayOf(6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5),
        intArrayOf(10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0),
        intArrayOf(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15),
        intArrayOf(14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3),
    )

    fun digest(vararg chunks: ByteArray, outLen: Int = HASH_LEN): ByteArray {
        require(outLen in 1..HASH_LEN) { "outLen must be in 1..64" }
        val h = IV.copyOf()
        h[0] = h[0] xor (0x01010000L or outLen.toLong())

        val buf = ByteArray(BLOCK_LEN)
        var bufLen = 0
        var t0 = 0L
        var t1 = 0L

        for (chunk in chunks) {
            var offset = 0
            while (offset < chunk.size) {
                if (bufLen == BLOCK_LEN) {
                    val prev = t0
                    t0 += BLOCK_LEN.toLong()
                    if (java.lang.Long.compareUnsigned(t0, prev) < 0) {
                        t1 += 1L
                    }
                    compress(h, buf, t0, t1, isFinal = false)
                    bufLen = 0
                }
                val take = minOf(BLOCK_LEN - bufLen, chunk.size - offset)
                System.arraycopy(chunk, offset, buf, bufLen, take)
                bufLen += take
                offset += take
            }
        }

        val prev = t0
        t0 += bufLen.toLong()
        if (java.lang.Long.compareUnsigned(t0, prev) < 0) {
            t1 += 1L
        }
        if (bufLen < BLOCK_LEN) {
            Arrays.fill(buf, bufLen, BLOCK_LEN, 0.toByte())
        }
        compress(h, buf, t0, t1, isFinal = true)

        val out = ByteArray(outLen)
        val full = ByteArray(HASH_LEN)
        for (i in 0 until 8) {
            storeLe64(full, i * 8, h[i])
        }
        System.arraycopy(full, 0, out, 0, outLen)
        Arrays.fill(buf, 0.toByte())
        Arrays.fill(full, 0.toByte())
        Arrays.fill(h, 0L)
        return out
    }

    fun hmac(key: ByteArray, vararg chunks: ByteArray): ByteArray {
        val paddedKey = ByteArray(BLOCK_LEN)
        if (key.size > BLOCK_LEN) {
            val hashed = digest(key)
            System.arraycopy(hashed, 0, paddedKey, 0, hashed.size)
            Arrays.fill(hashed, 0.toByte())
        } else {
            System.arraycopy(key, 0, paddedKey, 0, key.size)
        }

        val innerPad = ByteArray(BLOCK_LEN)
        val outerPad = ByteArray(BLOCK_LEN)
        for (i in 0 until BLOCK_LEN) {
            val kb = paddedKey[i].toInt() and 0xFF
            innerPad[i] = (kb xor 0x36).toByte()
            outerPad[i] = (kb xor 0x5c).toByte()
        }
        Arrays.fill(paddedKey, 0.toByte())

        val innerArgs = arrayOfNulls<ByteArray>(1 + chunks.size)
        innerArgs[0] = innerPad
        for (i in chunks.indices) {
            innerArgs[1 + i] = chunks[i]
        }
        @Suppress("UNCHECKED_CAST")
        val innerHash = digest(*(innerArgs as Array<ByteArray>))
        val mac = digest(outerPad, innerHash)

        Arrays.fill(innerPad, 0.toByte())
        Arrays.fill(outerPad, 0.toByte())
        Arrays.fill(innerHash, 0.toByte())
        return mac
    }

    /**
     * Exact match to `noise-handshake/hkdf.js`: extracts PRK with HMAC-BLAKE2b(salt, ikm),
     * then expands in 64-byte chunks with `[prev, info, blockIndex]`, initializing `prev = info`.
     */
    fun hkdf(
        salt: ByteArray,
        ikm: ByteArray,
        info: ByteArray = ByteArray(0),
        totalLength: Int = 2 * HASH_LEN,
    ): List<ByteArray> {
        require(totalLength >= HASH_LEN && totalLength % HASH_LEN == 0) {
            "totalLength must be a positive multiple of 64"
        }
        val prk = hmac(salt, ikm)
        val result = ArrayList<ByteArray>(totalLength / HASH_LEN)
        var prev = info
        val blocks = totalLength / HASH_LEN
        for (blockIdx in 1..blocks) {
            val pos = byteArrayOf(blockIdx.toByte())
            val out = hmac(prk, prev, info, pos)
            result.add(out)
            prev = out
        }
        Arrays.fill(prk, 0.toByte())
        return result
    }

    private fun compress(h: LongArray, block: ByteArray, t0: Long, t1: Long, isFinal: Boolean) {
        val m = LongArray(16)
        for (i in 0 until 16) {
            m[i] = loadLe64(block, i * 8)
        }

        val v = LongArray(16)
        for (i in 0 until 8) {
            v[i] = h[i]
            v[i + 8] = IV[i]
        }
        v[12] = v[12] xor t0
        v[13] = v[13] xor t1
        if (isFinal) {
            v[14] = v[14].inv()
        }

        for (r in 0 until 12) {
            val s = SIGMA[r]
            g(v, 0, 4, 8, 12, m[s[0]], m[s[1]])
            g(v, 1, 5, 9, 13, m[s[2]], m[s[3]])
            g(v, 2, 6, 10, 14, m[s[4]], m[s[5]])
            g(v, 3, 7, 11, 15, m[s[6]], m[s[7]])
            g(v, 0, 5, 10, 15, m[s[8]], m[s[9]])
            g(v, 1, 6, 11, 12, m[s[10]], m[s[11]])
            g(v, 2, 7, 8, 13, m[s[12]], m[s[13]])
            g(v, 3, 4, 9, 14, m[s[14]], m[s[15]])
        }

        for (i in 0 until 8) {
            h[i] = h[i] xor v[i] xor v[i + 8]
        }
        Arrays.fill(m, 0L)
        Arrays.fill(v, 0L)
    }

    private fun g(v: LongArray, a: Int, b: Int, c: Int, d: Int, x: Long, y: Long) {
        v[a] = v[a] + v[b] + x
        v[d] = rotr64(v[d] xor v[a], 32)
        v[c] = v[c] + v[d]
        v[b] = rotr64(v[b] xor v[c], 24)
        v[a] = v[a] + v[b] + y
        v[d] = rotr64(v[d] xor v[a], 16)
        v[c] = v[c] + v[d]
        v[b] = rotr64(v[b] xor v[c], 63)
    }

    private fun rotr64(x: Long, n: Int): Long = (x ushr n) or (x shl (64 - n))

    private fun loadLe64(src: ByteArray, off: Int): Long =
        (src[off].toLong() and 0xFFL) or
            ((src[off + 1].toLong() and 0xFFL) shl 8) or
            ((src[off + 2].toLong() and 0xFFL) shl 16) or
            ((src[off + 3].toLong() and 0xFFL) shl 24) or
            ((src[off + 4].toLong() and 0xFFL) shl 32) or
            ((src[off + 5].toLong() and 0xFFL) shl 40) or
            ((src[off + 6].toLong() and 0xFFL) shl 48) or
            ((src[off + 7].toLong() and 0xFFL) shl 56)

    private fun storeLe64(dst: ByteArray, off: Int, v: Long) {
        dst[off] = (v and 0xFFL).toByte()
        dst[off + 1] = ((v ushr 8) and 0xFFL).toByte()
        dst[off + 2] = ((v ushr 16) and 0xFFL).toByte()
        dst[off + 3] = ((v ushr 24) and 0xFFL).toByte()
        dst[off + 4] = ((v ushr 32) and 0xFFL).toByte()
        dst[off + 5] = ((v ushr 40) and 0xFFL).toByte()
        dst[off + 6] = ((v ushr 48) and 0xFFL).toByte()
        dst[off + 7] = ((v ushr 56) and 0xFFL).toByte()
    }
}

object CryptoUtils {
    fun sha256(vararg chunks: ByteArray): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        for (c in chunks) md.update(c)
        return md.digest()
    }

    fun sha256Hex(vararg chunks: ByteArray): String = toHex(sha256(*chunks))

    fun toHex(bytes: ByteArray): String {
        val chars = "0123456789abcdef"
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xFF
            sb.append(chars[v ushr 4])
            sb.append(chars[v and 0x0F])
        }
        return sb.toString()
    }

    fun fromHex(hex: String): ByteArray {
        require(hex.length % 2 == 0) { "hex string must have even length" }
        val out = ByteArray(hex.length / 2)
        for (i in out.indices) {
            val hi = hexDigit(hex[i * 2])
            val lo = hexDigit(hex[i * 2 + 1])
            out[i] = ((hi shl 4) or lo).toByte()
        }
        return out
    }

    private fun hexDigit(c: Char): Int = when (c) {
        in '0'..'9' -> c - '0'
        in 'a'..'f' -> c - 'a' + 10
        in 'A'..'F' -> c - 'A' + 10
        else -> throw IllegalArgumentException("invalid hex char: '$c'")
    }

    fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean {
        if (a.size != b.size) return false
        var diff = 0
        for (i in a.indices) {
            diff = diff or ((a[i].toInt() and 0xFF) xor (b[i].toInt() and 0xFF))
        }
        return diff == 0
    }

    fun zeroize(bytes: ByteArray?) {
        if (bytes != null) Arrays.fill(bytes, 0.toByte())
    }
}
