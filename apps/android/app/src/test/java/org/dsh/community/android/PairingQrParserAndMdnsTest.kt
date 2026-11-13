package org.dsh.community.android

import org.dsh.community.android.crypto.CryptoUtils
import org.dsh.community.android.crypto.Curve25519
import org.dsh.community.android.transport.LanMdnsSanitizer
import org.dsh.community.android.transport.PairingInputHelper
import org.dsh.community.android.transport.PairingQrParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.Base64

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

        // Deep-link dsh-remote://pair?data=<base64url> and ?descriptor=... must roundtrip
        val deepLink = PairingQrParser.encodeDeepLink(validJson)
        val parsedLink = PairingQrParser.parseInput(deepLink)
        assertEquals(fp, parsedLink.hostFingerprint)
        assertEquals("ws://192.168.1.10:8443", parsedLink.endpointUrl)
        assertEquals("wss://relay.example.org/ws", parsedLink.relayUrl)

        val queryDescriptor = "dsh-remote://pair?descriptor=" +
            URLEncoder.encode(validJson, StandardCharsets.UTF_8.name())
        val parsedQuery = PairingQrParser.parse(queryDescriptor)
        assertEquals("tok-abc-123", parsedQuery.bootstrapToken)

        // Forbidden fields hidden inside deep-link base64url payload must fail closed
        val badLinkData = Base64.getUrlEncoder()
            .withoutPadding()
            .encodeToString(withForbidden.toByteArray(StandardCharsets.UTF_8))
        assertThrows(SecurityException::class.java) {
            PairingQrParser.parseInput("dsh-remote://pair?data=$badLinkData")
        }

        // Wrong action or missing payload must fail closed
        assertThrows(IllegalArgumentException::class.java) {
            PairingQrParser.parseInput("dsh-remote://exec?data=$badLinkData")
        }
        assertThrows(IllegalArgumentException::class.java) {
            PairingQrParser.parseInput("dsh-remote://pair")
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

    @Test
    fun pairingInputHelperExtractsFromShareTextClipboardAndIntents() {
        val sampleUri = "dsh-remote://pair?data=eyJwcm90b2NvbFZlcnNpb24iOjF9"
        assertEquals(
            sampleUri,
            PairingInputHelper.extractPairingPayload("Scan or tap: $sampleUri."),
        )
        assertEquals(
            "{\"protocolVersion\":1}",
            PairingInputHelper.extractPairingPayload("  {\"protocolVersion\":1}  "),
        )
        assertEquals(null, PairingInputHelper.extractPairingPayload("hello world"))
        assertEquals(null, PairingInputHelper.extractPairingPayload("   "))

        assertEquals(
            sampleUri,
            PairingInputHelper.extractFromIntent(
                PairingInputHelper.ACTION_VIEW_NAME,
                sampleUri,
                null,
            ),
        )
        assertEquals(
            null,
            PairingInputHelper.extractFromIntent(
                PairingInputHelper.ACTION_VIEW_NAME,
                "https://example.com/pair",
                null,
            ),
        )
        assertEquals(
            sampleUri,
            PairingInputHelper.extractFromIntent(
                PairingInputHelper.ACTION_SEND_NAME,
                null,
                "Pair with Host\n$sampleUri",
            ),
        )
        assertEquals(
            "Connected via webrtc (epoch 3)",
            PairingInputHelper.resolveForegroundNotificationText(
                hasActiveSession = true,
                currentStatus = "Connected via webrtc (epoch 3)",
                startCount = 2,
            ),
        )
        assertEquals(
            "Idle (2 starts)",
            PairingInputHelper.resolveForegroundNotificationText(
                hasActiveSession = false,
                currentStatus = "Connected via webrtc (epoch 3)",
                startCount = 2,
            ),
        )
    }

    @Test
    fun mdnsSanitizerSupportsCompactHostTxtKeysAndBracketsIpv6() {
        val compact = LanMdnsSanitizer.toDiscoveredHost(
            serviceName = "workstation-fp",
            hostAddress = "fe80::1a2b:3c4d%wlan0",
            port = 8443,
            rawAttributes = mapOf(
                "fp" to "deadbeef".toByteArray(StandardCharsets.UTF_8),
                "v" to "2".toByteArray(StandardCharsets.UTF_8),
            ),
        )
        assertEquals("deadbeef", compact.hostFingerprint)
        assertEquals(2, compact.protocolVersion)
        assertEquals("ws://[fe80::1a2b:3c4d]:8443", compact.endpointUrl)
        assertEquals("ws://192.168.1.50:8443", LanMdnsSanitizer.formatEndpointUrl("192.168.1.50", 8443))
    }
}
