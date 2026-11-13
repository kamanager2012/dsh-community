package org.dsh.community.android.crypto

import java.math.BigInteger
import java.util.Arrays

/**
 * Pure Kotlin RFC 8439 ChaCha20-Poly1305 IETF AEAD matching `noise-handshake/cipher.js`.
 */
object ChaCha20Poly1305 {
    const val KEY_BYTES = 32
    const val NONCE_BYTES = 12
    const val TAG_BYTES = 16

    private val POLY1305_PRIME = BigInteger.ONE.shiftLeft(130).subtract(BigInteger.valueOf(5))

    /**
     * Exact nonce format used by `noise-handshake/cipher.js`:
     * 12-byte buffer where bytes [0..3]=0, bytes [4..7]=uint32_le(counter), bytes [8..11]=0.
     */
    fun noiseNonce(counter: Long): ByteArray {
        require(counter in 0L..0xFFFF_FFFFL) { "counter out of uint32 range: $counter" }
        val nonce = ByteArray(NONCE_BYTES)
        nonce[4] = (counter and 0xFFL).toByte()
        nonce[5] = ((counter ushr 8) and 0xFFL).toByte()
        nonce[6] = ((counter ushr 16) and 0xFFL).toByte()
        nonce[7] = ((counter ushr 24) and 0xFFL).toByte()
        return nonce
    }

    fun encrypt(
        key: ByteArray,
        nonce: ByteArray,
        plaintext: ByteArray,
        aad: ByteArray = ByteArray(0),
    ): ByteArray {
        require(key.size == KEY_BYTES) { "ChaCha20 key must be 32 bytes" }
        require(nonce.size == NONCE_BYTES) { "ChaCha20-Poly1305 nonce must be 12 bytes" }

        val otkBlock = chacha20Block(key, counter = 0, nonce)
        val polyKey = otkBlock.copyOfRange(0, 32)
        val ciphertext = chacha20Xor(key, initialCounter = 1, nonce, plaintext)
        val tag = computePoly1305Tag(polyKey, aad, ciphertext)

        val out = ByteArray(ciphertext.size + TAG_BYTES)
        System.arraycopy(ciphertext, 0, out, 0, ciphertext.size)
        System.arraycopy(tag, 0, out, ciphertext.size, TAG_BYTES)

        Arrays.fill(otkBlock, 0.toByte())
        Arrays.fill(polyKey, 0.toByte())
        return out
    }

    fun decrypt(
        key: ByteArray,
        nonce: ByteArray,
        ciphertextWithTag: ByteArray,
        aad: ByteArray = ByteArray(0),
    ): ByteArray {
        require(key.size == KEY_BYTES) { "ChaCha20 key must be 32 bytes" }
        require(nonce.size == NONCE_BYTES) { "ChaCha20-Poly1305 nonce must be 12 bytes" }
        if (ciphertextWithTag.size < TAG_BYTES) {
            throw SecurityException("ciphertext shorter than 16-byte Poly1305 tag")
        }

        val ctLen = ciphertextWithTag.size - TAG_BYTES
        val ciphertext = ciphertextWithTag.copyOfRange(0, ctLen)
        val suppliedTag = ciphertextWithTag.copyOfRange(ctLen, ciphertextWithTag.size)

        val otkBlock = chacha20Block(key, counter = 0, nonce)
        val polyKey = otkBlock.copyOfRange(0, 32)
        val expectedTag = computePoly1305Tag(polyKey, aad, ciphertext)

        Arrays.fill(otkBlock, 0.toByte())
        Arrays.fill(polyKey, 0.toByte())

        if (!CryptoUtils.constantTimeEquals(suppliedTag, expectedTag)) {
            throw SecurityException("ChaCha20-Poly1305 MAC verification failed")
        }

        return chacha20Xor(key, initialCounter = 1, nonce, ciphertext)
    }

    fun chacha20Xor(
        key: ByteArray,
        initialCounter: Int,
        nonce: ByteArray,
        input: ByteArray,
    ): ByteArray {
        val output = ByteArray(input.size)
        var offset = 0
        var counter = initialCounter
        while (offset < input.size) {
            val block = chacha20Block(key, counter, nonce)
            val take = minOf(64, input.size - offset)
            for (i in 0 until take) {
                output[offset + i] = ((input[offset + i].toInt() xor block[i].toInt()) and 0xFF).toByte()
            }
            Arrays.fill(block, 0.toByte())
            offset += take
            counter += 1
        }
        return output
    }

