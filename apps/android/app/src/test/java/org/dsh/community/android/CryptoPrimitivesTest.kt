package org.dsh.community.android

import org.dsh.community.android.crypto.Blake2b
import org.dsh.community.android.crypto.ChaCha20Poly1305
import org.dsh.community.android.crypto.CryptoUtils
import org.dsh.community.android.crypto.Curve25519
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.nio.charset.StandardCharsets

class CryptoPrimitivesTest {
    @Test
    fun blake2bMatchesRfc7693Vectors() {
        // RFC 7693 empty input, 64-byte digest
        val emptyDigest = Blake2b.digest(ByteArray(0))
        assertEquals(
            "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
            CryptoUtils.toHex(emptyDigest),
        )

        // RFC 7693 "abc" input, 64-byte digest
        val abcDigest = Blake2b.digest("abc".toByteArray(StandardCharsets.US_ASCII))
        assertEquals(
            "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
            CryptoUtils.toHex(abcDigest),
        )
    }

    @Test
    fun curve25519MatchesRfc7748TestVectorsAndRejectsLowOrder() {
        // RFC 7748 Section 5.2 first vector
        val scalar1 = CryptoUtils.fromHex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4")
        val uCoord1 = CryptoUtils.fromHex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c")
        val expected1 = CryptoUtils.fromHex("c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552")
        assertArrayEquals(expected1, Curve25519.sharedSecret(scalar1, uCoord1))

        // RFC 7748 Section 6.1 Alice/Bob key exchange
        val alicePriv = CryptoUtils.fromHex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        val alicePubExpected = CryptoUtils.fromHex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
        val bobPriv = CryptoUtils.fromHex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
        val bobPubExpected = CryptoUtils.fromHex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
        val sharedExpected = CryptoUtils.fromHex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")

        assertArrayEquals(alicePubExpected, Curve25519.scalarMultBase(alicePriv))
        assertArrayEquals(bobPubExpected, Curve25519.scalarMultBase(bobPriv))
        assertArrayEquals(sharedExpected, Curve25519.sharedSecret(alicePriv, bobPubExpected))
        assertArrayEquals(sharedExpected, Curve25519.sharedSecret(bobPriv, alicePubExpected))

        // Small-order point must fail closed
        assertThrows(SecurityException::class.java) {
            Curve25519.sharedSecret(alicePriv, ByteArray(32))
        }
    }

    @Test
    fun chacha20Poly1305MatchesRfc8439AeadVectorAndRejectsTampering() {
        // RFC 8439 Section 2.8.2 test vector
        val key = CryptoUtils.fromHex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f")
        val nonce = CryptoUtils.fromHex("070000004041424344454647")
        val aad = CryptoUtils.fromHex("50515253c0c1c2c3c4c5c6c7")
        val pt = "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it."
            .toByteArray(StandardCharsets.US_ASCII)

        val expectedCiphertextHex =
            "d31a8d34648e60db7b86afbc53ef7ec2" +
                "a4aded51296e08fea9e2b5a736ee62d6" +
                "3dbea45e8ca9671282fafb69da92728b" +
                "1a71de0a9e060b2905d6a5b67ecd3b36" +
                "92ddbd7f2d778b8c9803aee328091b58" +
                "fab324e4fad675945585808b4831d7bc" +
                "3ff4def08e4b7a9de576d26586cec64b" +
                "6116"
        val expectedTagHex = "1ae10b594f09e26a7e902ecbd0600691"

        val sealed = ChaCha20Poly1305.encrypt(key, nonce, pt, aad)
        assertEquals(expectedCiphertextHex + expectedTagHex, CryptoUtils.toHex(sealed))

        val opened = ChaCha20Poly1305.decrypt(key, nonce, sealed, aad)
        assertArrayEquals(pt, opened)

        // Flip 1 bit in tag -> fail closed
        val corrupted = sealed.copyOf()
        corrupted[corrupted.size - 1] = (corrupted[corrupted.size - 1].toInt() xor 0x01).toByte()
        assertThrows(SecurityException::class.java) {
            ChaCha20Poly1305.decrypt(key, nonce, corrupted, aad)
        }

        // Verify noise-handshake nonce layout: zeros(4) || uint32_le(counter) || zeros(4)
        assertEquals(
            "000000007856341200000000",
            CryptoUtils.toHex(ChaCha20Poly1305.noiseNonce(0x12345678L)),
        )
    }
}
