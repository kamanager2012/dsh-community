package org.dsh.community.android

import android.Manifest
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import org.dsh.community.android.crypto.DeviceIdentity
import org.dsh.community.android.crypto.TrustedHostRecord
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.OfficialSessionEvent
import org.dsh.community.android.protocol.SessionRef
import org.dsh.community.android.service.BackgroundLifecycleStats
import org.dsh.community.android.service.DiscoverySelectOutcome
import org.dsh.community.android.service.RemoteSessionService
import org.dsh.community.android.transport.DiscoveredLanHost
import org.dsh.community.android.transport.LanMdnsDiscoverer
import org.dsh.community.android.transport.PairingInputHelper
import org.dsh.community.android.transport.PairingQrParser
import org.dsh.community.android.transport.RemoteConnectionPhase
import org.dsh.community.android.transport.TransportKind

/**
 * Pure native Android thin Remote Client UI (R6):
 *  - No embedded Node runtime, no local HTTP loop, no WebView hosting local DSH.
 *  - Pairs via PairingBootstrapDescriptor JSON, `dsh-remote://pair` deep links, or mDNS `_dsh-remote._tcp.`.
 *  - Lists official Host sessions, streams events & token chunks, submits idempotent prompts, approvals, and questions.
 */
class MainActivity : AppCompatActivity(), RemoteSessionService.UiObserver {
    private var service: RemoteSessionService? = null
    private var bound = false
    private var mdnsDiscoverer: LanMdnsDiscoverer? = null

    private lateinit var statusView: TextView
    private lateinit var deviceIdView: TextView
    private lateinit var metricsView: TextView
    private lateinit var pairingInput: EditText
    private lateinit var savedHostsContainer: LinearLayout
    private lateinit var discoveredHostsContainer: LinearLayout
    private lateinit var sessionIdInput: EditText
    private lateinit var sessionChipsContainer: LinearLayout
    private lateinit var promptInput: EditText
    private lateinit var assistantStreamView: TextView
    private lateinit var eventLogView: TextView
    private lateinit var approvalBanner: TextView
    private lateinit var answerInput: EditText

    private var pendingCallId: String? = null
    private var pendingQuestionId: String? = null
    private var pendingDeepLinkInput: String? = null
    private var stickyStatusError: String? = null
    private var lastHandledIntentRef: Intent? = null
    private var attachedSessionId: String? = null
    private var lastSessions: List<SessionRef> = emptyList()
    private val streamBuffer = StringBuilder()
    private var inReasoningBlock = false
    private var streamChunkCount = 0
    private var lastIdentity: DeviceIdentity? = null
    private var lastStats: BackgroundLifecycleStats? = null
    private val discoveredHosts = LinkedHashMap<String, DiscoveredLanHost>()

    private data class ChipSpec(
        val label: String,
        val backgroundColor: Int,
        val onClick: () -> Unit,
    )

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val local = (binder as RemoteSessionService.LocalBinder).getService()
            service = local
            bound = true
            local.addObserver(this@MainActivity)
            val queued = pendingDeepLinkInput
            if (queued != null) {
                pendingDeepLinkInput = null
                local.connectWithPairingInput(queued)
            }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            bound = false
            service = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusView = findViewById(R.id.tv_status)
        deviceIdView = findViewById(R.id.tv_device_id)
        metricsView = findViewById(R.id.tv_metrics)
        pairingInput = findViewById(R.id.et_pairing_json)
        savedHostsContainer = findViewById(R.id.ll_saved_hosts)
        discoveredHostsContainer = findViewById(R.id.ll_discovered_hosts)
        sessionIdInput = findViewById(R.id.et_session_id)
        sessionChipsContainer = findViewById(R.id.ll_session_chips)
        promptInput = findViewById(R.id.et_prompt)
        assistantStreamView = findViewById(R.id.tv_assistant_stream)
        eventLogView = findViewById(R.id.tv_events)
        approvalBanner = findViewById(R.id.tv_approval)
        answerInput = findViewById(R.id.et_answer)

