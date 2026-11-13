package org.dsh.community.android

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.Uri
import android.os.IBinder
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.dsh.community.android.crypto.CryptoUtils
import org.dsh.community.android.crypto.Curve25519
import org.dsh.community.android.crypto.EncryptedDeviceIdentityStore
import org.dsh.community.android.protocol.AttachResumeResult
import org.dsh.community.android.protocol.JsonCodec
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.JsonString
import org.dsh.community.android.protocol.OfficialSessionEvent
import org.dsh.community.android.service.RemoteSessionService
import org.dsh.community.android.transport.FailoverRemoteSession
import org.dsh.community.android.transport.PairingQrParser
import org.dsh.community.android.transport.RemoteConnectionPhase
import org.dsh.community.android.transport.RemoteEndpointProfile
import org.dsh.community.android.transport.TransportKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class RemoteClientInstrumentationTest {

    @Test
    fun androidKeyStorePersistsWrappedIdentityAndSupportsEcKeyGenInNoBackupDir() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val store = EncryptedDeviceIdentityStore.createForAndroid(context)

        val created = store.resetIdentity()
        assertEquals(64, created.deviceId.length)
        assertEquals(64, created.publicKeyHex.length)
        assertTrue(
            "expected hardware/TEE AndroidKeyStore backing, got ${created.backing}",
            created.backing.startsWith("android-keystore-"),
        )

        val identityFile = File(context.noBackupFilesDir, "dsh_remote_identity_v1.bin")
        assertTrue("wrapped identity must exist in noBackupFilesDir", identityFile.exists())
        assertFalse(
            "wrapped identity must not be placed in cloud-backed filesDir",
            File(context.filesDir, "dsh_remote_identity_v1.bin").exists(),
        )
        assertFalse(
            "raw secret key bytes must never be stored in plaintext",
            identityFile.readBytes().let { raw ->
                raw.size >= 45 && raw.copyOfRange(13, 45).contentEquals(created.keyPair.secretKey)
            },
        )

        val reloaded = store.loadOrCreate()
        assertEquals(created.deviceId, reloaded.deviceId)
        assertEquals(created.publicKeyHex, reloaded.publicKeyHex)

        // Verify real OS AndroidKeyStore EC KeyGen + signing works on this runtime
        val ecAlias = "dsh_instr_ec_probe_v1"
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (ks.containsAlias(ecAlias)) ks.deleteEntry(ecAlias)
        val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        kpg.initialize(
            KeyGenParameterSpec.Builder(
                ecAlias,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
            )
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build(),
        )
        val ecPair = kpg.generateKeyPair()
        val payload = "r6-keystore-ec-probe".toByteArray(StandardCharsets.UTF_8)
        val sig = Signature.getInstance("SHA256withECDSA").run {
            initSign(ecPair.private)
            update(payload)
            sign()
        }
        val verifier = Signature.getInstance("SHA256withECDSA").apply {
            initVerify(ecPair.public)
            update(payload)
        }
        assertTrue("ECDSA AndroidKeyStore signature must verify", verifier.verify(sig))
        ks.deleteEntry(ecAlias)

        val rotated = store.resetIdentity()
        assertNotEquals(created.deviceId, rotated.deviceId)
    }

    @Test
    fun remoteSessionServiceRunsDataSyncForegroundAndPersistsStats() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val serviceRef = AtomicReference<RemoteSessionService?>()
        val bindLatch = CountDownLatch(1)

        val conn = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
                val svc = (binder as RemoteSessionService.LocalBinder).getService()
                serviceRef.set(svc)
                bindLatch.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                serviceRef.set(null)
            }
        }

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            context.bindService(
                Intent(context, RemoteSessionService::class.java),
                conn,
                Context.BIND_AUTO_CREATE,
            )
            try {
                assertTrue("RemoteSessionService did not bind in time", bindLatch.await(10, TimeUnit.SECONDS))
                val svc = serviceRef.get()
                assertNotNull(svc)
                svc!!

                val identity = svc.currentIdentity()
                assertEquals(64, identity.deviceId.length)
                assertTrue(identity.backing.startsWith("android-keystore-"))

                // Wait briefly for onStartCommand from MainActivity to persist initial stats
                val deadline = System.currentTimeMillis() + 5_000L
                while (System.currentTimeMillis() < deadline && !svc.currentStatsFile().exists()) {
                    Thread.sleep(50)
                }

                val stats = svc.currentStats()
                assertTrue("serviceStartCount must be >= 1", stats.serviceStartCount >= 1)
                assertTrue("stats file must persist in noBackupFilesDir", svc.currentStatsFile().exists())
                assertEquals(context.noBackupFilesDir.absolutePath, svc.currentStatsFile().parentFile?.absolutePath)

                val parsedStats = JsonCodec.parseObject(svc.currentStatsFile().readText())
                assertTrue((parsedStats.intVal("serviceStartCount") ?: 0) >= 1)

                scenario.onActivity { activity ->
                    val statusText = activity.findViewById<TextView>(R.id.tv_status).text.toString()
                    val deviceText = activity.findViewById<TextView>(R.id.tv_device_id).text.toString()
                    assertTrue(statusText.isNotEmpty())
                    assertTrue(deviceText.contains(identity.deviceId))
                }
            } finally {
                context.unbindService(conn)
            }
        }
    }

    @Test
    fun deepLinkParserValidatesDshRemoteUriAndActivityRejectsForbiddenPayloads() {
        val hostKeys = Curve25519.generateKeyPair()
        val pubHex = CryptoUtils.toHex(hostKeys.publicKey)
        val fp = CryptoUtils.sha256Hex(hostKeys.publicKey)
        val validJson = JsonObject.of(
            "protocolVersion" to org.dsh.community.android.protocol.JsonNumber(1),
            "hostPublicKeyHex" to JsonString(pubHex),
            "hostFingerprint" to JsonString(fp),
            "bootstrapToken" to JsonString("tok-r6-instr-123456"),
            "endpointUrl" to JsonString("ws://127.0.0.1:8443"),
            "expiresAt" to org.dsh.community.android.protocol.JsonNumber(1999999999999L),
        ).stringify()

        val deepLink = PairingQrParser.encodeDeepLink(validJson)
        val parsed = PairingQrParser.parseInput(deepLink)
        assertEquals(fp, parsed.hostFingerprint)
        assertEquals("ws://127.0.0.1:8443", parsed.endpointUrl)

        val leakedJson = JsonObject.of(
            "protocolVersion" to org.dsh.community.android.protocol.JsonNumber(1),
            "hostPublicKeyHex" to JsonString(pubHex),
            "hostFingerprint" to JsonString(fp),
            "bootstrapToken" to JsonString("tok-r6-instr-123456"),
            "endpointUrl" to JsonString("ws://127.0.0.1:8443"),
            "expiresAt" to org.dsh.community.android.protocol.JsonNumber(1999999999999L),
            "sessionId" to JsonString("leak-forbidden"),
        ).stringify()
        val badLink = "dsh-remote://pair?descriptor=" + java.net.URLEncoder.encode(leakedJson, "UTF-8")
        assertThrows(SecurityException::class.java) {
            PairingQrParser.parseInput(badLink)
        }

        val badIntent = Intent(Intent.ACTION_VIEW, Uri.parse(badLink)).apply {
            setClass(InstrumentationRegistry.getInstrumentation().targetContext, MainActivity::class.java)
        }
        ActivityScenario.launch<MainActivity>(badIntent).use { scenario ->
            scenario.onActivity { activity ->
                val statusText = activity.findViewById<TextView>(R.id.tv_status).text.toString()
                assertTrue("expected REJECTED banner on forbidden deep link, got: $statusText", statusText.contains("REJECTED"))
                val inputVal = activity.findViewById<EditText>(R.id.et_pairing_json).text.toString()
                assertFalse("rejected deep link must not populate et_pairing_json", inputVal.contains("leak-forbidden"))
            }
        }
    }

    @Test
    fun liveOfficialHostRoundTripViaAdbReverseWhenArgsSupplied() {
        val args = InstrumentationRegistry.getArguments()
        val requireLive = args.getString("dshRequireLiveInterop") == "1"
        val pairingInput = args.getString("dshPairingInput")?.trim().orEmpty()
        if (!requireLive && pairingInput.isEmpty()) {
            assumeTrue("dshPairingInput not supplied; run scripts/accept-android-r6-device.mjs", false)
            return
        }
        assertFalse("dshPairingInput must be provided when dshRequireLiveInterop=1", pairingInput.isEmpty())

        val controlUrl = args.getString("dshControlUrl")?.trim().orEmpty()
        val controlToken = args.getString("dshControlToken")?.trim().orEmpty()
        val explicitSessionId = args.getString("dshSessionId")?.trim().orEmpty()

        val descriptor = PairingQrParser.parseInput(pairingInput)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val identity = EncryptedDeviceIdentityStore.createForAndroid(context).loadOrCreate()
        assertTrue(identity.backing.startsWith("android-keystore-"))

        // 1) Initial connection + pairing confirmation via host control server
        val bootstrapSession = FailoverRemoteSession(identity, RemoteEndpointProfile.fromDescriptor(descriptor))
        val initialPhase = bootstrapSession.connect()
        if (initialPhase == RemoteConnectionPhase.PAIRING_PENDING) {
            assertFalse("dshControlUrl required to confirm pending pairing", controlUrl.isEmpty())
            assertFalse("dshControlToken required to confirm pending pairing", controlToken.isEmpty())
            val reqResult = bootstrapSession.requestPairing("R6-Android-Instrumentation", descriptor.bootstrapToken)
            val candidateId = reqResult.str("candidateId")
            assertFalse("candidateId must be returned by pairing.request", candidateId.isNullOrEmpty())

            val confirmStatus = postControlJson(
                url = "$controlUrl/pairing/confirm",
                token = controlToken,
                bodyJson = JsonObject.of("candidateId" to JsonString(candidateId!!)).stringify(),
            )
            assertTrue("pairing/confirm failed with HTTP ${confirmStatus.first}: ${confirmStatus.second}", confirmStatus.first in 200..299)
        } else {
            assertEquals(RemoteConnectionPhase.ACTIVE, initialPhase)
        }
        bootstrapSession.close("pairing completed")

        // 2) Reconnect paired device over Noise IK E2EE
        val active = FailoverRemoteSession(identity, RemoteEndpointProfile.fromDescriptor(descriptor))
        val approvalLatch = CountDownLatch(1)
        val approvalResolvedLatch = CountDownLatch(1)
        val assistantChunkLatch = CountDownLatch(1)
        val pendingCallIdRef = AtomicReference<String?>(null)
        val seenEvents = CopyOnWriteArrayList<OfficialSessionEvent>()
        var chunkCount = 0

        active.addListener(object : FailoverRemoteSession.Listener {
            override fun onPhaseChanged(phase: RemoteConnectionPhase, carrier: TransportKind?, epoch: Int) {}

            override fun onStreamEvent(sessionId: String, event: OfficialSessionEvent) {
                seenEvents.add(event)
                val obj = event.data as? JsonObject
                if (event.type == "approval.request") {
                    pendingCallIdRef.set(obj?.str("callId"))
                    approvalLatch.countDown()
                } else if (event.type == "approval.resolved") {
                    approvalResolvedLatch.countDown()
                } else if (event.type == "assistant/chunk" || event.type == "text-delta") {
                    chunkCount += 1
                    assistantChunkLatch.countDown()
                }
            }

            override fun onTransportClosed(carrier: TransportKind, reason: String) {}
        })

        try {
            assertEquals(RemoteConnectionPhase.ACTIVE, active.connect())
            assertTrue("host ping must succeed", active.ping())

            val sessions = active.listSessions()
            assertTrue("host must list at least one official session", sessions.isNotEmpty())
            val targetSessionId = explicitSessionId.ifEmpty { sessions.first().id }

            val attachResult = active.attachSession(targetSessionId)
            assertTrue("expected AttachResumeResult.Events", attachResult is AttachResumeResult.Events)

            val promptOpKey = active.newOperationKey("r6-prompt")
            active.submitPrompt(targetSessionId, "R6_ANDROID_INSTR_RUN_BASH", promptOpKey)

            assertTrue("did not receive approval.request over E2EE stream", approvalLatch.await(20, TimeUnit.SECONDS))
            val callId = pendingCallIdRef.get()
            assertNotNull(callId)
            val approveKey = active.newOperationKey("r6-approve")
            active.respondApproval(callId!!, approved = true, idempotencyKey = approveKey)

            assertTrue("did not observe approval.resolved event", approvalResolvedLatch.await(20, TimeUnit.SECONDS))
            assertTrue("did not observe streamed assistant/chunk event", assistantChunkLatch.await(20, TimeUnit.SECONDS))
            val lastSeq = seenEvents.maxOfOrNull { it.seq } ?: 1L
            active.ackStream(targetSessionId, lastSeq)

            // 3) Carrier failover/resume monotonicity verification (LAN -> Relay when relay configured)
            val prevEpoch = active.currentEpoch
            val targetFailoverKinds = if (!descriptor.relayUrl.isNullOrBlank()) {
                listOf(TransportKind.RELAY)
            } else {
                listOf(TransportKind.LAN, TransportKind.WEBRTC, TransportKind.RELAY)
            }
            active.failoverAndResume(targetFailoverKinds)
            assertEquals(RemoteConnectionPhase.ACTIVE, active.phase)
            if (!descriptor.relayUrl.isNullOrBlank()) {
                assertEquals(TransportKind.RELAY, active.activeCarrier)
            }
            assertTrue("connectionEpoch must increase after failoverAndResume", active.currentEpoch > prevEpoch)
            assertTrue("host ping must succeed after failover", active.ping())
            assertTrue("expected >= 1 stream events (seen=${seenEvents.size}, chunks=$chunkCount)", seenEvents.isNotEmpty())
        } finally {
            active.close("r6 instrumentation completed")
        }

        // 4) Exercise Activity launch via deep-link Intent if control server can mint a fresh token
        if (controlUrl.isNotEmpty() && controlToken.isNotEmpty()) {
            val minted = postControlJson("$controlUrl/pairing-token", controlToken, "{}")
            if (minted.first in 200..299) {
                val mintedObj = JsonCodec.parseObject(minted.second)
                val freshDeepLink = mintedObj.str("deepLink")
                if (!freshDeepLink.isNullOrBlank()) {
                    val launchIntent = Intent(Intent.ACTION_VIEW, Uri.parse(freshDeepLink)).apply {
                        setClass(context, MainActivity::class.java)
                    }
                    ActivityScenario.launch<MainActivity>(launchIntent).use { scenario ->
                        val deadline = System.currentTimeMillis() + 5_000L
                        var populated = false
                        while (System.currentTimeMillis() < deadline && !populated) {
                            scenario.onActivity { activity ->
                                val txt = activity.findViewById<EditText>(R.id.et_pairing_json).text.toString()
                                populated = txt.startsWith("dsh-remote://pair")
                            }
                            if (!populated) Thread.sleep(100)
                        }
                        assertTrue("MainActivity deep-link Intent must populate et_pairing_json", populated)
                    }
                }
            }
        }
    }

    private fun postControlJson(url: String, token: String, bodyJson: String): Pair<Int, String> {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 5_000
            readTimeout = 5_000
            doOutput = true
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Content-Type", "application/json")
        }
        conn.outputStream.use { it.write(bodyJson.toByteArray(StandardCharsets.UTF_8)) }
        val status = conn.responseCode
        val stream = if (status in 200..399) conn.inputStream else (conn.errorStream ?: conn.inputStream)
        val responseBody = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
        conn.disconnect()
        return status to responseBody
    }
}
