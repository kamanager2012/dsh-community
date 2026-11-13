package org.dsh.community.android

import org.dsh.community.android.crypto.CryptoUtils
import org.dsh.community.android.crypto.Curve25519
import org.dsh.community.android.crypto.EncryptedTrustedHostStore
import org.dsh.community.android.crypto.MasterKeyCipher
import org.dsh.community.android.transport.RemoteEndpointProfile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class TrustedHostStoreTest {
    private class TestAesGcmMasterCipher : MasterKeyCipher {
        override val backingLabel: String = "jvm-aes-256-gcm-trusted-host-test"
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
    fun persistsTokenlessHostProfileDetectsTamperAndEnforcesDiscoveryVsTrust() {
        val dir = Files.createTempDirectory("dsh-trusted-host-test-").toFile()
        try {
            val random = SecureRandom()
            val hostKeys = Curve25519.generateKeyPair(random)
            val strangerKeys = Curve25519.generateKeyPair(random)
            val hostFp = CryptoUtils.sha256Hex(hostKeys.publicKey)
            val strangerFp = CryptoUtils.sha256Hex(strangerKeys.publicKey)

            val master = TestAesGcmMasterCipher()
            val store1 = EncryptedTrustedHostStore(dir, master)
            val saved = store1.upsertTrustedHost(
                hostPublicKey = hostKeys.publicKey,
                label = "Studio Desktop",
                lanUrl = "ws://192.168.1.50:9443",
                relayUrl = "ws://relay.local:9555",
                relayRoomId = hostFp,
                markConnected = true,
                nowMs = 1_700_000_000_000L,
            )
            assertEquals(hostFp, saved.hostFingerprint)
            assertFalse(saved.isRevoked)

            // Reload from encrypted store and reconstruct tokenless RemoteEndpointProfile
            val store2 = EncryptedTrustedHostStore(dir, master)
            val reloaded = store2.get(hostFp)
            assertNotNull(reloaded)
            val reconnectProfile = RemoteEndpointProfile.fromTrustedRecord(reloaded!!)
            assertNull(reconnectProfile.bootstrapToken)
            assertNull(reconnectProfile.relayClientToken)
            assertEquals("ws://192.168.1.50:9443", reconnectProfile.lanUrl)
            assertEquals("ws://relay.local:9555", reconnectProfile.relayUrl)

            // mDNS discovery must NEVER trust an unknown Host
            assertNull(
                store2.updateLanFromDiscovery(
                    hostFingerprint = strangerFp,
                    lanUrl = "ws://192.168.1.99:9443",
                    displayLabel = "Evil Host",
                ),
            )
            assertNull(store2.get(strangerFp))

            // mDNS discovery matching paired Host fingerprint refreshes lanUrl
            val updated = store2.updateLanFromDiscovery(
                hostFingerprint = hostFp,
                lanUrl = "ws://192.168.1.77:9443",
                displayLabel = "Studio LAN Renamed",
            )
            assertNotNull(updated)
            assertEquals("ws://192.168.1.77:9443", updated!!.lanUrl)
            assertEquals("Studio LAN Renamed", updated.label)

            // Revocation persists and blocks future mDNS LAN URL upgrades
            val revoked = store2.markRevoked(hostFp, "compromised-test", nowMs = 1_700_000_001_000L)
            assertNotNull(revoked)
            assertTrue(revoked!!.isRevoked)
            assertEquals("compromised-test", revoked.revokedReason)
            assertNull(
                store2.updateLanFromDiscovery(
                    hostFingerprint = hostFp,
                    lanUrl = "ws://192.168.1.88:9443",
                    displayLabel = "Should Not Refresh",
                ),
            )

            // Tampering wrapped store must fail closed via AEAD tag verification
            val binFile = File(dir, EncryptedTrustedHostStore.TRUSTED_HOSTS_FILE_NAME)
            val copy = binFile.readBytes()
            val backup = copy.copyOf()
            copy[copy.size - 1] = (copy[copy.size - 1].toInt() xor 0xFF).toByte()
            binFile.writeBytes(copy)
            assertThrows(AEADBadTagException::class.java) {
                store2.list()
            }

            // Restore and verify forgetHost removes entry cleanly
            binFile.writeBytes(backup)
            assertTrue(store2.forget(hostFp))
            assertNull(store2.get(hostFp))
            assertTrue(store2.list().isEmpty())
        } finally {
            dir.deleteRecursively()
        }
    }
}
