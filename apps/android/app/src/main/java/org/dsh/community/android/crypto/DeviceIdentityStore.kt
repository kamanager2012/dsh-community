package org.dsh.community.android.crypto

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class DeviceIdentity(
    val keyPair: Curve25519.KeyPair,
    val deviceId: String,
    val backing: String,
) {
    val publicKeyHex: String
        get() = CryptoUtils.toHex(keyPair.publicKey)

    override fun toString(): String =
        "DeviceIdentity(deviceId=$deviceId, publicKeyHex=$publicKeyHex, backing=$backing, secretKey=[REDACTED])"
}

/**
 * Abstracts AES-256-GCM hardware-backed key wrapping so [EncryptedDeviceIdentityStore] works
 * identically with Android Keystore on device and deterministic AES-GCM keys in JVM unit tests.
 */
interface MasterKeyCipher {
    val backingLabel: String
    fun wrap(plaintext: ByteArray, aad: ByteArray): ByteArray
    fun unwrap(wrapped: ByteArray, aad: ByteArray): ByteArray
    fun deleteMasterKey()
}

/**
 * Android Keystore hardware-backed AES-256-GCM master key wrapper.
 * Wraps the device's persistent X25519 identity keypair in `noBackupFilesDir`.
 */
class AndroidKeystoreMasterCipher(
    private val alias: String = DEFAULT_KEY_ALIAS,
) : MasterKeyCipher {

    companion object {
        const val DEFAULT_KEY_ALIAS = "dsh_remote_device_master_v1"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_IV_BYTES = 12
        private const val GCM_TAG_BITS = 128
        private const val FORMAT_VERSION: Byte = 1
    }

    @Volatile
    private var resolvedBacking: String = "android-keystore-tee"

    override val backingLabel: String
        get() = resolvedBacking

    @Synchronized
    private fun getOrCreateMasterKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = ks.getKey(alias, null) as? SecretKey
        if (existing != null) return existing

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        fun buildSpec(strongBox: Boolean): KeyGenParameterSpec {
            val builder = KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
            if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                builder.setIsStrongBoxBacked(true)
            }
            return builder.build()
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                generator.init(buildSpec(strongBox = true))
                val key = generator.generateKey()
                resolvedBacking = "android-keystore-strongbox"
                return key
            } catch (_: Exception) {
                // StrongBox hardware is optional on many Android devices; fall back cleanly to TEE.
            }
        }

        generator.init(buildSpec(strongBox = false))
        resolvedBacking = "android-keystore-tee"
        return generator.generateKey()
    }

    override fun wrap(plaintext: ByteArray, aad: ByteArray): ByteArray {
        val key = getOrCreateMasterKey()
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        cipher.updateAAD(aad)
        val iv = cipher.iv
        require(iv.size == GCM_IV_BYTES) { "unexpected Keystore GCM IV length: ${iv.size}" }
        val ciphertext = cipher.doFinal(plaintext)

        val out = ByteArray(1 + GCM_IV_BYTES + ciphertext.size)
        out[0] = FORMAT_VERSION
        System.arraycopy(iv, 0, out, 1, GCM_IV_BYTES)
        System.arraycopy(ciphertext, 0, out, 1 + GCM_IV_BYTES, ciphertext.size)
        return out
    }

    override fun unwrap(wrapped: ByteArray, aad: ByteArray): ByteArray {
        require(wrapped.size > 1 + GCM_IV_BYTES + 16) { "wrapped device identity payload is truncated" }
        require(wrapped[0] == FORMAT_VERSION) { "unsupported wrapped identity version: ${wrapped[0]}" }

        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val key = ks.getKey(alias, null) as? SecretKey
            ?: throw IllegalStateException("Android Keystore master key '$alias' is missing")

        val iv = wrapped.copyOfRange(1, 1 + GCM_IV_BYTES)
        val ciphertext = wrapped.copyOfRange(1 + GCM_IV_BYTES, wrapped.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
        cipher.updateAAD(aad)
        return cipher.doFinal(ciphertext)
    }

    override fun deleteMasterKey() {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        if (ks.containsAlias(alias)) {
            ks.deleteEntry(alias)
        }
    }
}

