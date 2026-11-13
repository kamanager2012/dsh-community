package org.dsh.community.android.transport

import org.dsh.community.android.crypto.CryptoUtils
import org.dsh.community.android.protocol.JsonArray
import org.dsh.community.android.protocol.JsonCodec
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.JsonString
import org.dsh.community.android.protocol.JsonValue
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.Base64

data class PairingBootstrapDescriptor(
    val protocolVersion: Int,
    val hostPublicKeyHex: String,
    val hostFingerprint: String,
    val bootstrapToken: String,
    val endpointUrl: String,
    val expiresAt: Long,
    val signalingUrl: String? = null,
    val signalingRoomId: String? = null,
    val stunUrls: List<String>? = null,
    val relayUrl: String? = null,
    val relayRoomId: String? = null,
) {
    val hostPublicKeyBytes: ByteArray
        get() = CryptoUtils.fromHex(hostPublicKeyHex)
}

/**
 * Parses and validates Host QR / deep-link pairing descriptors matching `pairing-qr.ts`.
 * Fails closed if credentials, secrets, session IDs, prompts, or mismatched key fingerprints appear.
 */
object PairingQrParser {
    private val FORBIDDEN_QR_FIELDS = listOf(
        "session",
        "sessionid",
        "prompt",
        "credential",
        "credentials",
        "secret",
        "secretkey",
        "privatekey",
        "password",
        "tokensecret",
    )

    private val HEX_64_RE = Regex("^[0-9a-fA-F]{64}$")
    private val ROOM_ID_RE = Regex("^[a-zA-Z0-9_-]{8,128}$")
    private val STUN_URL_RE = Regex("^stun:[^\\s]+$", RegexOption.IGNORE_CASE)
    const val DEEP_LINK_PREFIX = "dsh-remote://pair"
    private const val MAX_PAIRING_INPUT_CHARS = 32_768

    fun parseInput(rawInput: String): PairingBootstrapDescriptor = parse(rawInput)

    fun encodeDeepLink(rawJson: String): String {
        parseJsonDescriptor(rawJson)
        val encoded = Base64.getUrlEncoder()
            .withoutPadding()
            .encodeToString(rawJson.trim().toByteArray(StandardCharsets.UTF_8))
        return "$DEEP_LINK_PREFIX?data=$encoded"
    }

    fun parse(rawInput: String): PairingBootstrapDescriptor {
        val trimmed = rawInput.trim()
        if (trimmed.isEmpty()) {
            throw IllegalArgumentException("empty pairing input")
        }
        if (trimmed.length > MAX_PAIRING_INPUT_CHARS) {
            throw IllegalArgumentException("pairing input exceeds max size")
        }
        if (trimmed.startsWith("dsh-remote://", ignoreCase = true)) {
            val uri = try {
                URI(trimmed)
            } catch (e: Exception) {
                throw IllegalArgumentException("invalid dsh-remote pairing URI: ${e.message}", e)
            }
            if (!"dsh-remote".equals(uri.scheme, ignoreCase = true)) {
                throw IllegalArgumentException("unsupported pairing URI scheme")
            }
            val host = uri.host ?: ""
            val path = uri.path ?: ""
            if (host != "pair" && path != "/pair") {
                throw IllegalArgumentException("unsupported dsh-remote action")
            }
            val params = parseQueryParams(uri.rawQuery)
            val base64Data = params["data"]
            if (!base64Data.isNullOrEmpty()) {
                val decodedBytes = try {
                    Base64.getUrlDecoder().decode(base64Data)
                } catch (e: IllegalArgumentException) {
                    throw IllegalArgumentException("invalid base64url payload in dsh-remote URI", e)
                }
                val jsonText = String(decodedBytes, StandardCharsets.UTF_8)
                return parseJsonDescriptor(jsonText)
            }
            val descriptorParam = params["descriptor"]
            if (!descriptorParam.isNullOrEmpty()) {
                return parseJsonDescriptor(descriptorParam)
            }
            throw IllegalArgumentException("missing data parameter in dsh-remote pairing URI")
        }
        return parseJsonDescriptor(trimmed)
    }

    private fun parseQueryParams(rawQuery: String?): Map<String, String> {
        if (rawQuery.isNullOrEmpty()) return emptyMap()
        val result = LinkedHashMap<String, String>()
        for (part in rawQuery.split('&')) {
            if (part.isEmpty()) continue
            val eqIdx = part.indexOf('=')
            val keyRaw = if (eqIdx >= 0) part.substring(0, eqIdx) else part
            val valRaw = if (eqIdx >= 0) part.substring(eqIdx + 1) else ""
            val key = URLDecoder.decode(keyRaw, StandardCharsets.UTF_8.name())
            val value = URLDecoder.decode(valRaw, StandardCharsets.UTF_8.name())
            result[key] = value
        }
        return result
    }

