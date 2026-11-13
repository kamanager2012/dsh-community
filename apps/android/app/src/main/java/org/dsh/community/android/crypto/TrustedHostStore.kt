package org.dsh.community.android.crypto

import android.content.Context
import org.dsh.community.android.protocol.JsonArray
import org.dsh.community.android.protocol.JsonCodec
import org.dsh.community.android.protocol.JsonNumber
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.JsonString
import java.io.File
import java.nio.charset.StandardCharsets

/**
 * Hardware/Keystore-wrapped saved Host profile for tokenless Noise IK reconnects.
 *
 * Intentionally excludes pairing `bootstrapToken` and relay admission secrets so
 * subsequent connections authenticate strictly with the paired Curve25519 device identity.
 */
data class TrustedHostRecord(
    val hostFingerprint: String,
    val hostPublicKeyHex: String,
    val label: String,
    val lanUrl: String? = null,
    val signalingUrl: String? = null,
    val signalingRoomId: String? = null,
    val stunUrls: List<String> = emptyList(),
    val relayUrl: String? = null,
    val relayRoomId: String? = null,
    val pairedAtMs: Long,
    val lastConnectedAtMs: Long? = null,
    val revokedAtMs: Long? = null,
    val revokedReason: String? = null,
) {
    val isRevoked: Boolean
        get() = revokedAtMs != null

    val hostPublicKeyBytes: ByteArray
        get() = CryptoUtils.fromHex(hostPublicKeyHex)
}

/**
 * Persists paired [TrustedHostRecord] profiles encrypted at rest with an Android Keystore
 * AES-256-GCM master key (or deterministic AES-256-GCM cipher in JVM unit tests).
 */