/**
 * Stores wrapped Curve25519 device identity in backup-excluded app-private storage (`noBackupFilesDir`).
 * Private keys never touch SharedPreferences, plain files, or cloud backup snapshots.
 */
class EncryptedDeviceIdentityStore(
    private val storageDir: File,
    private val masterCipher: MasterKeyCipher,
    private val random: SecureRandom = SecureRandom(),
) {
    companion object {
        private const val IDENTITY_FILE_NAME = "dsh_remote_identity_v1.bin"
        private val AAD = "dsh-android-device-identity-v1".toByteArray(StandardCharsets.US_ASCII)
        private const val WRAPPED_SECRET_BYTES = Curve25519.KEY_BYTES * 2

        fun createForAndroid(context: Context): EncryptedDeviceIdentityStore =
            EncryptedDeviceIdentityStore(
                storageDir = context.noBackupFilesDir,
                masterCipher = AndroidKeystoreMasterCipher(),
            )
    }

    private val identityFile = File(storageDir, IDENTITY_FILE_NAME)

    @Synchronized
    fun loadOrCreate(): DeviceIdentity {
        if (identityFile.exists()) {
            val wrapped = identityFile.readBytes()
            val plain = masterCipher.unwrap(wrapped, AAD)
            try {
                if (plain.size != WRAPPED_SECRET_BYTES) {
                    throw SecurityException("corrupt unwrapped device key length: ${plain.size}")
                }
                val secret = plain.copyOfRange(0, Curve25519.KEY_BYTES)
                val storedPub = plain.copyOfRange(Curve25519.KEY_BYTES, WRAPPED_SECRET_BYTES)
                val derivedPair = Curve25519.keyPairFromSecret(secret)
                if (!CryptoUtils.constantTimeEquals(derivedPair.publicKey, storedPub)) {
                    derivedPair.zeroize()
                    throw SecurityException("stored publicKey does not match wrapped Curve25519 secret")
                }
                val deviceId = CryptoUtils.sha256Hex(derivedPair.publicKey)
                return DeviceIdentity(derivedPair, deviceId, masterCipher.backingLabel)
            } finally {
                CryptoUtils.zeroize(plain)
            }
        }

        if (!storageDir.exists()) {
            storageDir.mkdirs()
        }

        val pair = Curve25519.generateKeyPair(random)
        val combined = ByteArray(WRAPPED_SECRET_BYTES)
        System.arraycopy(pair.secretKey, 0, combined, 0, Curve25519.KEY_BYTES)
        System.arraycopy(pair.publicKey, 0, combined, Curve25519.KEY_BYTES, Curve25519.KEY_BYTES)
        val wrapped = try {
            masterCipher.wrap(combined, AAD)
        } finally {
            CryptoUtils.zeroize(combined)
        }

        writeEncryptedBlobAtomically(storageDir, identityFile, wrapped)

        val deviceId = CryptoUtils.sha256Hex(pair.publicKey)
        return DeviceIdentity(pair, deviceId, masterCipher.backingLabel)
    }

    @Synchronized
    fun resetIdentity(): DeviceIdentity {
        if (identityFile.exists()) identityFile.delete()
        masterCipher.deleteMasterKey()
        return loadOrCreate()
    }
}

internal fun writeEncryptedBlobAtomically(storageDir: File, targetFile: File, wrapped: ByteArray) {
    if (!storageDir.exists()) {
        storageDir.mkdirs()
    }
    val tmpFile = File(storageDir, "${targetFile.name}.tmp")
    tmpFile.writeBytes(wrapped)
    if (!tmpFile.renameTo(targetFile)) {
        targetFile.writeBytes(wrapped)
        tmpFile.delete()
    }
}