    private fun parseJsonDescriptor(rawJson: String): PairingBootstrapDescriptor {
        val root = JsonCodec.parseObject(rawJson)
        assertNoSessionOrCredentials(root)

        val protocolVersion = root.intVal("protocolVersion")
            ?: throw IllegalArgumentException("invalid protocolVersion in descriptor")
        if (protocolVersion < 1) {
            throw IllegalArgumentException("protocolVersion must be >= 1")
        }

        val hostPublicKeyHex = root.str("hostPublicKeyHex")
            ?: throw IllegalArgumentException("missing hostPublicKeyHex in descriptor")
        if (!HEX_64_RE.matches(hostPublicKeyHex)) {
            throw IllegalArgumentException("invalid hostPublicKeyHex in descriptor")
        }

        val hostFingerprint = root.str("hostFingerprint")
            ?: throw IllegalArgumentException("missing hostFingerprint in descriptor")
        if (!HEX_64_RE.matches(hostFingerprint)) {
            throw IllegalArgumentException("invalid hostFingerprint in descriptor")
        }

        val expectedFingerprint = CryptoUtils.sha256Hex(CryptoUtils.fromHex(hostPublicKeyHex))
        if (!expectedFingerprint.equals(hostFingerprint, ignoreCase = false)) {
            throw SecurityException("hostFingerprint does not match hostPublicKeyHex")
        }

        val bootstrapToken = root.str("bootstrapToken")
        if (bootstrapToken.isNullOrEmpty()) {
            throw IllegalArgumentException("invalid bootstrapToken in descriptor")
        }

        val endpointUrl = root.str("endpointUrl")
        if (endpointUrl == null || (!endpointUrl.startsWith("ws://") && !endpointUrl.startsWith("wss://"))) {
            throw IllegalArgumentException("invalid endpointUrl in descriptor")
        }

        val expiresAt = root.longVal("expiresAt")
            ?: throw IllegalArgumentException("invalid expiresAt in descriptor")
        if (expiresAt <= 0L) {
            throw IllegalArgumentException("expiresAt must be positive")
        }

        val signalingUrl = root.str("signalingUrl")?.also {
            if (!it.startsWith("ws://") && !it.startsWith("wss://")) {
                throw IllegalArgumentException("invalid signalingUrl in descriptor")
            }
        }
        val signalingRoomId = root.str("signalingRoomId")?.also {
            if (!ROOM_ID_RE.matches(it)) {
                throw IllegalArgumentException("invalid signalingRoomId in descriptor")
            }
        }

        val stunUrls = root.fields["stunUrls"]?.let { value ->
            val arr = value as? JsonArray
                ?: throw IllegalArgumentException("stunUrls must be a JSON array")
            arr.items.map { elem ->
                val s = (elem as? JsonString)?.value
                    ?: throw IllegalArgumentException("stunUrls element must be string")
                if (!STUN_URL_RE.matches(s)) {
                    throw IllegalArgumentException("invalid stunUrls entry in descriptor")
                }
                s
            }
        }

        val relayUrl = root.str("relayUrl")?.also {
            if (!it.startsWith("ws://") && !it.startsWith("wss://")) {
                throw IllegalArgumentException("invalid relayUrl in descriptor")
            }
        }
        val relayRoomId = root.str("relayRoomId")?.also {
            if (!ROOM_ID_RE.matches(it)) {
                throw IllegalArgumentException("invalid relayRoomId in descriptor")
            }
        }

        return PairingBootstrapDescriptor(
            protocolVersion = protocolVersion,
            hostPublicKeyHex = hostPublicKeyHex,
            hostFingerprint = hostFingerprint,
            bootstrapToken = bootstrapToken,
            endpointUrl = endpointUrl,
            expiresAt = expiresAt,
            signalingUrl = signalingUrl,
            signalingRoomId = signalingRoomId,
            stunUrls = stunUrls,
            relayUrl = relayUrl,
            relayRoomId = relayRoomId,
        )
    }

    private fun assertNoSessionOrCredentials(value: JsonValue) {
        when (value) {
            is JsonObject -> {
                for ((key, nested) in value.fields) {
                    val lower = key.lowercase()
                    for (forbidden in FORBIDDEN_QR_FIELDS) {
                        if (lower == forbidden || lower.contains(forbidden)) {
                            throw SecurityException(
                                "pairing bootstrap descriptor must never contain session or credential field: '$key'",
                            )
                        }
                    }
                    assertNoSessionOrCredentials(nested)
                }
            }
            is JsonArray -> {
                for (item in value.items) {
                    assertNoSessionOrCredentials(item)
                }
            }
            else -> Unit
        }
    }
}
