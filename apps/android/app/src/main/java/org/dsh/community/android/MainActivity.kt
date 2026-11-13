package org.dsh.community.android

import android.Manifest
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import org.dsh.community.android.crypto.DeviceIdentity
import org.dsh.community.android.crypto.TrustedHostRecord
import org.dsh.community.android.protocol.DisplayTextSanitizer
import org.dsh.community.android.protocol.JsonArray
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.JsonString
import org.dsh.community.android.protocol.ModelCatalogResult
import org.dsh.community.android.protocol.OfficialSessionEvent
import org.dsh.community.android.protocol.QuestionSpec
import org.dsh.community.android.protocol.SessionRef
import org.dsh.community.android.qr.QrScanActivity
import org.dsh.community.android.service.BackgroundLifecycleStats
import org.dsh.community.android.service.DiscoverySelectOutcome
import org.dsh.community.android.service.PendingApprovalItem
import org.dsh.community.android.service.PendingQuestionItem
import org.dsh.community.android.service.RemoteSessionService
import org.dsh.community.android.transport.DiscoveredLanHost
import org.dsh.community.android.transport.LanMdnsDiscoverer
import org.dsh.community.android.transport.PairingInputHelper
import org.dsh.community.android.transport.PairingQrParser
import org.dsh.community.android.transport.RemoteConnectionPhase
import org.dsh.community.android.transport.TransportKind
import org.dsh.community.android.ui.ChatTimelineAdapter
import org.dsh.community.android.ui.ChatTimelineStore

/**
 * Pure native Android thin Remote Client UI:
 *  - Zero embedded Node runtime, zero local HTTP loop, zero WebView hosting local DSH.
 *  - Pairs via built-in CameraX QR scanner, Pairing JSON, `dsh-remote://pair` deep links, or mDNS `_dsh-remote._tcp.`.
 *  - Native RecyclerView conversation timeline with Markdown rendering, collapsible thinking/tool cards,
 *    turn abort/steer controls, session creation, model selection, and interactive question chips.
 */
class MainActivity : AppCompatActivity(), RemoteSessionService.UiObserver {
    private var service: RemoteSessionService? = null
    private var bound = false
    private var mdnsDiscoverer: LanMdnsDiscoverer? = null

    private lateinit var statusView: TextView
    private lateinit var agentStatusView: TextView
    private lateinit var deviceIdView: TextView
    private lateinit var metricsView: TextView
    private lateinit var connectionPanel: LinearLayout
    private lateinit var logsPanel: LinearLayout
    private lateinit var pendingCard: LinearLayout
    private lateinit var questionOptionsScroll: HorizontalScrollView
    private lateinit var questionOptionsContainer: LinearLayout
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
    private lateinit var chatEmptyView: TextView
    private lateinit var chatRecyclerView: RecyclerView

    private lateinit var btnToggleConnection: Button
    private lateinit var btnToggleLogs: Button
    private lateinit var btnModelPicker: Button
    private lateinit var btnSteerMode: Button
    private lateinit var btnStopTurn: Button
    private lateinit var btnApprove: Button
    private lateinit var btnReject: Button
    private lateinit var btnAnswerQuestion: Button

    private val timelineStore = ChatTimelineStore()
    private lateinit var timelineAdapter: ChatTimelineAdapter

    private var pendingCallId: String? = null
    private var pendingQuestionId: String? = null
    private var latestApprovals: List<PendingApprovalItem> = emptyList()
    private var latestQuestions: List<PendingQuestionItem> = emptyList()
    private var pendingDeepLinkInput: String? = null
    private var stickyStatusError: String? = null
    private var lastHandledIntentRef: Intent? = null
    private var attachedSessionId: String? = null
    private var lastEventSessionId: String? = null
    private var lastSessions: List<SessionRef> = emptyList()
    private var lastModelCatalog: ModelCatalogResult? = null
    private var currentPhase: RemoteConnectionPhase = RemoteConnectionPhase.DISCONNECTED
    private var userPinnedConnectionDrawer: Boolean? = null
    private var logsPanelVisible = false
    private var steerEnabled = false
    private var isAgentRunning = false
    private var pendingOpenModelPicker = false
    private val selectedQuestionChoices = LinkedHashMap<String, LinkedHashSet<String>>()
    private var renderedQuestionSignature: String? = null
    private val seenEventKeys = LinkedHashSet<String>()
    private var streamChunkCount = 0
    private var lastIdentity: DeviceIdentity? = null
    private var lastStats: BackgroundLifecycleStats? = null
    private val discoveredHosts = LinkedHashMap<String, DiscoveredLanHost>()

