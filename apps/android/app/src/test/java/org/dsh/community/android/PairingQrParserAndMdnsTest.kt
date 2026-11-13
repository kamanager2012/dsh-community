package org.dsh.community.android

import org.dsh.community.android.crypto.CryptoUtils
import org.dsh.community.android.crypto.Curve25519
import org.dsh.community.android.transport.LanMdnsSanitizer
import org.dsh.community.android.transport.PairingQrParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.nio.charset.StandardCharsets

class PairingQrParserAndMdnsTest {
    @Test
    fun validatesBootstrapDescriptorAndRejectsSecretsOrMismatchedFingerprint() {
        val hostKeys = Curve25519.generateKeyPair()
        val pubHex = CryptoUtils.toHex(hostKeys.publicKey)
        val fp = CryptoUtils.sha256Hex(hostKeys.publicKey)

        val validJson = """
            {
              "protocolVersion": 1,
              "hostPublicKeyHex": "$pubHex",
              "hostFingerprint": "$fp",
              "bootstrapToken": "tok-abc-123",
              "endpointUrl": "ws://192.168.1.10:8443",
              "expiresAt": 1999999999999,
              "signalingUrl": "wss://signal.example.org/ws",
              "signalingRoomId": "room_12345678",
              "stunUrls": ["stun:stun.example.org:3478"],
              "relayUrl": "wss://relay.example.org/ws",
              "relayRoomId": "room_12345678"
            }
        """.trimIndent()

        val parsed = PairingQrParser.parse(validJson)
        assertEquals(fp, parsed.hostFingerprint)
        assertEquals("ws://192.168.1.10:8443", parsed.endpointUrl)
        assertEquals("wss://relay.example.org/ws", parsed.relayUrl)

        // Forbidden credential/session fields must fail closed even when nested
        val withForbidden = """
            {
              "protocolVersion": 1,
              "hostPublicKeyHex": "$pubHex",
              "hostFingerprint": "$fp",
              "bootstrapToken": "tok-abc-123",
              "endpointUrl": "ws://192.168.1.10:8443",
              "expiresAt": 1999999999999,
              "extra": { "sessionId": "s-leak" }
            }
        """.trimIndent()
        assertThrows(SecurityException::class.java) {
            PairingQrParser.parse(withForbidden)
        }

        // Fingerprint mismatch must fail closed
        val badFp = validJson.replace(fp, "0".repeat(64))
        assertThrows(SecurityException::class.java) {
            PairingQrParser.parse(badFp)
        }
    }

    @Test
    fun mdnsSanitizerBlocksForbiddenSecretKeys() {
        val clean = LanMdnsSanitizer.toDiscoveredHost(
            serviceName = "workstation",
            hostAddress = "192.168.1.50",
            port = 8443,
            rawAttributes = mapOf(
                "hostFingerprint" to "abcd".toByteArray(StandardCharsets.UTF_8),
                "hostDisplayLabel" to "Workstation".toByteArray(StandardCharsets.UTF_8),
                "protocolVersion" to "1".toByteArray(StandardCharsets.UTF_8),
            ),
        )
        assertEquals("ws://192.168.1.50:8443", clean.endpointUrl)
        assertEquals("abcd", clean.hostFingerprint)

        assertThrows(SecurityException::class.java) {
            LanMdnsSanitizer.toDiscoveredHost(
                serviceName = "evil",
                hostAddress = "192.168.1.99",
                port = 8443,
                rawAttributes = mapOf("bootstrapToken" to "leak".toByteArray(StandardCharsets.UTF_8)),
            )
        }
    }
}
