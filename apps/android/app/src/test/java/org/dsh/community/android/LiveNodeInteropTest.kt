package org.dsh.community.android

import org.dsh.community.android.crypto.EncryptedDeviceIdentityStore
import org.dsh.community.android.crypto.MasterKeyCipher
import org.dsh.community.android.protocol.AttachResumeResult
import org.dsh.community.android.protocol.JsonCodec
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.JsonString
import org.dsh.community.android.protocol.OfficialSessionEvent
import org.dsh.community.android.transport.FailoverRemoteSession
import org.dsh.community.android.transport.PairingQrParser
import org.dsh.community.android.transport.RemoteConnectionPhase
import org.dsh.community.android.transport.RemoteEndpointProfile
import org.dsh.community.android.transport.TransportKind
import org.dsh.community.android.ui.PromptImageHelper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.BufferedReader
import java.io.File
import java.io.IOException
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Live Kotlin-client <-> Node `RemoteHostRuntime` + `BlindRelayServer` E2EE interop test:
 *  1. Pairing bootstrap descriptor -> Noise_IK_25519_ChaChaPoly_BLAKE2b -> PAIRING_PENDING -> ACTIVE
 *  2. session.list + session.attach + live event stream + stream.ack + idempotent prompt.submit
 *  3. LAN carrier drop -> ordered fallback (LAN -> WebRTC(unavailable) -> Blind Relay) -> epoch2 > epoch1
 *  4. Re-attach resume + idempotent approval.respond dedup across reconnect + zero relay plaintext leak
 *  5. Device revoke -> reconnect rejected fail-closed
 */
class LiveNodeInteropTest {
    private class TestMasterCipher : MasterKeyCipher {
        override val backingLabel: String = "jvm-aes-gcm-interop"
        private val key: SecretKey = KeyGenerator.getInstance("AES").apply {
            init(256, SecureRandom())
        }.generateKey()

        override fun wrap(plaintext: ByteArray, aad: ByteArray): ByteArray {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, key)
            c.updateAAD(aad)
            return byteArrayOf(1) + c.iv + c.doFinal(plaintext)
        }