    private data class ChipSpec(
        val label: String,
        val backgroundRes: Int,
        val textColorRes: Int = R.color.dsh_text_primary,
        val onClick: () -> Unit,
    )

    private val qrScanLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            val payload = result.data?.getStringExtra(QrScanActivity.EXTRA_QR_PAYLOAD)
            if (!payload.isNullOrBlank()) {
                acceptPairingPayload(payload, sourceLabel = "Camera QR")
            }
        }
    }

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
        agentStatusView = findViewById(R.id.tv_agent_status)
        deviceIdView = findViewById(R.id.tv_device_id)
        metricsView = findViewById(R.id.tv_metrics)
        connectionPanel = findViewById(R.id.ll_connection_panel)
        logsPanel = findViewById(R.id.ll_logs_panel)
        pendingCard = findViewById(R.id.ll_pending_card)
        questionOptionsScroll = findViewById(R.id.hsv_question_options)
        questionOptionsContainer = findViewById(R.id.ll_question_options)
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
        chatEmptyView = findViewById(R.id.tv_chat_empty)
        chatRecyclerView = findViewById(R.id.rv_chat_timeline)

        btnToggleConnection = findViewById(R.id.btn_toggle_connection)
        btnToggleLogs = findViewById(R.id.btn_toggle_logs)
        btnModelPicker = findViewById(R.id.btn_model_picker)
        btnSteerMode = findViewById(R.id.btn_steer_mode)
        btnStopTurn = findViewById(R.id.btn_stop_turn)
        btnApprove = findViewById(R.id.btn_approve)
        btnReject = findViewById(R.id.btn_reject)
        btnAnswerQuestion = findViewById(R.id.btn_answer_question)

        timelineAdapter = ChatTimelineAdapter(
            onToggleThinking = { itemId ->
                val sid = activeTimelineSessionId() ?: return@ChatTimelineAdapter
                timelineStore.toggleThinkingExpanded(sid, itemId)
                refreshTimelineUi(scrollToBottom = false)
            },
            onToggleTool = { itemId ->
                val sid = activeTimelineSessionId() ?: return@ChatTimelineAdapter
                timelineStore.toggleToolExpanded(sid, itemId)
                refreshTimelineUi(scrollToBottom = false)
            },
        )
        chatRecyclerView.layoutManager = LinearLayoutManager(this).apply {
            stackFromEnd = false
        }
        chatRecyclerView.adapter = timelineAdapter
        chatRecyclerView.itemAnimator = null

        val startIntent = Intent(this, RemoteSessionService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(startIntent)
        } else {
            startService(startIntent)
        }

        btnToggleConnection.setOnClickListener {
            val nextVisible = connectionPanel.visibility != View.VISIBLE
            userPinnedConnectionDrawer = nextVisible
            applyConnectionPanelVisibility(nextVisible)
        }

        btnToggleLogs.setOnClickListener {
            logsPanelVisible = !logsPanelVisible
            logsPanel.visibility = if (logsPanelVisible) View.VISIBLE else View.GONE
            btnToggleLogs.setTextColor(
                ContextCompat.getColor(
                    this,
                    if (logsPanelVisible) R.color.dsh_text_accent else R.color.dsh_text_primary,
                ),
            )
        }

        findViewById<Button>(R.id.btn_export_chat).setOnClickListener {
            exportCurrentSessionMarkdown()
        }

        findViewById<Button>(R.id.btn_scan_qr).setOnClickListener {
            qrScanLauncher.launch(Intent(this, QrScanActivity::class.java))
        }

        findViewById<Button>(R.id.btn_battery_settings).setOnClickListener {
            openBatteryOptimizationSettings()
        }

        findViewById<Button>(R.id.btn_connect).setOnClickListener {
            val raw = pairingInput.text.toString().trim()
            if (raw.isNotEmpty()) {
                stickyStatusError = null
                userPinnedConnectionDrawer = null
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
            resetUiConversationState()
            userPinnedConnectionDrawer = true
            applyConnectionPanelVisibility(true)
            service?.disconnect()
        }

        findViewById<Button>(R.id.btn_paste_pair).setOnClickListener {
            pastePairingFromClipboard()
        }

        findViewById<Button>(R.id.btn_reconnect).setOnClickListener {
            stickyStatusError = null
            userPinnedConnectionDrawer = null
            service?.reconnectSavedHost()
        }

        findViewById<Button>(R.id.btn_forget_host).setOnClickListener {
            resetUiConversationState()
            userPinnedConnectionDrawer = true
            applyConnectionPanelVisibility(true)
            service?.forgetHost()
        }

        findViewById<Button>(R.id.btn_sessions).setOnClickListener {
            service?.refreshSessionsAsync()
        }

        findViewById<Button>(R.id.btn_new_session).setOnClickListener {
            stickyStatusError = null
            service?.createSessionAsync(title = null, autoAttach = true)
        }

        btnModelPicker.setOnClickListener {
            val targetSid = activeTimelineSessionId()
            pendingOpenModelPicker = true
            service?.refreshModelsAsync(targetSid, silentOnError = false)
        }

        findViewById<Button>(R.id.btn_attach).setOnClickListener {
            val sid = sessionIdInput.text.toString().trim()
            if (sid.isNotEmpty()) {
                selectAndAttachSession(sid)
            }
        }

        btnSteerMode.setOnClickListener {
            steerEnabled = !steerEnabled
            updateSteerButtonUi()
        }

        btnStopTurn.setOnClickListener {
            val sid = activeTimelineSessionId() ?: return@setOnClickListener
            service?.abortTurnAsync(sid)
        }

        findViewById<Button>(R.id.btn_send_prompt).setOnClickListener {
            val sid = sessionIdInput.text.toString().trim()
            val prompt = promptInput.text.toString().trim()
            if (sid.isNotEmpty() && prompt.isNotEmpty()) {
                if (attachedSessionId != sid) {
                    selectAndAttachSession(sid)
                }
                lastEventSessionId = sid
                timelineStore.addOptimisticUserPrompt(sid, prompt)
                refreshTimelineUi(scrollToBottom = true)
                val mode = if (steerEnabled) "steer" else null
                service?.submitPromptAsync(sid, prompt, mode)
            }
        }

        btnApprove.setOnClickListener {
            val cid = pendingCallId ?: return@setOnClickListener
            service?.respondApprovalAsync(cid, approved = true)
        }

        btnReject.setOnClickListener {
            val cid = pendingCallId ?: return@setOnClickListener
            service?.respondApprovalAsync(cid, approved = false)
        }

        btnAnswerQuestion.setOnClickListener {
            val qid = pendingQuestionId ?: return@setOnClickListener
            submitQuestionResponse(qid)
        }

        updateSteerButtonUi()
        updateAgentStatusUi("idle")
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
        val cleanMsg = DisplayTextSanitizer.sanitizeSingleLine(message)
        runOnUiThread {
            currentPhase = phase
            if (phase == RemoteConnectionPhase.REVOKED) {
                stickyStatusError = "[REVOKED] carrier=${carrier?.wireName ?: "-"} epoch=$epoch — $cleanMsg"
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
                "[$phase] carrier=${carrier?.wireName ?: "-"} epoch=$epoch — $cleanMsg"
            }

            val statusColor = when (phase) {
                RemoteConnectionPhase.ACTIVE -> R.color.dsh_status_active
                RemoteConnectionPhase.REVOKED, RemoteConnectionPhase.FAILED -> R.color.dsh_status_danger
                else -> R.color.dsh_status_warn
            }
            statusView.setTextColor(ContextCompat.getColor(this, statusColor))

            if (phase != RemoteConnectionPhase.ACTIVE) {
                updateAgentStatusUi("idle")
            }

            val pinned = userPinnedConnectionDrawer
            if (pinned == null) {
                applyConnectionPanelVisibility(phase != RemoteConnectionPhase.ACTIVE)
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
        val cleanReason = DisplayTextSanitizer.sanitizeSingleLine(reason)
        runOnUiThread {
            val banner = "[REVOKED] ${hostFingerprint.take(12)}...: $cleanReason"
            stickyStatusError = banner
            statusView.text = banner
            statusView.setTextColor(ContextCompat.getColor(this, R.color.dsh_status_danger))
            if (userPinnedConnectionDrawer == null) {
                applyConnectionPanelVisibility(true)
            }
            appendLog("Peer revoked by Host (${hostFingerprint.take(12)}...): $cleanReason")
        }
    }

    override fun onStreamReset(sessionId: String, reason: String) {
        val cleanSid = DisplayTextSanitizer.sanitizeSingleLine(sessionId)
        val cleanReason = DisplayTextSanitizer.sanitizeSingleLine(reason)
        runOnUiThread {
            val prefix = "$sessionId:"
            seenEventKeys.removeAll { it.startsWith(prefix) }
            timelineStore.clearSession(sessionId)
            updateAgentStatusUi("idle")
            if (attachedSessionId == null || attachedSessionId == sessionId) {
                assistantStreamView.text = getString(R.string.assistant_stream_empty)
            }
            refreshTimelineUi(scrollToBottom = false)
            appendLog("[stream.reset #$cleanSid] $cleanReason — resyncing from official Host")
            service?.attachSessionAsync(sessionId)
        }
    }

    override fun onSessionsUpdated(sessions: List<SessionRef>) {
        runOnUiThread {
            lastSessions = sessions
            val summary = sessions.joinToString("\n") {
                val safeId = DisplayTextSanitizer.sanitizeSingleLine(it.id)
                val safeTitle = DisplayTextSanitizer.sanitizeSingleLine(it.title ?: "untitled").ifBlank { "untitled" }
                "$safeId ($safeTitle)"
            }
            if (sessions.isNotEmpty()) {
                appendLog("Sessions:\n$summary")
            }
            if (sessionIdInput.text.isNullOrBlank() && sessions.isNotEmpty()) {
                sessionIdInput.setText(sessions.first().id)
            }
            renderSessionChips(sessions)
        }
    }

    override fun onSessionCreated(session: SessionRef) {
        runOnUiThread {
            val cleanTitle = DisplayTextSanitizer.sanitizeSingleLine(session.title).ifBlank { session.id }
            appendLog("Created session ${session.id} ($cleanTitle)")
            sessionIdInput.setText(session.id)
        }
    }

    override fun onSessionAttached(sessionId: String) {
        runOnUiThread {
            attachedSessionId = sessionId
            lastEventSessionId = sessionId
            if (sessionIdInput.text?.toString()?.trim() != sessionId) {
                sessionIdInput.setText(sessionId)
            }
            renderSessionChips(lastSessions)
            updateAgentStatusUi(service?.currentAgentStatus(sessionId) ?: "idle")
            refreshTimelineUi(scrollToBottom = true)
        }
    }

    override fun onAgentStatusChanged(sessionId: String, status: String) {
        runOnUiThread {
            val activeSid = activeTimelineSessionId()
            if (activeSid == null || activeSid == sessionId) {
                updateAgentStatusUi(status)
            }
        }
    }

    override fun onModelCatalogUpdated(sessionId: String?, catalog: ModelCatalogResult) {
        runOnUiThread {
            lastModelCatalog = catalog
            val modelLabel = catalog.currentModel?.takeIf { it.isNotBlank() }?.let { m ->
                DisplayTextSanitizer.sanitizeSingleLine(m).take(16)
            } ?: getString(R.string.action_model)
            btnModelPicker.text = modelLabel
            if (pendingOpenModelPicker) {
                pendingOpenModelPicker = false
                val targetSid = sessionId ?: activeTimelineSessionId()
                showModelPickerDialog(targetSid, catalog)
            }
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
            val eventKey = "$sessionId:${event.seq}:${event.type}"
            if (!markEventSeen(eventKey)) {
                return@runOnUiThread
            }
            lastEventSessionId = sessionId
            timelineStore.applyEvent(sessionId, event)

            if (event.type == "assistant/chunk" || event.type == "text-delta" || event.type == "reasoning-delta") {
                streamChunkCount += 1
                refreshMetricsUi()
            } else if (event.type == "approval.resolved") {
                val dataObj = event.data as? JsonObject
                if (pendingCallId != null && pendingCallId == dataObj?.str("callId") && latestApprovals.isEmpty()) {
                    pendingCallId = null
                    renderApprovalBanner()
                }
            } else if (event.type == "question.resolved") {
                val dataObj = event.data as? JsonObject
                if (pendingQuestionId != null && pendingQuestionId == dataObj?.str("questionId") && latestQuestions.isEmpty()) {
                    pendingQuestionId = null
                    renderApprovalBanner()
                }
            }

            refreshTimelineUi(scrollToBottom = true)

            val cleanSid = DisplayTextSanitizer.sanitizeSingleLine(sessionId)
            val cleanType = DisplayTextSanitizer.sanitizeSingleLine(event.type)
            val cleanPayload = DisplayTextSanitizer.sanitizeSingleLine(event.data?.stringify() ?: "")
            appendLog("[#$cleanSid seq=${event.seq}] $cleanType: $cleanPayload")
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
            userPinnedConnectionDrawer = null
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
            statusView.setTextColor(ContextCompat.getColor(this, R.color.dsh_status_danger))
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
        val changed = attachedSessionId != sessionId
        attachedSessionId = sessionId
        lastEventSessionId = sessionId
        if (changed) {
            seenEventKeys.clear()
            for (evt in service?.replayEventsForSession(sessionId).orEmpty()) {
                val key = "$sessionId:${evt.seq}:${evt.type}"
                markEventSeen(key)
                timelineStore.applyEvent(sessionId, evt)
            }
        }
        if (lastSessions.isNotEmpty()) {
            renderSessionChips(lastSessions)
        }
        updateAgentStatusUi(service?.currentAgentStatus(sessionId) ?: "idle")
        refreshTimelineUi(scrollToBottom = true)
        service?.attachSessionAsync(sessionId)
    }

    private fun activeTimelineSessionId(): String? {
        val explicitAttached = attachedSessionId?.takeIf { it.isNotBlank() }
        if (explicitAttached != null) return explicitAttached
        val fieldSid = sessionIdInput.text?.toString()?.trim()?.takeIf { it.isNotBlank() }
        if (fieldSid != null) return fieldSid
        return lastEventSessionId
    }

    private fun refreshTimelineUi(scrollToBottom: Boolean) {
        val targetSid = activeTimelineSessionId()
        val items = if (targetSid != null) timelineStore.itemsForSession(targetSid) else emptyList()
        chatEmptyView.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
        timelineAdapter.submitList(ArrayList(items)) {
            if (scrollToBottom && items.isNotEmpty()) {
                chatRecyclerView.scrollToPosition(items.size - 1)
            }
        }

        val summary = if (targetSid != null) timelineStore.streamSummaryText(targetSid) else ""
        assistantStreamView.text = summary.ifBlank { getString(R.string.assistant_stream_empty) }
    }

    private fun resetUiConversationState() {
        stickyStatusError = null
        attachedSessionId = null
        lastEventSessionId = null
        lastModelCatalog = null
        btnModelPicker.text = getString(R.string.action_model)
        seenEventKeys.clear()
        timelineStore.clearAll()
        selectedQuestionChoices.clear()
        renderedQuestionSignature = null
        updateAgentStatusUi("idle")
        assistantStreamView.text = getString(R.string.assistant_stream_empty)
        refreshTimelineUi(scrollToBottom = false)
    }

    private fun applyConnectionPanelVisibility(visible: Boolean) {
        connectionPanel.visibility = if (visible) View.VISIBLE else View.GONE
        btnToggleConnection.setTextColor(
            ContextCompat.getColor(
                this,
                if (visible) R.color.dsh_text_accent else R.color.dsh_text_primary,
            ),
        )
    }

    private fun updateSteerButtonUi() {
        btnSteerMode.text = getString(if (steerEnabled) R.string.action_steer_on else R.string.action_steer_off)
        btnSteerMode.setBackgroundResource(
            if (steerEnabled) R.drawable.bg_chip_accent else R.drawable.bg_button_secondary,
        )
        btnSteerMode.setTextColor(
            ContextCompat.getColor(
                this,
                if (steerEnabled) R.color.dsh_text_primary else R.color.dsh_text_secondary,
            ),
        )
    }

    private fun updateAgentStatusUi(rawStatus: String) {
        val normalized = rawStatus.trim().lowercase()
        isAgentRunning = normalized == "running"
        btnStopTurn.visibility = if (isAgentRunning) View.VISIBLE else View.GONE
        agentStatusView.text = if (isAgentRunning) "Running" else "Idle"
        agentStatusView.setTextColor(
            ContextCompat.getColor(
                this,
                if (isAgentRunning) R.color.dsh_status_active else R.color.dsh_text_secondary,
            ),
        )
    }

    private fun showModelPickerDialog(sessionId: String?, catalog: ModelCatalogResult) {
        val targetSid = sessionId?.takeIf { it.isNotBlank() }
        if (targetSid == null) {
            AlertDialog.Builder(this)
                .setTitle("Select Model")
                .setMessage("Attach or create a session first before switching the active model.")
                .setPositiveButton("OK", null)
                .show()
            return
        }
        if (catalog.models.isEmpty()) {
            AlertDialog.Builder(this)
                .setTitle("Host Model Catalog")
                .setMessage(
                    "Current: ${catalog.currentProvider ?: "-"}/${catalog.currentModel ?: "-"}\n\n" +
                        "No selectable models returned by Host.",
                )
                .setPositiveButton("OK", null)
                .show()
            return
        }
        val labels = catalog.models.map { opt ->
            val selected = opt.provider == catalog.currentProvider && opt.model == catalog.currentModel
            val mark = if (selected) "✓ " else ""
            val providerDisplay = opt.providerName?.takeIf { it.isNotBlank() } ?: opt.provider
            "$mark${opt.name} ($providerDisplay)"
        }
        AlertDialog.Builder(this)
            .setTitle("Select Host Model")
            .setItems(labels.toTypedArray()) { _, which ->
                val chosen = catalog.models[which]
                service?.selectModelAsync(targetSid, chosen.provider, chosen.model)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun exportCurrentSessionMarkdown() {
        val sid = activeTimelineSessionId()
        if (sid.isNullOrBlank()) {
            appendLog("Select or attach a session first before exporting chat")
            return
        }
        val title = lastSessions.firstOrNull { it.id == sid }?.title
        val md = timelineStore.exportAsMarkdown(sid, title)
        if (md.isBlank()) {
            appendLog("No messages to export yet for session $sid")
            return
        }
        val sendIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "DSH Session ${title ?: sid}")
            putExtra(Intent.EXTRA_TEXT, md)
        }
        startActivity(Intent.createChooser(sendIntent, "Export DSH Conversation"))
    }

    private fun openBatteryOptimizationSettings() {
        val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        try {
            startActivity(intent)
        } catch (_: Throwable) {
            val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.fromParts("package", packageName, null)
            }
            try {
                startActivity(fallback)
            } catch (_: Throwable) {
                appendLog("Unable to open battery optimization settings on this device")
            }
        }
    }

    private fun renderSessionChips(sessions: List<SessionRef>) {
        val selectedId = attachedSessionId ?: sessionIdInput.text?.toString()?.trim()
        renderChipRow(
            container = sessionChipsContainer,
            emptyHintResId = R.string.session_picker_hint,
            chips = sessions.map { session ->
                val cleanTitle = DisplayTextSanitizer.sanitizeSingleLine(session.title).take(22)
                val label = cleanTitle.takeIf { it.isNotBlank() } ?: session.id.take(14)
                val selected = session.id == selectedId
                ChipSpec(
                    label = label,
                    backgroundRes = if (selected) R.drawable.bg_chip_accent else R.drawable.bg_chip_neutral,
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
                    host.isRevoked -> R.drawable.bg_button_danger
                    host.hostFingerprint == activeFingerprint -> R.drawable.bg_chip_accent
                    else -> R.drawable.bg_chip_neutral
                }
                val cleanLabel = DisplayTextSanitizer.sanitizeSingleLine(host.label).take(16).ifBlank { "Host" }
                ChipSpec(
                    label = "$prefix$cleanLabel$suffix",
                    backgroundRes = bg,
                    onClick = {
                        stickyStatusError = null
                        userPinnedConnectionDrawer = null
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
                val cleanLabel = DisplayTextSanitizer.sanitizeSingleLine(host.hostDisplayLabel).take(14).ifBlank { "Host" }
                ChipSpec(
                    label = "mDNS: $cleanLabel ($fpShort)",
                    backgroundRes = R.drawable.bg_chip_neutral,
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
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.dsh_text_secondary))
                textSize = 11f
            }
            container.addView(hint)
            return
        }
        val padH = dpToPx(12)
        val padV = dpToPx(6)
        val marginPx = dpToPx(6)
        for (chip in chips) {
            val btn = Button(this).apply {
                text = chip.label
                textSize = 11f
                isAllCaps = false
                minHeight = 0
                minimumHeight = 0
                minWidth = 0
                minimumWidth = 0
                setPadding(padH, padV, padH, padV)
                setBackgroundResource(chip.backgroundRes)
                setTextColor(ContextCompat.getColor(this@MainActivity, chip.textColorRes))
                setOnClickListener { chip.onClick() }
            }
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                marginEnd = marginPx
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
                statusView.setTextColor(ContextCompat.getColor(this, R.color.dsh_status_warn))
                appendLog(msg)
            }
            DiscoverySelectOutcome.REVOKED_HOST -> {
                val msg = "[REVOKED] Discovered host ${host.hostFingerprint?.take(12)}... is revoked — Forget & re-pair after Host re-trusts"
                stickyStatusError = msg
                statusView.text = msg
                statusView.setTextColor(ContextCompat.getColor(this, R.color.dsh_status_danger))
                appendLog(msg)
            }
            DiscoverySelectOutcome.MISSING_FINGERPRINT, null -> {
                appendLog("Discovered mDNS host ${host.hostDisplayLabel} missing hostFingerprint")
            }
        }
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

    override fun onPendingApprovalsChanged(approvals: List<PendingApprovalItem>) {
        runOnUiThread {
            latestApprovals = approvals
            renderApprovalBanner()
        }
    }

    override fun onPendingQuestionsChanged(questions: List<PendingQuestionItem>) {
        runOnUiThread {
            latestQuestions = questions
            renderApprovalBanner()
        }
    }

    override fun onActionSucceeded(action: String, refId: String) {
        runOnUiThread {
            when (action) {
                "prompt" -> promptInput.text.clear()
                "question" -> {
                    answerInput.text.clear()
                    selectedQuestionChoices.clear()
                    renderedQuestionSignature = null
                }
            }
        }
    }

    override fun onActionFailed(action: String, reason: String) {
        val cleanReason = DisplayTextSanitizer.sanitizeSingleLine(reason)
        runOnUiThread {
            appendLog("[${DisplayTextSanitizer.sanitizeSingleLine(action)} failed] $cleanReason")
            renderApprovalBanner()
        }
    }

    override fun onPendingApproval(callId: String, summary: String) {
        val cleanSummary = DisplayTextSanitizer.sanitizeSingleLine(summary)
        runOnUiThread {
            if (latestApprovals.isEmpty()) {
                pendingCallId = callId
                val extra = latestQuestions.size
                val suffix = if (extra > 0) " (+$extra more)" else ""
                approvalBanner.text = "APPROVAL REQUIRED ($callId): $cleanSummary$suffix"
                pendingCard.visibility = View.VISIBLE
                btnApprove.visibility = View.VISIBLE
                btnReject.visibility = View.VISIBLE
                questionOptionsScroll.visibility = View.GONE
            } else {
                renderApprovalBanner()
            }
        }
    }

    override fun onPendingQuestion(questionId: String, prompt: String) {
        val cleanPrompt = DisplayTextSanitizer.sanitizeSingleLine(prompt)
        runOnUiThread {
            if (latestApprovals.isEmpty() && latestQuestions.isEmpty()) {
                pendingQuestionId = questionId
                approvalBanner.text = "QUESTION ($questionId): $cleanPrompt"
                pendingCard.visibility = View.VISIBLE
                btnApprove.visibility = View.GONE
                btnReject.visibility = View.GONE
                questionOptionsScroll.visibility = View.GONE
            } else {
                renderApprovalBanner()
            }
        }
    }

    private fun renderApprovalBanner() {
        val headApproval = latestApprovals.firstOrNull()
        val headQuestion = latestQuestions.firstOrNull()
        pendingCallId = headApproval?.callId
        pendingQuestionId = headQuestion?.questionId
        when {
            headApproval != null -> {
                val extra = (latestApprovals.size - 1) + latestQuestions.size
                val suffix = if (extra > 0) " (+$extra more)" else ""
                val cleanSummary = DisplayTextSanitizer.sanitizeSingleLine(headApproval.summary)
                approvalBanner.text = "APPROVAL REQUIRED (${headApproval.callId}): $cleanSummary$suffix"
                pendingCard.visibility = View.VISIBLE
                btnApprove.visibility = View.VISIBLE
                btnReject.visibility = View.VISIBLE
                etAnswerVisibility(visible = headQuestion != null)
                questionOptionsScroll.visibility = View.GONE
            }
            headQuestion != null -> {
                val extra = latestQuestions.size - 1
                val suffix = if (extra > 0) " (+$extra more)" else ""
                val cleanPrompt = DisplayTextSanitizer.sanitizeSingleLine(headQuestion.prompt)
                approvalBanner.text = "QUESTION (${headQuestion.questionId}): $cleanPrompt$suffix"
                pendingCard.visibility = View.VISIBLE
                btnApprove.visibility = View.GONE
                btnReject.visibility = View.GONE
                etAnswerVisibility(visible = true)
                renderQuestionOptionChips(headQuestion)
            }
            else -> {
                approvalBanner.text = getString(R.string.no_pending_interaction)
                pendingCard.visibility = View.GONE
                questionOptionsScroll.visibility = View.GONE
                questionOptionsContainer.removeAllViews()
                selectedQuestionChoices.clear()
                renderedQuestionSignature = null
            }
        }
    }

    private fun etAnswerVisibility(visible: Boolean) {
        val vis = if (visible) View.VISIBLE else View.GONE
        answerInput.visibility = vis
        btnAnswerQuestion.visibility = vis
    }

    private fun renderQuestionOptionChips(item: PendingQuestionItem) {
        val specsWithOptions = item.questions.filter { it.options.isNotEmpty() }
        if (specsWithOptions.isEmpty()) {
            questionOptionsScroll.visibility = View.GONE
            questionOptionsContainer.removeAllViews()
            renderedQuestionSignature = item.questionId
            return
        }
        val sig = item.questionId + ":" + specsWithOptions.joinToString("|") { spec ->
            spec.id + "=" + spec.options.joinToString(",") { it.label }
        }
        if (renderedQuestionSignature != sig) {
            selectedQuestionChoices.clear()
            renderedQuestionSignature = sig
        }
        val singleSpecMode = specsWithOptions.size == 1
        val quickSingleTap = singleSpecMode && !specsWithOptions.first().multiSelect

        questionOptionsScroll.visibility = View.VISIBLE
        questionOptionsContainer.removeAllViews()
        val padH = dpToPx(12)
        val padV = dpToPx(6)
        val marginPx = dpToPx(6)

        for (spec in specsWithOptions) {
            val specChoices = selectedQuestionChoices.getOrPut(spec.id) { LinkedHashSet() }
            val specPrefix = if (singleSpecMode) "" else "${spec.header ?: spec.id}: "
            for (opt in spec.options) {
                val isSelected = specChoices.contains(opt.label)
                val btn = Button(this).apply {
                    text = DisplayTextSanitizer.sanitizeSingleLine("$specPrefix${opt.label}")
                    textSize = 11f
                    isAllCaps = false
                    minHeight = 0
                    minimumHeight = 0
                    minWidth = 0
                    minimumWidth = 0
                    setPadding(padH, padV, padH, padV)
                    setBackgroundResource(if (isSelected) R.drawable.bg_chip_accent else R.drawable.bg_chip_neutral)
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.dsh_text_primary))
                    setOnClickListener {
                        if (quickSingleTap) {
                            service?.respondQuestionAsync(item.questionId, opt.label)
                        } else {
                            if (specChoices.contains(opt.label)) {
                                specChoices.remove(opt.label)
                            } else {
                                if (!spec.multiSelect) specChoices.clear()
                                specChoices.add(opt.label)
                            }
                            renderQuestionOptionChips(item)
                        }
                    }
                }
                val lp = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply {
                    marginEnd = marginPx
                }
                questionOptionsContainer.addView(btn, lp)
            }
        }
    }

    private fun submitQuestionResponse(questionId: String) {
        val ansText = answerInput.text.toString().trim()
        val head = latestQuestions.firstOrNull { it.questionId == questionId }
        val nonEmptySelections = selectedQuestionChoices.entries.filter { it.value.isNotEmpty() }
        if (head != null && head.questions.isNotEmpty() && nonEmptySelections.isNotEmpty()) {
            val answersJson = head.questions.mapIndexed { idx, spec ->
                val chosen = selectedQuestionChoices[spec.id]?.toList().orEmpty()
                val includeCustom = idx == 0 && ansText.isNotEmpty()
                JsonObject.of(
                    "id" to JsonString(spec.id),
                    "selected" to JsonArray(chosen.map { JsonString(it) }),
                    "custom" to if (includeCustom) JsonString(ansText) else null,
                )
            }
            service?.respondQuestionStructuredAsync(
                questionId = questionId,
                answerValue = JsonObject.of("answers" to JsonArray(answersJson)),
            )
            return
        }
        if (ansText.isNotEmpty()) {
            service?.respondQuestionAsync(questionId, ansText)
        }
    }

    private fun markEventSeen(key: String): Boolean {
        if (!seenEventKeys.add(key)) {
            return false
        }
        while (seenEventKeys.size > 1_000) {
            val it = seenEventKeys.iterator()
            if (!it.hasNext()) break
            it.next()
            it.remove()
        }
        return true
    }

    internal fun handleDiscoveredHostForUi(host: DiscoveredLanHost) {
        runOnUiThread {
            discoveredHosts[host.endpointUrl] = host
            val cleanLabel = DisplayTextSanitizer.sanitizeSingleLine(host.hostDisplayLabel)
            appendLog("mDNS Host: $cleanLabel -> ${host.endpointUrl} fp=${host.hostFingerprint ?: "?"}")
            renderDiscoveredHostChips()
        }
    }

    private fun startMdnsScan() {
        mdnsDiscoverer?.stop()
        val discoverer = LanMdnsDiscoverer(this)
        mdnsDiscoverer = discoverer
        appendLog("Scanning mDNS $_DshMdnsServiceLabel...")
        discoverer.start(
            object : LanMdnsDiscoverer.Listener {
                override fun onHostFound(host: DiscoveredLanHost) {
                    handleDiscoveredHostForUi(host)
                }

                override fun onDiscoveryFailed(errorCode: Int, reason: String) {
                    val cleanReason = DisplayTextSanitizer.sanitizeSingleLine(reason)
                    runOnUiThread { appendLog("mDNS error $errorCode: $cleanReason") }
                }
            },
        )
    }

    private fun appendLog(line: String) {
        val cleanLine = DisplayTextSanitizer.sanitizeMultiline(line)
        val existing = eventLogView.text?.toString().orEmpty()
        val combined = if (existing.isEmpty()) cleanLine else "$existing\n$cleanLine"
        eventLogView.text = combined.takeLast(8000)
    }

    private fun dpToPx(dp: Int): Int =
        (dp * resources.displayMetrics.density + 0.5f).toInt()

    private companion object {
        const val _DshMdnsServiceLabel = "_dsh-remote._tcp."
        const val REQUEST_POST_NOTIFICATIONS = 1001
    }
}