        val startIntent = Intent(this, RemoteSessionService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(startIntent)
        } else {
            startService(startIntent)
        }

        findViewById<Button>(R.id.btn_connect).setOnClickListener {
            val raw = pairingInput.text.toString().trim()
            if (raw.isNotEmpty()) {
                stickyStatusError = null
                service?.connectWithPairingInput(raw)
            }
        }

        findViewById<Button>(R.id.btn_scan_lan).setOnClickListener {
            startMdnsScan()
        }

        findViewById<Button>(R.id.btn_failover).setOnClickListener {
            service?.failoverAsync()
        }

        findViewById<Button>(R.id.btn_disconnect).setOnClickListener {
            stickyStatusError = null
            service?.disconnect()
        }

        findViewById<Button>(R.id.btn_paste_pair).setOnClickListener {
            pastePairingFromClipboard()
        }

        findViewById<Button>(R.id.btn_reconnect).setOnClickListener {
            stickyStatusError = null
            service?.reconnectSavedHost()
        }

        findViewById<Button>(R.id.btn_forget_host).setOnClickListener {
            stickyStatusError = null
            service?.forgetHost()
        }

        findViewById<Button>(R.id.btn_sessions).setOnClickListener {
            service?.refreshSessionsAsync()
        }

        findViewById<Button>(R.id.btn_attach).setOnClickListener {
            val sid = sessionIdInput.text.toString().trim()
            if (sid.isNotEmpty()) {
                selectAndAttachSession(sid)
            }
        }

        findViewById<Button>(R.id.btn_send_prompt).setOnClickListener {
            val sid = sessionIdInput.text.toString().trim()
            val prompt = promptInput.text.toString().trim()
            if (sid.isNotEmpty() && prompt.isNotEmpty()) {
                service?.submitPromptAsync(sid, prompt)
                promptInput.text.clear()
            }
        }

        findViewById<Button>(R.id.btn_approve).setOnClickListener {
            val cid = pendingCallId ?: return@setOnClickListener
            service?.respondApprovalAsync(cid, approved = true)
            pendingCallId = null
            approvalBanner.text = getString(R.string.no_pending_interaction)
        }

        findViewById<Button>(R.id.btn_reject).setOnClickListener {
            val cid = pendingCallId ?: return@setOnClickListener
            service?.respondApprovalAsync(cid, approved = false)
            pendingCallId = null
            approvalBanner.text = getString(R.string.no_pending_interaction)
        }

        findViewById<Button>(R.id.btn_answer_question).setOnClickListener {
            val qid = pendingQuestionId ?: return@setOnClickListener
            val ans = answerInput.text.toString().trim()
            if (ans.isNotEmpty()) {
                service?.respondQuestionAsync(qid, ans)
                pendingQuestionId = null
                answerInput.text.clear()
                approvalBanner.text = getString(R.string.no_pending_interaction)
            }
        }