    fun chacha20Block(key: ByteArray, counter: Int, nonce: ByteArray): ByteArray {
        val state = IntArray(16)
        state[0] = 0x61707865
        state[1] = 0x3320646e
        state[2] = 0x79622d32
        state[3] = 0x6b206574
        for (i in 0 until 8) {
            state[4 + i] = loadLe32(key, i * 4)
        }
        state[12] = counter
        state[13] = loadLe32(nonce, 0)
        state[14] = loadLe32(nonce, 4)
        state[15] = loadLe32(nonce, 8)

        val working = state.copyOf()
        for (i in 0 until 10) {
            quarterRound(working, 0, 4, 8, 12)
            quarterRound(working, 1, 5, 9, 13)
            quarterRound(working, 2, 6, 10, 14)
            quarterRound(working, 3, 7, 11, 15)
            quarterRound(working, 0, 5, 10, 15)
            quarterRound(working, 1, 6, 11, 12)
            quarterRound(working, 2, 7, 8, 13)
            quarterRound(working, 3, 4, 9, 14)
        }

        val out = ByteArray(64)
        for (i in 0 until 16) {
            storeLe32(out, i * 4, working[i] + state[i])
        }
        Arrays.fill(state, 0)
        Arrays.fill(working, 0)
        return out
    }

    private fun quarterRound(x: IntArray, a: Int, b: Int, c: Int, d: Int) {
        x[a] += x[b]; x[d] = rotl32(x[d] xor x[a], 16)
        x[c] += x[d]; x[b] = rotl32(x[b] xor x[c], 12)
        x[a] += x[b]; x[d] = rotl32(x[d] xor x[a], 8)
        x[c] += x[d]; x[b] = rotl32(x[b] xor x[c], 7)
    }

    private fun rotl32(v: Int, n: Int): Int = (v shl n) or (v ushr (32 - n))

    private fun computePoly1305Tag(polyKey: ByteArray, aad: ByteArray, ciphertext: ByteArray): ByteArray {
        val aadPad = (16 - (aad.size % 16)) % 16
        val ctPad = (16 - (ciphertext.size % 16)) % 16
        val macInput = ByteArray(aad.size + aadPad + ciphertext.size + ctPad + 16)
        var pos = 0
        System.arraycopy(aad, 0, macInput, pos, aad.size)
        pos += aad.size + aadPad
        System.arraycopy(ciphertext, 0, macInput, pos, ciphertext.size)
        pos += ciphertext.size + ctPad
        storeLe64(macInput, pos, aad.size.toLong())
        storeLe64(macInput, pos + 8, ciphertext.size.toLong())
        return poly1305Mac(polyKey, macInput)
    }

    fun poly1305Mac(key32: ByteArray, msg: ByteArray): ByteArray {
        val rBytes = key32.copyOfRange(0, 16)
        rBytes[3] = (rBytes[3].toInt() and 15).toByte()
        rBytes[7] = (rBytes[7].toInt() and 15).toByte()
        rBytes[11] = (rBytes[11].toInt() and 15).toByte()
        rBytes[15] = (rBytes[15].toInt() and 15).toByte()
        rBytes[4] = (rBytes[4].toInt() and 252).toByte()
        rBytes[8] = (rBytes[8].toInt() and 252).toByte()
        rBytes[12] = (rBytes[12].toInt() and 252).toByte()

        val r = fromLeUnsigned(rBytes)
        val s = fromLeUnsigned(key32.copyOfRange(16, 32))
        var acc = BigInteger.ZERO

        var off = 0
        while (off < msg.size) {
            val blockLen = minOf(16, msg.size - off)
            val block = ByteArray(blockLen + 1)
            System.arraycopy(msg, off, block, 0, blockLen)
            block[blockLen] = 1.toByte()
            val n = fromLeUnsigned(block)
            acc = acc.add(n).multiply(r).mod(POLY1305_PRIME)
            off += blockLen
        }

        acc = acc.add(s)
        val accBytes = toLeFixed(acc, 16)
        Arrays.fill(rBytes, 0.toByte())
        return accBytes
    }

    private fun fromLeUnsigned(le: ByteArray): BigInteger {
        val be = ByteArray(le.size)
        for (i in le.indices) {
            be[i] = le[le.size - 1 - i]
        }
        return BigInteger(1, be)
    }

    private fun toLeFixed(value: BigInteger, size: Int): ByteArray {
        val out = ByteArray(size)
        val be = value.toByteArray()
        var srcIdx = be.size - 1
        var dstIdx = 0
        while (dstIdx < size && srcIdx >= 0) {
            out[dstIdx++] = be[srcIdx--]
        }
        return out
    }

    private fun loadLe32(src: ByteArray, off: Int): Int =
        (src[off].toInt() and 0xFF) or
            ((src[off + 1].toInt() and 0xFF) shl 8) or
            ((src[off + 2].toInt() and 0xFF) shl 16) or
            ((src[off + 3].toInt() and 0xFF) shl 24)

    private fun storeLe32(dst: ByteArray, off: Int, v: Int) {
        dst[off] = (v and 0xFF).toByte()
        dst[off + 1] = ((v ushr 8) and 0xFF).toByte()
        dst[off + 2] = ((v ushr 16) and 0xFF).toByte()
        dst[off + 3] = ((v ushr 24) and 0xFF).toByte()
    }

    private fun storeLe64(dst: ByteArray, off: Int, v: Long) {
        for (i in 0 until 8) {
            dst[off + i] = ((v ushr (i * 8)) and 0xFFL).toByte()
        }
    }
}