class EncryptedTrustedHostStore(
    private val storageDir: File,
    private val masterCipher: MasterKeyCipher,
) {
    companion object {
        const val TRUSTED_HOSTS_FILE_NAME = "dsh_remote_trusted_hosts_v1.bin"
        const val KEYSTORE_ALIAS = "dsh_remote_trusted_hosts_master_v1"
        private const val SCHEMA_VERSION = 1
        private val AAD = "dsh-remote-trusted-hosts-v1".toByteArray(StandardCharsets.UTF_8)

        fun createForAndroid(context: Context): EncryptedTrustedHostStore =
            EncryptedTrustedHostStore(
                storageDir = context.noBackupFilesDir,
                masterCipher = AndroidKeystoreMasterCipher(KEYSTORE_ALIAS),
            )
    }

    private val storeFile = File(storageDir, TRUSTED_HOSTS_FILE_NAME)

    val backingLabel: String
        get() = masterCipher.backingLabel

    @Synchronized
    fun list(): List<TrustedHostRecord> =
        readMapLocked().values
            .sortedByDescending { it.lastConnectedAtMs ?: it.pairedAtMs }

    @Synchronized
    fun get(hostFingerprint: String): TrustedHostRecord? =
        readMapLocked()[hostFingerprint.lowercase()]

    @Synchronized
    fun upsertTrustedHost(
        hostPublicKey: ByteArray,
        label: String? = null,
        lanUrl: String? = null,
        signalingUrl: String? = null,
        signalingRoomId: String? = null,
        stunUrls: List<String> = emptyList(),
        relayUrl: String? = null,
        relayRoomId: String? = null,
        markConnected: Boolean = false,
        nowMs: Long = System.currentTimeMillis(),
    ): TrustedHostRecord {
        require(hostPublicKey.size == Curve25519.KEY_BYTES) {
            "hostPublicKey must be ${Curve25519.KEY_BYTES} bytes"
        }
        val fingerprint = CryptoUtils.sha256Hex(hostPublicKey)
        val pubHex = CryptoUtils.toHex(hostPublicKey)
        val map = readMapLocked()
        val existing = map[fingerprint]

        val resolvedLabel = label?.trim()?.takeIf { it.isNotEmpty() }
            ?: existing?.label
            ?: "Host ${fingerprint.take(10)}"

        val next = TrustedHostRecord(
            hostFingerprint = fingerprint,
            hostPublicKeyHex = pubHex,
            label = resolvedLabel,
            lanUrl = lanUrl?.trim()?.takeIf { it.isNotEmpty() } ?: existing?.lanUrl,
            signalingUrl = signalingUrl?.trim()?.takeIf { it.isNotEmpty() } ?: existing?.signalingUrl,
            signalingRoomId = signalingRoomId?.trim()?.takeIf { it.isNotEmpty() } ?: existing?.signalingRoomId,
            stunUrls = if (stunUrls.isNotEmpty()) stunUrls.toList() else (existing?.stunUrls ?: emptyList()),
            relayUrl = relayUrl?.trim()?.takeIf { it.isNotEmpty() } ?: existing?.relayUrl,
            relayRoomId = relayRoomId?.trim()?.takeIf { it.isNotEmpty() } ?: existing?.relayRoomId,
            pairedAtMs = existing?.pairedAtMs ?: nowMs,
            lastConnectedAtMs = if (markConnected) nowMs else existing?.lastConnectedAtMs,
            revokedAtMs = if (markConnected) null else existing?.revokedAtMs,
            revokedReason = if (markConnected) null else existing?.revokedReason,
        )
        map[fingerprint] = next
        writeMapLocked(map)
        return next
    }

    /**
     * Refreshes only the `lanUrl` (and display label) of an already-trusted Host matched
     * by [hostFingerprint]. Returns null for unknown/unpaired or revoked Hosts so mDNS
     * discovery alone can never establish trust (`discovery !== trust`).
     */
    @Synchronized
    fun updateLanFromDiscovery(
        hostFingerprint: String,
        lanUrl: String,
        displayLabel: String? = null,
    ): TrustedHostRecord? {
        val fp = hostFingerprint.trim().lowercase()
        if (fp.isEmpty() || lanUrl.isBlank()) return null
        val map = readMapLocked()
        val existing = map[fp] ?: return null
        if (existing.isRevoked) return null

        val updated = existing.copy(
            lanUrl = lanUrl.trim(),
            label = displayLabel?.trim()?.takeIf { it.isNotEmpty() } ?: existing.label,
        )
        map[fp] = updated
        writeMapLocked(map)
        return updated
    }

    @Synchronized
    fun markRevoked(
        hostFingerprint: String,
        reason: String? = null,
        nowMs: Long = System.currentTimeMillis(),
    ): TrustedHostRecord? {
        val fp = hostFingerprint.trim().lowercase()
        if (fp.isEmpty()) return null
        val map = readMapLocked()
        val existing = map[fp] ?: return null
        val updated = existing.copy(
            revokedAtMs = existing.revokedAtMs ?: nowMs,
            revokedReason = reason?.trim()?.takeIf { it.isNotEmpty() } ?: existing.revokedReason ?: "device revoked by host",
        )
        map[fp] = updated
        writeMapLocked(map)
        return updated
    }

    @Synchronized
    fun forget(hostFingerprint: String): Boolean {
        val fp = hostFingerprint.trim().lowercase()
        if (fp.isEmpty()) return false
        val map = readMapLocked()
        map.remove(fp) ?: return false
        writeMapLocked(map)
        return true
    }

    @Synchronized
    fun clearAll() {
        if (storeFile.exists()) {
            storeFile.delete()
        }
        masterCipher.deleteMasterKey()
    }

    private fun readMapLocked(): LinkedHashMap<String, TrustedHostRecord> {
        if (!storeFile.exists()) return LinkedHashMap()
        val wrapped = storeFile.readBytes()
        if (wrapped.isEmpty()) return LinkedHashMap()

        val plain = masterCipher.unwrap(wrapped, AAD)
        try {
            val jsonText = String(plain, StandardCharsets.UTF_8)
            val root = JsonCodec.parseObject(jsonText)
            val version = root.intVal("version")
                ?: throw SecurityException("trusted host store missing version")
            if (version != SCHEMA_VERSION) {
                throw SecurityException("unsupported trusted host store version: $version")
            }
            val arr = root.arr("hosts") ?: return LinkedHashMap()
            val out = LinkedHashMap<String, TrustedHostRecord>()
            for (item in arr.items) {
                val obj = item as? JsonObject
                    ?: throw SecurityException("trusted host entry must be JSON object")
                val pubHex = obj.str("hostPublicKeyHex")
                    ?: throw SecurityException("trusted host missing hostPublicKeyHex")
                val pubBytes = CryptoUtils.fromHex(pubHex)
                if (pubBytes.size != Curve25519.KEY_BYTES) {
                    throw SecurityException("trusted host invalid key length: ${pubBytes.size}")
                }
                val derivedFp = CryptoUtils.sha256Hex(pubBytes)
                val storedFp = (obj.str("hostFingerprint") ?: derivedFp).lowercase()
                if (storedFp != derivedFp) {
                    throw SecurityException("trusted host fingerprint mismatch for $storedFp")
                }
                val stunList = obj.arr("stunUrls")?.items
                    ?.mapNotNull { (it as? JsonString)?.value }
                    ?: emptyList()
                val rec = TrustedHostRecord(
                    hostFingerprint = derivedFp,
                    hostPublicKeyHex = CryptoUtils.toHex(pubBytes),
                    label = obj.str("label") ?: "Host ${derivedFp.take(10)}",
                    lanUrl = obj.str("lanUrl"),
                    signalingUrl = obj.str("signalingUrl"),
                    signalingRoomId = obj.str("signalingRoomId"),
                    stunUrls = stunList,
                    relayUrl = obj.str("relayUrl"),
                    relayRoomId = obj.str("relayRoomId"),
                    pairedAtMs = obj.longVal("pairedAtMs")
                        ?: throw SecurityException("trusted host missing pairedAtMs"),
                    lastConnectedAtMs = obj.longVal("lastConnectedAtMs"),
                    revokedAtMs = obj.longVal("revokedAtMs"),
                    revokedReason = obj.str("revokedReason"),
                )
                out[derivedFp] = rec
            }
            return out
        } finally {
            CryptoUtils.zeroize(plain)
        }
    }

    private fun writeMapLocked(hosts: Map<String, TrustedHostRecord>) {
        val items = hosts.values.map { rec ->
            JsonObject.of(
                "hostFingerprint" to JsonString(rec.hostFingerprint),
                "hostPublicKeyHex" to JsonString(rec.hostPublicKeyHex),
                "label" to JsonString(rec.label),
                "lanUrl" to rec.lanUrl?.let { JsonString(it) },
                "signalingUrl" to rec.signalingUrl?.let { JsonString(it) },
                "signalingRoomId" to rec.signalingRoomId?.let { JsonString(it) },
                "stunUrls" to if (rec.stunUrls.isNotEmpty()) JsonArray(rec.stunUrls.map(::JsonString)) else null,
                "relayUrl" to rec.relayUrl?.let { JsonString(it) },
                "relayRoomId" to rec.relayRoomId?.let { JsonString(it) },
                "pairedAtMs" to JsonNumber(rec.pairedAtMs),
                "lastConnectedAtMs" to rec.lastConnectedAtMs?.let { JsonNumber(it) },
                "revokedAtMs" to rec.revokedAtMs?.let { JsonNumber(it) },
                "revokedReason" to rec.revokedReason?.let { JsonString(it) },
            )
        }
        val payload = JsonObject.of(
            "version" to JsonNumber(SCHEMA_VERSION),
            "hosts" to JsonArray(items),
        ).stringify()
        val plain = payload.toByteArray(StandardCharsets.UTF_8)
        val wrapped = try {
            masterCipher.wrap(plain, AAD)
        } finally {
            CryptoUtils.zeroize(plain)
        }
        writeEncryptedBlobAtomically(storageDir, storeFile, wrapped)
    }
}
