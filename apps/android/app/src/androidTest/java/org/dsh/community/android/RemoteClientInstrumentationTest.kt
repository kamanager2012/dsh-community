package org.dsh.community.android

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.Uri
import android.os.IBinder
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.dsh.community.android.crypto.AndroidKeystoreMasterCipher
import org.dsh.community.android.crypto.CryptoUtils
import org.dsh.community.android.crypto.Curve25519
import org.dsh.community.android.crypto.EncryptedDeviceIdentityStore
import org.dsh.community.android.crypto.EncryptedTrustedHostStore
import org.dsh.community.android.protocol.AttachResumeResult
import org.dsh.community.android.protocol.JsonCodec
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.JsonString
import org.dsh.community.android.protocol.OfficialSessionEvent
import org.dsh.community.android.service.RemoteSessionService
import org.dsh.community.android.transport.DiscoveredLanHost
import org.dsh.community.android.transport.FailoverRemoteSession
import org.dsh.community.android.transport.PairingQrParser
import org.dsh.community.android.transport.PeerRevokedException
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

    @Test
    fun liveStage2QuestionsTrustedStoreMdnsResetDeadLanRelayAndRevocation() {
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
        val explicitSessionId = args.getString("dshSessionId")?.trim().orEmpty().ifEmpty { "r6-accept-session" }
        assertFalse("dshControlUrl required", controlUrl.isEmpty())
        assertFalse("dshControlToken required", controlToken.isEmpty())

        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val trustedStore = EncryptedTrustedHostStore.createForAndroid(context)
        trustedStore.clearAll()

        // Ensure primary hardware-backed identity is paired (independent of JUnit execution order)
        val primaryIdentity = EncryptedDeviceIdentityStore.createForAndroid(context).loadOrCreate()
        assertTrue(primaryIdentity.backing.startsWith("android-keystore-"))
        val mintedForUi = postControlJson("$controlUrl/pairing-token", controlToken, "{}")
        assertTrue("pairing-token mint failed", mintedForUi.first in 200..299)
        val freshDeepLink = JsonCodec.parseObject(mintedForUi.second).str("deepLink")!!
        val freshDescriptor = PairingQrParser.parseInput(freshDeepLink)

        val confirmIfPending = {
            val bootstrap = FailoverRemoteSession(primaryIdentity, RemoteEndpointProfile.fromDescriptor(freshDescriptor))
            try {
                if (bootstrap.connect() == RemoteConnectionPhase.PAIRING_PENDING) {
                    val req = bootstrap.requestPairing("R6-Stage2-UI", freshDescriptor.bootstrapToken)
                    val cid = req.str("candidateId")!!
                    val res = postControlJson(
                        url = "$controlUrl/pairing/confirm",
                        token = controlToken,
                        bodyJson = JsonObject.of("candidateId" to JsonString(cid)).stringify(),
                    )
                    assertTrue("pairing/confirm failed: ${res.second}", res.first in 200..299)
                }
            } finally {
                bootstrap.close("pre-ui confirm check")
            }
        }
        confirmIfPending()

        // 1) Launch MainActivity, connect via UI, verify TrustedHostStore tokenless persistence & mDNS matching,
        //    answer user-questions/request via UI, and clear/resync via stream.reset
        val launchIntent = Intent(Intent.ACTION_VIEW, Uri.parse(freshDeepLink)).apply {
            setClass(context, MainActivity::class.java)
        }
        ActivityScenario.launch<MainActivity>(launchIntent).use { scenario ->
            fun waitUntil(timeoutMs: Long, checkName: String, predicate: (MainActivity) -> Boolean) {
                val deadline = System.currentTimeMillis() + timeoutMs
                var satisfied = false
                while (System.currentTimeMillis() < deadline && !satisfied) {
                    scenario.onActivity { activity ->
                        if (predicate(activity)) {
                            satisfied = true
                        }
                    }
                    if (!satisfied) Thread.sleep(100)
                }
                assertTrue("Timed out waiting for: $checkName", satisfied)
            }

            waitUntil(15_000, "MainActivity [ACTIVE] & TrustedHostStore saved host") { activity ->
                val status = activity.findViewById<TextView>(R.id.tv_status).text.toString()
                val savedCount = activity.findViewById<LinearLayout>(R.id.ll_saved_hosts).childCount
                val firstChildIsBtn = activity.findViewById<LinearLayout>(R.id.ll_saved_hosts).getChildAt(0) is Button
                status.contains("[ACTIVE]") && savedCount >= 1 && firstChildIsBtn &&
                    trustedStore.get(freshDescriptor.hostFingerprint) != null
            }

            val savedRecord = trustedStore.get(freshDescriptor.hostFingerprint)
            assertNotNull("TrustedHostRecord must be persisted in Keystore store", savedRecord)
            assertTrue(
                "Trusted hosts file must live in noBackupFilesDir",
                File(context.noBackupFilesDir, EncryptedTrustedHostStore.TRUSTED_HOSTS_FILE_NAME).exists(),
            )

            // Verify discovery !== trust for unknown mDNS Host, and fingerprint-matched tokenless LAN refresh for saved Host
            val lanPort = Uri.parse(freshDescriptor.endpointUrl).port
            scenario.onActivity { activity ->
                activity.handleDiscoveredHostForUi(
                    DiscoveredLanHost(
                        serviceName = "untrusted-stranger",
                        hostAddress = "127.0.0.1",
                        port = 1,
                        hostFingerprint = "0".repeat(64),
                        hostDisplayLabel = "Evil Stranger",
                        protocolVersion = 1,
                        txtAttributes = emptyMap(),
                    ),
                )
            }
            waitUntil(5_000, "Unpaired mDNS chip rendered") { activity ->
                activity.findViewById<LinearLayout>(R.id.ll_discovered_hosts).getChildAt(0) is Button
            }
            scenario.onActivity { activity ->
                val chip = activity.findViewById<LinearLayout>(R.id.ll_discovered_hosts).getChildAt(0) as Button
                chip.performClick()
            }
            waitUntil(5_000, "Discovery !== trust [UNPAIRED] banner") { activity ->
                activity.findViewById<TextView>(R.id.tv_status).text.toString().contains("[UNPAIRED]")
            }

            scenario.onActivity { activity ->
                activity.handleDiscoveredHostForUi(
                    DiscoveredLanHost(
                        serviceName = "studio-host",
                        hostAddress = "127.0.0.1",
                        port = lanPort,
                        hostFingerprint = freshDescriptor.hostFingerprint,
                        hostDisplayLabel = "Matched Studio Host",
                        protocolVersion = 1,
                        txtAttributes = mapOf("hostFingerprint" to freshDescriptor.hostFingerprint),
                    ),
                )
            }
            waitUntil(5_000, "Trusted mDNS chip rendered") { activity ->
                activity.findViewById<LinearLayout>(R.id.ll_discovered_hosts).childCount >= 2
            }
            scenario.onActivity { activity ->
                val chip = activity.findViewById<LinearLayout>(R.id.ll_discovered_hosts).getChildAt(1) as Button
                chip.performClick()
            }
            waitUntil(15_000, "Tokenless reconnect via matched mDNS [ACTIVE]") { activity ->
                val status = activity.findViewById<TextView>(R.id.tv_status).text.toString()
                val sessionsRow = activity.findViewById<LinearLayout>(R.id.ll_session_chips)
                status.contains("[ACTIVE]") && sessionsRow.childCount >= 1 && sessionsRow.getChildAt(0) is Button
            }

            // Click Session chip and submit ASK_QUESTION prompt -> answer via UI
            scenario.onActivity { activity ->
                (activity.findViewById<LinearLayout>(R.id.ll_session_chips).getChildAt(0) as Button).performClick()
            }
            Thread.sleep(250)
            scenario.onActivity { activity ->
                activity.findViewById<EditText>(R.id.et_session_id).setText(explicitSessionId)
                activity.findViewById<EditText>(R.id.et_prompt).setText("R6_STAGE2_ASK_QUESTION")
                activity.findViewById<Button>(R.id.btn_send_prompt).performClick()
            }
            waitUntil(15_000, "QUESTION banner displayed on UI") { activity ->
                activity.findViewById<TextView>(R.id.tv_approval).text.toString().startsWith("QUESTION (")
            }
            scenario.onActivity { activity ->
                activity.findViewById<EditText>(R.id.et_answer).setText("thorough")
                activity.findViewById<Button>(R.id.btn_answer_question).performClick()
            }
            waitUntil(15_000, "R6_QUESTION_ANSWERED streamed to tv_assistant_stream") { activity ->
                activity.findViewById<TextView>(R.id.tv_assistant_stream).text.toString()
                    .contains("R6_QUESTION_ANSWERED:thorough")
            }

            // Trigger Host stream.reset via /sessions/reset -> stale assistant stream buffer clears & logs resync
            val resetResp = postControlJson(
                url = "$controlUrl/sessions/reset",
                token = controlToken,
                bodyJson = JsonObject.of(
                    "sessionId" to JsonString(explicitSessionId),
                    "reason" to JsonString("history-compacted"),
                ).stringify(),
            )
            assertTrue("sessions/reset failed: ${resetResp.second}", resetResp.first in 200..299)
            waitUntil(10_000, "stream.reset clears stale stream buffer & logs resync") { activity ->
                val stream = activity.findViewById<TextView>(R.id.tv_assistant_stream).text.toString()
                val events = activity.findViewById<TextView>(R.id.tv_events).text.toString()
                !stream.contains("R6_QUESTION_ANSWERED:thorough") && events.contains("stream.reset")
            }

            // Test Forget Host removes persisted TrustedHostRecord cleanly
            scenario.onActivity { activity ->
                activity.findViewById<Button>(R.id.btn_forget_host).performClick()
            }
            waitUntil(5_000, "Forget Host removes record from TrustedHostStore") { activity ->
                trustedStore.get(freshDescriptor.hostFingerprint) == null &&
                    activity.findViewById<LinearLayout>(R.id.ll_saved_hosts).getChildAt(0) is TextView
            }
        }

        // 2) Real Dead-LAN -> BlindRelayServer E2EE Failover via adb reverse without bootstrapToken
        val descriptor = PairingQrParser.parseInput(pairingInput)
        assertFalse("descriptor.relayUrl required for Stage 2 relay failover test", descriptor.relayUrl.isNullOrBlank())
        val deadLanToRelayProfile = RemoteEndpointProfile(
            hostPublicKey = descriptor.hostPublicKeyBytes,
            hostFingerprint = descriptor.hostFingerprint,
            lanUrl = "ws://127.0.0.1:1",
            relayUrl = descriptor.relayUrl,
            relayRoomId = descriptor.relayRoomId ?: descriptor.hostFingerprint,
            bootstrapToken = null,
        )
        val relayOnlySession = FailoverRemoteSession(primaryIdentity, deadLanToRelayProfile)
        try {
            assertEquals(RemoteConnectionPhase.ACTIVE, relayOnlySession.connect())
            assertEquals(TransportKind.RELAY, relayOnlySession.activeCarrier)
            assertTrue(
                "Expected recorded LAN failure before Relay fallback",
                relayOnlySession.attemptErrors.any { it.kind == TransportKind.LAN },
            )
            assertTrue("Relay E2EE ping must succeed", relayOnlySession.ping())
            assertTrue(
                "Relay attachSession must succeed",
                relayOnlySession.attachSession(explicitSessionId) is AttachResumeResult.Events,
            )
        } finally {
            relayOnlySession.close("stage2 dead-lan relay check done")
        }

        // 3) Isolated live peer.revoked notification & retry halt (keeps primaryIdentity unrevoked for host harness)
        val revokeTempDir = File(context.noBackupFilesDir, "r6-stage2-revoke-id")
        val revokeAlias = "dsh_instr_stage2_revoke_master_v1"
        val revokeCipher = AndroidKeystoreMasterCipher(revokeAlias)
        try {
            val revokeIdStore = EncryptedDeviceIdentityStore(revokeTempDir, revokeCipher)
            val revokedIdentity = revokeIdStore.resetIdentity()
            val mintedForRevoke = postControlJson("$controlUrl/pairing-token", controlToken, "{}")
            assertTrue("pairing-token for revoke check failed", mintedForRevoke.first in 200..299)
            val revokeDescriptor = PairingQrParser.parseInput(
                JsonCodec.parseObject(mintedForRevoke.second).str("deepLink")!!,
            )

            val pairBoot = FailoverRemoteSession(revokedIdentity, RemoteEndpointProfile.fromDescriptor(revokeDescriptor))
            try {
                assertEquals(RemoteConnectionPhase.PAIRING_PENDING, pairBoot.connect())
                val req = pairBoot.requestPairing("R6-Ephemeral-Revoke", revokeDescriptor.bootstrapToken)
                val cid = req.str("candidateId")!!
                val conf = postControlJson(
                    url = "$controlUrl/pairing/confirm",
                    token = controlToken,
                    bodyJson = JsonObject.of("candidateId" to JsonString(cid)).stringify(),
                )
                assertTrue("confirm failed: ${conf.second}", conf.first in 200..299)
            } finally {
                pairBoot.close("ephemeral pair complete")
            }

            val tokenlessProfile = RemoteEndpointProfile.fromDescriptor(revokeDescriptor).copy(bootstrapToken = null)
            val liveRevokeSession = FailoverRemoteSession(revokedIdentity, tokenlessProfile)
            val revokedLatch = CountDownLatch(1)
            val revokeReasonRef = AtomicReference<String?>(null)
            liveRevokeSession.addListener(object : FailoverRemoteSession.Listener {
                override fun onPeerRevoked(reason: String) {
                    revokeReasonRef.set(reason)
                    revokedLatch.countDown()
                }
            })
            try {
                assertEquals(RemoteConnectionPhase.ACTIVE, liveRevokeSession.connect())
                val revokeRes = postControlJson(
                    url = "$controlUrl/devices/revoke",
                    token = controlToken,
                    bodyJson = JsonObject.of("deviceId" to JsonString(revokedIdentity.deviceId)).stringify(),
                )
                assertTrue("devices/revoke failed: ${revokeRes.second}", revokeRes.first in 200..299)
                assertTrue("Did not receive live peer.revoked frame", revokedLatch.await(10, TimeUnit.SECONDS))
                assertTrue(liveRevokeSession.revokedByHost)
                assertEquals(RemoteConnectionPhase.REVOKED, liveRevokeSession.phase)
                assertFalse(revokeReasonRef.get().isNullOrBlank())

                // Offline reconnect after revocation must immediately fail with PeerRevokedException without trying Relay fallback
                assertThrows(PeerRevokedException::class.java) {
                    liveRevokeSession.connect()
                }
                assertEquals(RemoteConnectionPhase.REVOKED, liveRevokeSession.phase)
                assertEquals(
                    "Expected 1 attemptError without Relay fallback, got: ${liveRevokeSession.attemptErrors}",
                    1,
                    liveRevokeSession.attemptErrors.size,
                )
            } finally {
                liveRevokeSession.close("revoke check done")
            }
        } finally {
            revokeCipher.deleteMasterKey()
            revokeTempDir.deleteRecursively()
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