        override fun unwrap(wrapped: ByteArray, aad: ByteArray): ByteArray {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, wrapped.copyOfRange(1, 13)))
            c.updateAAD(aad)
            return c.doFinal(wrapped.copyOfRange(13, wrapped.size))
        }

        override fun deleteMasterKey() = Unit
    }

    private fun resolveInteropScript(): File? {
        val explicit = System.getenv("DSH_ANDROID_INTEROP_HOST_SCRIPT")
        if (!explicit.isNullOrBlank()) {
            val f = File(explicit)
            if (f.isFile) return f
        }
        val candidates = listOf(
            File("../../scripts/r5-android-interop-host.mjs"),
            File("../../../scripts/r5-android-interop-host.mjs"),
            File("scripts/r5-android-interop-host.mjs"),
        )
        return candidates.firstOrNull { it.isFile }
    }

    private fun httpJson(url: String, method: String = "GET", body: JsonObject? = null): JsonObject {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 5_000
            readTimeout = 5_000
            if (body != null) {
                doOutput = true
                setRequestProperty("content-type", "application/json")
            }
        }
        if (body != null) {
            conn.outputStream.use {
                it.write(body.stringify().toByteArray(StandardCharsets.UTF_8))
            }
        }
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val text = stream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
        check(code in 200..299) { "HTTP $code from $url: $text" }
        return JsonCodec.parseObject(text)
    }

    @Test
    fun kotlinRemoteClientInteroperatesEndToEndWithNodeHostAndBlindRelay() {
        val script = resolveInteropScript()
        val requireLive = System.getenv("DSH_ANDROID_REQUIRE_LIVE_INTEROP") == "1"
        if (!requireLive) {
            assumeTrue("r5-android-interop-host.mjs not found", script != null)
        } else {
            assertNotNull("DSH_ANDROID_REQUIRE_LIVE_INTEROP=1 but interop script missing", script)
        }

        val repoRoot = script!!.parentFile!!.parentFile!!
        val distEntry = File(repoRoot, "packages/remote-adapter/dist/index.js")
        if (!requireLive) {
            assumeTrue("remote-adapter dist not built yet", distEntry.isFile)
        } else {
            assertTrue("packages/remote-adapter/dist/index.js must be built", distEntry.isFile)
        }

        val proc = ProcessBuilder("node", script.absolutePath)
            .directory(repoRoot)
            .redirectError(ProcessBuilder.Redirect.INHERIT)
            .start()

        val identityDir = Files.createTempDirectory("dsh-r5-interop-id-").toFile()
        var controlUrl: String? = null
        try {
            val reader = BufferedReader(InputStreamReader(proc.inputStream, StandardCharsets.UTF_8))
            val readyLine = reader.readLine()
                ?: throw AssertionError("interop Node host exited before printing READY")
            assertTrue("unexpected READY line: $readyLine", readyLine.startsWith("READY "))
            val ready = JsonCodec.parseObject(readyLine.removePrefix("READY ").trim())
            controlUrl = ready.str("controlUrl")!!
            val sessionId = ready.str("sessionId")!!
            val promptMarker = ready.str("promptMarker")!!
            val pairingJson = ready.str("pairingJson")!!

            val descriptor = PairingQrParser.parse(pairingJson)
            val identity = EncryptedDeviceIdentityStore(identityDir, TestMasterCipher()).loadOrCreate()
            val profile = RemoteEndpointProfile.fromDescriptor(descriptor)

            val session = FailoverRemoteSession(identity, profile)

            // 1. Connect on LAN -> PAIRING_PENDING -> request pairing
            assertEquals(RemoteConnectionPhase.PAIRING_PENDING, session.connect(listOf(TransportKind.LAN)))
            assertEquals(TransportKind.LAN, session.activeCarrier)
            val epoch0 = session.currentEpoch
            assertTrue(epoch0 >= 1)

            val pairResult = session.requestPairing("Pixel-CI-Test")
            val candidateId = pairResult.str("candidateId")!!

            // Confirm pairing on Host control channel
            httpJson(
                "$controlUrl/confirm-pairing",
                method = "POST",
                body = JsonObject.of("candidateId" to JsonString(candidateId)),
            )

            // Reconnect on LAN -> now ACTIVE with advancing epoch
            session.close("re-auth after pairing confirmation")
            val epochGuardProfile = profile.copy(bootstrapToken = null)
            val activeSession = FailoverRemoteSession(identity, epochGuardProfile)
            val activeEvents = CopyOnWriteArrayList<OfficialSessionEvent>()
            val pushLatch = CountDownLatch(2)
            val titleLatch = CountDownLatch(1)
            activeSession.addListener(
                object : FailoverRemoteSession.Listener {
                    override fun onStreamEvent(sid: String, event: OfficialSessionEvent) {
                        if (sid == sessionId) {
                            activeEvents.add(event)
                            pushLatch.countDown()
                            if (event.type == "session/title") {
                                titleLatch.countDown()
                            }
                        }
                    }
                },
            )

            assertEquals(RemoteConnectionPhase.ACTIVE, activeSession.connect(listOf(TransportKind.LAN)))
            assertEquals(TransportKind.LAN, activeSession.activeCarrier)
            val epoch1 = activeSession.currentEpoch
            assertTrue("epoch1 ($epoch1) must advance past epoch0 ($epoch0)", epoch1 > epoch0)
            assertTrue(activeSession.ping())

            // 2. List & attach official session, emit + ack + idempotent prompt
            val sessions = activeSession.listSessions()
            assertEquals(listOf(sessionId), sessions.map { it.id })
            val attach1 = activeSession.attachSession(sessionId)
            assertTrue(attach1 is AttachResumeResult.Events)

            val promptKey = activeSession.newOperationKey("prompt-interop")
            activeSession.submitPrompt(sessionId, promptMarker, promptKey)
            // Duplicate retry with identical idempotencyKey must not double-execute followup seam
            activeSession.submitPrompt(sessionId, promptMarker, promptKey)

            httpJson("$controlUrl/emit-event", method = "POST", body = JsonObject.of("type" to JsonString("approval.request")))
            assertTrue("did not receive streamed LAN events in time", pushLatch.await(5, TimeUnit.SECONDS))
            val lastLanSeq = activeEvents.maxOf { it.seq }
            activeSession.ackStream(sessionId, lastLanSeq)
            assertEquals(lastLanSeq, activeSession.getLastConfirmedSeq(sessionId))

            // 2b. Wave 2 RPCs over LAN: model catalog + reasoning effort + live session.rename
            val catalog = activeSession.listModels(sessionId)
            assertTrue("expected >= 2 models in catalog", catalog.models.size >= 2)
            val reasoner = catalog.models.firstOrNull { it.model == "deepseek-reasoner" }
            assertNotNull("deepseek-reasoner should be listed", reasoner)
            assertTrue("deepseek-reasoner should advertise image input", reasoner!!.supportsImageInput)
            assertEquals(131072, reasoner.contextWindow)
            assertEquals(listOf("low", "medium", "high"), reasoner.reasoningEfforts.map { it.value })

            activeSession.selectModel(sessionId, "deepseek", "deepseek-reasoner", reasoningEffort = "high")
            val renamed = activeSession.renameSession(sessionId, "Renamed R5 Live Session")
            assertEquals("Renamed R5 Live Session", renamed.title)
            assertEquals("Renamed R5 Live Session", activeSession.listSessions().first { it.id == sessionId }.title)
            assertTrue("did not receive live session/title event over LAN", titleLatch.await(3, TimeUnit.SECONDS))
            assertTrue(
                "confirmed seq should advance after model.select & session.rename events",
                (activeSession.getLastConfirmedSeq(sessionId) ?: 0L) > lastLanSeq,
            )

            // 3. Kill LAN on Host -> failover LAN(down) -> WebRTC(unattached) -> BlindRelayServer!
            httpJson("$controlUrl/drop-lan", method = "POST", body = JsonObject.of())

            val resumedMap = activeSession.failoverAndResume(
                listOf(TransportKind.LAN, TransportKind.WEBRTC, TransportKind.RELAY),
            )
            assertEquals(TransportKind.RELAY, activeSession.activeCarrier)
            val epoch2 = activeSession.currentEpoch
            assertTrue("epoch2 ($epoch2) must advance past epoch1 ($epoch1)", epoch2 > epoch1)
            assertTrue(resumedMap[sessionId] is AttachResumeResult.Events)
            // Verify ordered fallback errors recorded LAN and WebRTC before Relay succeeded
            assertEquals(listOf(TransportKind.LAN, TransportKind.WEBRTC), activeSession.attemptErrors.map { it.kind })

            // 4. Approve + multimodal image prompt over Blind Relay with idempotent retry -> approvalCalls stays 1, blind relay saw ciphertext only
            val approvalKey = activeSession.newOperationKey("approval-interop")
            activeSession.respondApproval("call-r5-1", approved = true, idempotencyKey = approvalKey)
            activeSession.respondApproval("call-r5-1", approved = true, idempotencyKey = approvalKey)

            val imagePayload = PromptImageHelper.buildAttachment(
                mediaType = "image/jpeg",
                rawBytes = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte(), 0xFF.toByte(), 0xD9.toByte()),
                name = "cam-test.jpg",
            )
            activeSession.submitPrompt(sessionId, "", attachments = listOf(imagePayload))

            val status = httpJson("$controlUrl/status")
            assertEquals(2L, status.longVal("followupCalls"))
            assertEquals(1L, status.longVal("approvalCalls"))
            assertEquals(1L, status.longVal("renameCalls"))
            assertEquals(1L, status.longVal("modelListCalls"))
            assertEquals(1L, status.longVal("modelSelectCalls"))
            assertEquals(1L, status.longVal("lastPromptAttachments"))
            assertEquals("high", status.str("lastSelectedReasoningEffort"))
            assertEquals("Renamed R5 Live Session", status.str("sessionTitle"))
            assertTrue("relay should audit blind ciphertext frames", (status.longVal("blindFramesAudited") ?: 0L) > 0L)
            assertEquals(0L, status.longVal("plaintextLeaks"))

            // 5. Revoke Android device -> reconnect over Relay must fail closed
            httpJson(
                "$controlUrl/revoke",
                method = "POST",
                body = JsonObject.of("deviceId" to JsonString(identity.deviceId)),
            )

            val postRevoke = FailoverRemoteSession(identity, epochGuardProfile)
            assertThrows(IOException::class.java) {
                postRevoke.connect(listOf(TransportKind.RELAY))
            }

            activeSession.close("interop complete")
        } finally {
            try {
                if (controlUrl != null) httpJson("$controlUrl/shutdown", method = "POST", body = JsonObject.of())
            } catch (_: Throwable) {
            }
            proc.destroyForcibly()
            identityDir.deleteRecursively()
        }
    }
}