        requestNotificationPermissionIfNeeded()
        handleIncomingIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        bindService(Intent(this, RemoteSessionService::class.java), connection, Context.BIND_AUTO_CREATE)
    }

    override fun onStop() {
        mdnsDiscoverer?.stop()
        if (bound) {
            service?.removeObserver(this)
            unbindService(connection)
            bound = false
        }
        super.onStop()
    }

    override fun onStatusChanged(
        phase: RemoteConnectionPhase,
        carrier: TransportKind?,
        epoch: Int,
        deviceId: String,
        message: String,
    ) {
        runOnUiThread {
            if (phase == RemoteConnectionPhase.REVOKED) {
                stickyStatusError = "[REVOKED] carrier=${carrier?.wireName ?: "-"} epoch=$epoch — $message"
            } else if (phase != RemoteConnectionPhase.DISCONNECTED) {
                stickyStatusError = null
            }
            val sticky = stickyStatusError
            statusView.text = if (
                sticky != null && (
                    sticky.startsWith("[REJECTED]") ||
                        phase == RemoteConnectionPhase.DISCONNECTED ||
                        phase == RemoteConnectionPhase.REVOKED
                )
            ) {
                sticky
            } else {
                "[$phase] carrier=${carrier?.wireName ?: "-"} epoch=$epoch — $message"
            }
            val backingLabel = lastIdentity?.backing ?: "Keystore-wrapped"
            deviceIdView.text = "Device ID ($backingLabel): $deviceId"
        }
    }

    override fun onTrustedHostsChanged(hosts: List<TrustedHostRecord>, activeFingerprint: String?) {
        runOnUiThread {
            renderSavedHostChips(hosts, activeFingerprint)
        }
    }

    override fun onPeerRevoked(hostFingerprint: String, reason: String) {
        runOnUiThread {
            val banner = "[REVOKED] ${hostFingerprint.take(12)}...: $reason"
            stickyStatusError = banner
            statusView.text = banner
            appendLog("Peer revoked by Host (${hostFingerprint.take(12)}...): $reason")
        }
    }

    override fun onStreamReset(sessionId: String, reason: String) {
        runOnUiThread {
            if (attachedSessionId == null || attachedSessionId == sessionId) {
                streamBuffer.setLength(0)
                inReasoningBlock = false
                assistantStreamView.text = getString(R.string.assistant_stream_empty)
            }
            appendLog("[stream.reset #$sessionId] $reason — resyncing from official Host")
            service?.attachSessionAsync(sessionId)
        }
    }

    override fun onSessionsUpdated(sessions: List<SessionRef>) {
        runOnUiThread {
            lastSessions = sessions
            val summary = sessions.joinToString("\n") { "${it.id} (${it.title ?: "untitled"})" }
            appendLog("Sessions:\n$summary")
            if (sessionIdInput.text.isNullOrBlank() && sessions.isNotEmpty()) {
                sessionIdInput.setText(sessions.first().id)
            }
            renderSessionChips(sessions)
        }
    }

    override fun onMetricsUpdated(identity: DeviceIdentity, stats: BackgroundLifecycleStats) {
        runOnUiThread {
            lastIdentity = identity
            lastStats = stats
            refreshMetricsUi()
        }
    }

    override fun onEventReceived(sessionId: String, event: OfficialSessionEvent) {
        runOnUiThread {
            val dataObj = event.data as? JsonObject
            if (event.type == "assistant/chunk") {
                val chunk = dataObj?.obj("chunk")
                val cType = chunk?.str("type")
                if (cType == "text-delta" || cType == "text") {
                    val delta = chunk.str("text") ?: chunk.str("delta") ?: ""
                    if (inReasoningBlock) {
                        streamBuffer.append('\n')
                        inReasoningBlock = false
                    }
                    appendStreamDelta(delta)
                    return@runOnUiThread
                } else if (cType == "reasoning-delta" || cType == "reasoning") {
                    val delta = chunk.str("text") ?: chunk.str("delta") ?: ""
                    if (!inReasoningBlock) {
                        streamBuffer.append(if (streamBuffer.isEmpty()) "[thinking] " else "\n[thinking] ")
                        inReasoningBlock = true
                    }
                    appendStreamDelta(delta)
                    return@runOnUiThread
                }
            } else if (event.type == "text-delta") {
                val delta = dataObj?.str("text") ?: dataObj?.str("delta") ?: ""
                if (inReasoningBlock) {
                    streamBuffer.append('\n')
                    inReasoningBlock = false
                }
                appendStreamDelta(delta)
                return@runOnUiThread
            } else if (event.type == "reasoning-delta") {
                val delta = dataObj?.str("text") ?: dataObj?.str("delta") ?: ""
                if (!inReasoningBlock) {
                    streamBuffer.append(if (streamBuffer.isEmpty()) "[thinking] " else "\n[thinking] ")
                    inReasoningBlock = true
                }
                appendStreamDelta(delta)
                return@runOnUiThread
            } else if (event.type == "tool/call" || event.type == "tool.call") {
                val toolName = dataObj?.str("toolName") ?: dataObj?.str("name") ?: "tool"
                appendStreamDelta("\n[tool:$toolName] ")
            } else if (event.type == "tool/result" || event.type == "tool.result") {
                val toolName = dataObj?.str("toolName") ?: dataObj?.str("name") ?: "tool"
                appendStreamDelta("[/tool:$toolName]\n")
            } else if (event.type == "user/message") {
                val content = dataObj?.str("text") ?: dataObj?.str("content")
                if (!content.isNullOrBlank()) {
                    appendStreamDelta(if (streamBuffer.isEmpty()) "> $content\n" else "\n\n> $content\n")
                }
            } else if (event.type == "approval.resolved") {
                if (pendingCallId != null && pendingCallId == dataObj?.str("callId")) {
                    pendingCallId = null
                    approvalBanner.text = getString(R.string.no_pending_interaction)
                }
            } else if (event.type == "question.resolved") {
                if (pendingQuestionId != null && pendingQuestionId == dataObj?.str("questionId")) {
                    pendingQuestionId = null
                    approvalBanner.text = getString(R.string.no_pending_interaction)
                }
            }
            appendLog("[#$sessionId seq=${event.seq}] ${event.type}: ${event.data?.stringify() ?: ""}")
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_POST_NOTIFICATIONS) {
            val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
            if (granted) {
                appendLog("POST_NOTIFICATIONS permission granted")
            } else {
                appendLog(getString(R.string.permission_notifications_denied))
            }
        }
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_POST_NOTIFICATIONS)
        }
    }

    private fun pastePairingFromClipboard() {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        val clip = clipboard?.primaryClip
        val rawClip = if (clip != null && clip.itemCount > 0) {
            clip.getItemAt(0)?.coerceToText(this)?.toString()
        } else {
            null
        }
        if (rawClip.isNullOrBlank()) {
            val msg = getString(R.string.clipboard_empty_pairing)
            stickyStatusError = msg
            statusView.text = msg
            appendLog(msg)
            return
        }
        val payload = PairingInputHelper.extractPairingPayload(rawClip)
        if (payload == null) {
            val msg = getString(R.string.clipboard_invalid_pairing)
            stickyStatusError = msg
            statusView.text = msg
            appendLog(msg)
            return
        }
        acceptPairingPayload(payload, sourceLabel = "Clipboard")
    }

    private fun acceptPairingPayload(rawInput: String, sourceLabel: String) {
        try {
            val descriptor = PairingQrParser.parseInput(rawInput)
            stickyStatusError = null
            pairingInput.setText(rawInput)
            appendLog("$sourceLabel validated (fp=${descriptor.hostFingerprint.take(12)}..., endpoint=${descriptor.endpointUrl})")
            val svc = service
            if (svc != null) {
                pendingDeepLinkInput = null
                svc.connectWithPairingInput(rawInput)
            } else {
                pendingDeepLinkInput = rawInput
            }
        } catch (t: Throwable) {
            val rejectedBanner = "[REJECTED] Invalid $sourceLabel pairing: ${t.message}"
            stickyStatusError = rejectedBanner
            statusView.text = rejectedBanner
            appendLog("Rejected $sourceLabel pairing: ${t.message}")
        }
    }

    private fun handleIncomingIntent(incoming: Intent?) {
        if (incoming == null || incoming === lastHandledIntentRef) return
        val extracted = PairingInputHelper.extractFromIntent(
            action = incoming.action,
            dataString = incoming.dataString,
            extraText = incoming.getStringExtra(Intent.EXTRA_TEXT),
        ) ?: return
        lastHandledIntentRef = incoming
        val source = if (incoming.action == Intent.ACTION_SEND) "Share sheet" else "Deep-link"
        acceptPairingPayload(extracted, sourceLabel = source)
    }

    private fun selectAndAttachSession(sessionId: String) {
        sessionIdInput.setText(sessionId)
        if (attachedSessionId != sessionId) {
            attachedSessionId = sessionId
            streamBuffer.setLength(0)
            inReasoningBlock = false
            assistantStreamView.text = getString(R.string.assistant_stream_empty)
        }
        if (lastSessions.isNotEmpty()) {
            renderSessionChips(lastSessions)
        }
        service?.attachSessionAsync(sessionId)
    }

    private fun renderSessionChips(sessions: List<SessionRef>) {
        val selectedId = sessionIdInput.text?.toString()?.trim()
        renderChipRow(
            container = sessionChipsContainer,
            emptyHintResId = R.string.session_picker_hint,
            chips = sessions.map { session ->
                val label = session.title?.take(22)?.takeIf { it.isNotBlank() } ?: session.id.take(14)
                val selected = session.id == selectedId
                ChipSpec(
                    label = label,
                    backgroundColor = if (selected) 0xFF00695C.toInt() else 0xFF263238.toInt(),
                    onClick = { selectAndAttachSession(session.id) },
                )
            },
        )
    }

    private fun renderSavedHostChips(hosts: List<TrustedHostRecord>, activeFingerprint: String?) {
        renderChipRow(
            container = savedHostsContainer,
            emptyHintResId = R.string.saved_hosts_hint,
            chips = hosts.map { host ->
                val prefix = if (host.isRevoked) "[REVOKED] " else "Saved: "
                val suffix = " (${host.hostFingerprint.take(8)})"
                val bg = when {
                    host.isRevoked -> 0xFF7F1D1D.toInt()
                    host.hostFingerprint == activeFingerprint -> 0xFF00695C.toInt()
                    else -> 0xFF37474F.toInt()
                }
                ChipSpec(
                    label = "$prefix${host.label.take(16)}$suffix",
                    backgroundColor = bg,
                    onClick = {
                        stickyStatusError = null
                        service?.reconnectSavedHost(host.hostFingerprint)
                    },
                )
            },
        )
    }

    private fun renderDiscoveredHostChips() {
        renderChipRow(
            container = discoveredHostsContainer,
            emptyHintResId = R.string.mdns_hosts_hint,
            chips = discoveredHosts.values.map { host ->
                val fpShort = host.hostFingerprint?.take(8) ?: "?"
                ChipSpec(
                    label = "mDNS: ${host.hostDisplayLabel.take(14)} ($fpShort)",
                    backgroundColor = 0xFF1E3A5F.toInt(),
                    onClick = { onDiscoveredHostChipClicked(host) },
                )
            },
        )
    }

    private fun renderChipRow(
        container: LinearLayout,
        emptyHintResId: Int,
        chips: List<ChipSpec>,
    ) {
        container.removeAllViews()
        if (chips.isEmpty()) {
            val hint = TextView(this).apply {
                text = getString(emptyHintResId)
                setTextColor(0xFF78909C.toInt())
                textSize = 11f
            }
            container.addView(hint)
            return
        }
        for (chip in chips) {
            val btn = Button(this).apply {
                text = chip.label
                textSize = 11f
                isAllCaps = false
                setBackgroundColor(chip.backgroundColor)
                setTextColor(0xFFFFFFFF.toInt())
                setOnClickListener { chip.onClick() }
            }
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                marginEnd = 12
            }
            container.addView(btn, lp)
        }
    }

    private fun onDiscoveredHostChipClicked(host: DiscoveredLanHost) {
        when (service?.applyDiscoveredLanHost(host)) {
            DiscoverySelectOutcome.UPDATED_AND_RECONNECTING -> {
                stickyStatusError = null
                appendLog("mDNS matched trusted Host (${host.hostFingerprint?.take(12)}...); updated LAN URL to ${host.endpointUrl}")
            }
            DiscoverySelectOutcome.UNKNOWN_UNPAIRED_HOST -> {
                val msg = "[UNPAIRED] mDNS host ${host.hostDisplayLabel} is untrusted — scan QR or paste dsh-remote:// URI (discovery !== trust)"
                stickyStatusError = msg
                statusView.text = msg
                appendLog(msg)
            }
            DiscoverySelectOutcome.REVOKED_HOST -> {
                val msg = "[REVOKED] Discovered host ${host.hostFingerprint?.take(12)}... is revoked — Forget & re-pair after Host re-trusts"
                stickyStatusError = msg
                statusView.text = msg
                appendLog(msg)
            }
            DiscoverySelectOutcome.MISSING_FINGERPRINT, null -> {
                appendLog("Discovered mDNS host ${host.hostDisplayLabel} missing hostFingerprint")
            }
        }
    }

    private fun appendStreamDelta(delta: String) {
        if (delta.isEmpty()) return
        streamBuffer.append(delta)
        if (streamBuffer.length > 12_000) {
            streamBuffer.delete(0, streamBuffer.length - 10_000)
        }
        assistantStreamView.text = streamBuffer.toString()
        streamChunkCount += 1
        refreshMetricsUi()
    }

    private fun refreshMetricsUi() {
        val id = lastIdentity
        val stats = lastStats
        if (id != null) {
            deviceIdView.text = "Device ID (${id.backing}): ${id.deviceId}"
        }
        if (stats != null) {
            metricsView.text =
                "starts=${stats.serviceStartCount} reconnects=${stats.reconnectAttempts} " +
                    "netLoss=${stats.networkLossCount} notif=${stats.approvalNotificationsPosted} " +
                    "carrier=${stats.activeCarrier ?: "-"} epoch=${stats.currentEpoch} chunks=$streamChunkCount"
        }
    }

    override fun onPendingApproval(callId: String, summary: String) {
        runOnUiThread {
            pendingCallId = callId
            approvalBanner.text = "APPROVAL REQUIRED ($callId): $summary"
        }
    }

    override fun onPendingQuestion(questionId: String, prompt: String) {
        runOnUiThread {
            pendingQuestionId = questionId
            approvalBanner.text = "QUESTION ($questionId): $prompt"
        }
    }

    internal fun handleDiscoveredHostForUi(host: DiscoveredLanHost) {
        discoveredHosts[host.endpointUrl] = host
        runOnUiThread {
            appendLog("mDNS Host: ${host.hostDisplayLabel} -> ${host.endpointUrl} fp=${host.hostFingerprint ?: "?"}")
            renderDiscoveredHostChips()
        }
    }

    private fun startMdnsScan() {
        val discoverer = LanMdnsDiscoverer(this)
        mdnsDiscoverer = discoverer
        appendLog("Scanning mDNS ${_DshMdnsServiceLabel}...")
        discoverer.start(
            object : LanMdnsDiscoverer.Listener {
                override fun onHostFound(host: DiscoveredLanHost) {
                    handleDiscoveredHostForUi(host)
                }

                override fun onDiscoveryFailed(errorCode: Int, reason: String) {
                    runOnUiThread { appendLog("mDNS error $errorCode: $reason") }
                }
            },
        )
    }

    private fun appendLog(line: String) {
        val existing = eventLogView.text?.toString().orEmpty()
        val combined = if (existing.isEmpty()) line else "$existing\n$line"
        eventLogView.text = combined.takeLast(8000)
    }

    private companion object {
        const val _DshMdnsServiceLabel = "_dsh-remote._tcp."
        const val REQUEST_POST_NOTIFICATIONS = 1001
    }
}
