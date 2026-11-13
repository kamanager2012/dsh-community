package org.dsh.community.android

import org.dsh.community.android.crypto.EncryptedDeviceIdentityStore
import org.dsh.community.android.crypto.MasterKeyCipher
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class DeviceIdentityStoreTest {
    private class JvmAesGcmMasterCipher : MasterKeyCipher {
        override val backingLabel: String = "jvm-aes-256-gcm-test-master"
        private var key: SecretKey? = generateKey()

        private fun generateKey(): SecretKey {
            val gen = KeyGenerator.getInstance("AES")
            gen.init(256, SecureRandom())
            return gen.generateKey()
        }

        override fun wrap(plaintext: ByteArray, aad: ByteArray): ByteArray {
            val active = key ?: generateKey().also { key = it }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, active)
            cipher.updateAAD(aad)
            val iv = cipher.iv
            val ct = cipher.doFinal(plaintext)
            return byteArrayOf(1) + iv + ct
        }

        override fun unwrap(wrapped: ByteArray, aad: ByteArray): ByteArray {
            val active = key ?: throw IllegalStateException("master key deleted")
            val iv = wrapped.copyOfRange(1, 13)
            val ct = wrapped.copyOfRange(13, wrapped.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, active, GCMParameterSpec(128, iv))
            cipher.updateAAD(aad)
            return cipher.doFinal(ct)
        }

        override fun deleteMasterKey() {
            key = null
        }
    }

    @Test
    fun persistsEncryptedIdentityAndDetectsTamperAndRedactsSecret() {
        val dir = Files.createTempDirectory("dsh-id-store-test-").toFile()
        try {
            val master = JvmAesGcmMasterCipher()
            val store1 = EncryptedDeviceIdentityStore(dir, master)
            val id1 = store1.loadOrCreate()

            // Reload from persisted wrapped file
            val store2 = EncryptedDeviceIdentityStore(dir, master)
            val id2 = store2.loadOrCreate()
            assertEquals(id1.deviceId, id2.deviceId)
            assertEquals(id1.publicKeyHex, id2.publicKeyHex)
            assertEquals("jvm-aes-256-gcm-test-master", id2.backing)

            // Redaction check
            assertFalse(id1.toString().contains("raw"))
            assert(id1.toString().contains("secretKey=[REDACTED]"))

            // Tampering wrapped ciphertext must fail closed via GCM tag
            val wrappedFile = File(dir, "dsh_remote_identity_v1.bin")
            val bytes = wrappedFile.readBytes()
            bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 0xFF).toByte()
            wrappedFile.writeBytes(bytes)

            assertThrows(AEADBadTagException::class.java) {
                store2.loadOrCreate()
            }

            // Reset rotates identity & master key
            val rotated = store2.resetIdentity()
            assertNotEquals(id1.deviceId, rotated.deviceId)
        } finally {
            dir.deleteRecursively()
        }
    }
}
