package org.dsh.community.android

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.provider.Settings
import android.text.Editable
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.TextWatcher
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import org.dsh.community.android.crypto.DeviceIdentity
import org.dsh.community.android.crypto.TrustedHostRecord
import org.dsh.community.android.protocol.CommandExecuteResult
import org.dsh.community.android.protocol.DiffDisplayFormatter
import org.dsh.community.android.protocol.DiffLineKind
import org.dsh.community.android.protocol.DisplayTextSanitizer
import org.dsh.community.android.protocol.EngineDescriptor
import org.dsh.community.android.protocol.JsonArray
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.JsonString
import org.dsh.community.android.protocol.ModelCatalogResult
import org.dsh.community.android.protocol.ModelOptionRef
import org.dsh.community.android.protocol.OfficialSessionEvent
import org.dsh.community.android.protocol.PromptImageAttachment
import org.dsh.community.android.protocol.QuestionSpec
import org.dsh.community.android.protocol.RemoteCommandDescriptor
import org.dsh.community.android.protocol.RemoteSkillSummary
import org.dsh.community.android.protocol.SessionHistoryResult
import org.dsh.community.android.protocol.SessionRef
import org.dsh.community.android.protocol.SessionSearchResult
import org.dsh.community.android.protocol.WorkspaceGitDiffResult
import org.dsh.community.android.protocol.WorkspaceGitStatusResult
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
import org.dsh.community.android.ui.AssistantTurnItem
import org.dsh.community.android.ui.ChatMarkdownFormatter
import org.dsh.community.android.ui.ChatTimelineAdapter
import org.dsh.community.android.ui.ChatTimelineItem
import org.dsh.community.android.ui.ChatTimelineStore
import org.dsh.community.android.ui.ConstrainedScrollView
import org.dsh.community.android.ui.ParsedSlashCommand
import org.dsh.community.android.ui.PromptImageHelper
import org.dsh.community.android.ui.RemoteLayoutBudget
import org.dsh.community.android.ui.SlashCommandHelper
import org.dsh.community.android.ui.SystemNoticeItem
import org.dsh.community.android.ui.ToolExecutionItem
import org.dsh.community.android.ui.UserMessageItem

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
    private lateinit var rootMainView: android.view.View
    private lateinit var connectionPanel: LinearLayout
    private lateinit var connectionScroll: ConstrainedScrollView
    private lateinit var logsPanel: LinearLayout
    private lateinit var pendingCard: LinearLayout
    private lateinit var pendingScroll: ConstrainedScrollView
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
    private lateinit var btnApprovalDiff: Button
    private lateinit var btnAnswerQuestion: Button
    private var activeDiffDialog: AlertDialog? = null
    private lateinit var btnAttachImage: Button
    private lateinit var btnClearAttachments: Button
    private lateinit var slashSuggestionsScroll: HorizontalScrollView
    private lateinit var slashSuggestionsContainer: LinearLayout
    private lateinit var attachmentBar: LinearLayout
    private lateinit var attachmentSummaryView: TextView

    private data class InFlightPromptSnapshot(
        val sessionId: String,
        val promptText: String,
        val attachments: List<Pair<PromptImageAttachment, Int>>,
    )

    private val timelineStore = ChatTimelineStore()
    private lateinit var timelineAdapter: ChatTimelineAdapter
    private val pendingAttachments = ArrayList<Pair<PromptImageAttachment, Int>>()
    private val inFlightPromptSnapshots = LinkedHashMap<String, InFlightPromptSnapshot>()

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
    private var lastEngines: List<EngineDescriptor> = emptyList()
    private var lastModelCatalog: ModelCatalogResult? = null
    private var onSessionsRefreshedInDialog: (() -> Unit)? = null
    private var currentPhase: RemoteConnectionPhase = RemoteConnectionPhase.DISCONNECTED
    private var userPinnedConnectionDrawer: Boolean? = null
    private var logsPanelVisible = false
    private var lastInsetsVerticalPx = 0
    private var lastImeVisible = false
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
        val onLongClick: (() -> Unit)? = null,
    )

    private val pickPromptImageLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent(),
    ) { uri ->
        if (uri != null) {
            attachPickedImage(uri)
        }
    }

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

        val rootView = findViewById<android.view.View>(R.id.root_main)
        rootMainView = rootView
        val baseLeft = rootView.paddingLeft
        val baseTop = rootView.paddingTop
        val baseRight = rootView.paddingRight
        val baseBottom = rootView.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(rootView) { view, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout() or
                    WindowInsetsCompat.Type.ime()
            )
            lastInsetsVerticalPx = baseTop + baseBottom + insets.top + insets.bottom
            lastImeVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime())
            view.setPadding(
                baseLeft + insets.left,
                baseTop + insets.top,
                baseRight + insets.right,
                baseBottom + insets.bottom
            )
            updateResponsiveLayoutBudget()
            windowInsets
        }
        rootView.addOnLayoutChangeListener { _, _, top, _, bottom, _, oldTop, _, oldBottom ->
            if ((bottom - top) != (oldBottom - oldTop)) {
                updateResponsiveLayoutBudget()
            }
        }
        ViewCompat.requestApplyInsets(rootView)

        statusView = findViewById(R.id.tv_status)
        agentStatusView = findViewById(R.id.tv_agent_status)
        deviceIdView = findViewById(R.id.tv_device_id)
        metricsView = findViewById(R.id.tv_metrics)
        connectionPanel = findViewById(R.id.ll_connection_panel)
        connectionScroll = findViewById(R.id.scroll_connection_panel)
        logsPanel = findViewById(R.id.ll_logs_panel)
        pendingCard = findViewById(R.id.ll_pending_card)
        pendingScroll = findViewById(R.id.scroll_pending_card)
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
        btnApprovalDiff = findViewById(R.id.btn_approval_diff)
        btnAnswerQuestion = findViewById(R.id.btn_answer_question)
        btnAttachImage = findViewById(R.id.btn_attach_image)
        btnClearAttachments = findViewById(R.id.btn_clear_attachments)
        slashSuggestionsScroll = findViewById(R.id.hsv_slash_suggestions)
        slashSuggestionsContainer = findViewById(R.id.ll_slash_suggestions)
        attachmentBar = findViewById(R.id.ll_attachment_bar)
        attachmentSummaryView = findViewById(R.id.tv_attachment_summary)

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
            onLongPressItem = { item ->
                showTimelineItemActionsDialog(item)
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
            updateResponsiveLayoutBudget()
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
            if (raw.isEmpty()) {
                pairingInput.requestFocus()
                showUiFailure("Paste pairing JSON / dsh-remote:// URI or tap Scan QR first", isWarning = true)
                return@setOnClickListener
            }
            val payload = PairingInputHelper.extractPairingPayload(raw) ?: raw
            acceptPairingPayload(payload, sourceLabel = "Manual")
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
            showSessionBrowserDialog()
        }

        findViewById<Button>(R.id.btn_new_session).setOnClickListener {
            stickyStatusError = null
            createSessionWithOptionalEnginePicker(title = null)
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
            } else {
                service?.refreshSessionsAsync()
                showSessionBrowserDialog()
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

        btnAttachImage.setOnClickListener {
            if (pendingAttachments.size >= PromptImageHelper.MAX_ATTACHMENTS) {
                Toast.makeText(
                    this,
                    "At most ${PromptImageHelper.MAX_ATTACHMENTS} images per prompt",
                    Toast.LENGTH_SHORT,
                ).show()
                return@setOnClickListener
            }
            pickPromptImageLauncher.launch("image/*")
        }

        btnClearAttachments.setOnClickListener {
            pendingAttachments.clear()
            renderAttachmentBar()
        }

        promptInput.addTextChangedListener(
            object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) {
                    renderSlashSuggestions(s?.toString().orEmpty())
                }
            },
        )

        findViewById<Button>(R.id.btn_send_prompt).setOnClickListener {
            handleSendOrSlashCommand()
        }

        btnApprove.setOnClickListener {
            val cid = pendingCallId ?: return@setOnClickListener
            service?.respondApprovalAsync(cid, approved = true)
        }

        btnReject.setOnClickListener {
            val cid = pendingCallId ?: return@setOnClickListener
            service?.respondApprovalAsync(cid, approved = false)
        }

        btnApprovalDiff.setOnClickListener {
            val targetSid = activeTimelineSessionId()
                ?: attachedSessionId
                ?: sessionIdInput.text?.toString()?.trim()?.ifEmpty { null }
                ?: lastSessions.firstOrNull()?.id
            if (targetSid.isNullOrBlank()) {
                Toast.makeText(this, "Attach a session first to review Git diff", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            service?.fetchWorkspaceGitDiffAsync(targetSid)
        }

        btnAnswerQuestion.setOnClickListener {
            val qid = pendingQuestionId ?: return@setOnClickListener
            submitQuestionResponse(qid)
        }

        sessionIdInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO || actionId == EditorInfo.IME_ACTION_DONE) {
                findViewById<Button>(R.id.btn_attach).performClick()
                true
            } else {
                false
            }
        }

        answerInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND || actionId == EditorInfo.IME_ACTION_DONE) {
                val qid = pendingQuestionId
                if (qid != null) {
                    submitQuestionResponse(qid)
                    true
                } else {
                    false
                }
            } else {
                false
            }
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
            onSessionsRefreshedInDialog?.invoke()
        }
    }

    override fun onEnginesListed(engines: List<EngineDescriptor>) {
        runOnUiThread {
            lastEngines = engines
        }
    }

    private fun buildHighlightedDiffSpannable(diffBody: String): SpannableStringBuilder {
        val builder = SpannableStringBuilder()
        val parsed = DiffDisplayFormatter.parseLines(diffBody)
        for ((index, entry) in parsed.withIndex()) {
            val start = builder.length
            builder.append(entry.text)
            if (index < parsed.lastIndex) builder.append('\n')
            val end = builder.length
            when (entry.kind) {
                DiffLineKind.FILE_HEADER -> {
                    builder.setSpan(ForegroundColorSpan(Color.parseColor("#79C0FF")), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    builder.setSpan(BackgroundColorSpan(Color.parseColor("#131C2B")), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    builder.setSpan(StyleSpan(Typeface.BOLD), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                DiffLineKind.HUNK -> {
                    builder.setSpan(ForegroundColorSpan(Color.parseColor("#D2A8FF")), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    builder.setSpan(BackgroundColorSpan(Color.parseColor("#1E1930")), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                DiffLineKind.ADD -> {
                    builder.setSpan(ForegroundColorSpan(Color.parseColor("#7EE787")), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    builder.setSpan(BackgroundColorSpan(Color.parseColor("#14331C")), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                DiffLineKind.DEL -> {
                    builder.setSpan(ForegroundColorSpan(Color.parseColor("#FFA198")), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    builder.setSpan(BackgroundColorSpan(Color.parseColor("#38171A")), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                DiffLineKind.CONTEXT -> {
                    builder.setSpan(ForegroundColorSpan(Color.parseColor("#B8C0CC")), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
            }
        }
        return builder
    }

    override fun onWorkspaceGitDiffLoaded(
        sessionId: String,
        status: WorkspaceGitStatusResult,
        diff: WorkspaceGitDiffResult,
    ) {
        runOnUiThread {
            if (isFinishing || isDestroyed) return@runOnUiThread
            activeDiffDialog?.dismiss()

            val diffBody = diff.diff.ifBlank { "(No unified text diff in current scope.)" }
            val stats = DiffDisplayFormatter.summarize(diff.diff)
            val summaryText = buildString {
                append("${status.branch} (↑${status.ahead} ↓${status.behind}) · ${status.files.size} files")
                if (diff.diff.isNotBlank()) {
                    append(" · +${stats.additions} / -${stats.deletions}")
                }
                if (diff.path != null) append("\nFile: ${diff.path}")
                if (diff.truncated) append(" · [truncated]")
            }

            val root = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dpToPx(12), dpToPx(10), dpToPx(12), dpToPx(6))
            }

            val summaryView = TextView(this).apply {
                text = summaryText
                textSize = 11f
                typeface = Typeface.MONOSPACE
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.dsh_text_secondary))
                setPadding(0, 0, 0, dpToPx(8))
            }
            root.addView(summaryView)

            val chipRow = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
            }
            fun addFilterChip(label: String, active: Boolean, onTap: () -> Unit) {
                val chip = Button(this).apply {
                    text = label
                    textSize = 11f
                    isAllCaps = false
                    minHeight = 0
                    minimumHeight = 0
                    minWidth = 0
                    minimumWidth = 0
                    setPadding(dpToPx(10), dpToPx(5), dpToPx(10), dpToPx(5))
                    setBackgroundResource(if (active) R.drawable.bg_chip_accent else R.drawable.bg_chip_neutral)
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.dsh_text_primary))
                    setOnClickListener { onTap() }
                }
                val lp = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply {
                    marginEnd = dpToPx(6)
                }
                chipRow.addView(chip, lp)
            }

            addFilterChip("Unstaged", active = !diff.staged) {
                if (diff.staged) service?.fetchWorkspaceGitDiffAsync(sessionId, path = diff.path, staged = false)
            }
            addFilterChip("Staged", active = diff.staged) {
                if (!diff.staged) service?.fetchWorkspaceGitDiffAsync(sessionId, path = diff.path, staged = true)
            }
            addFilterChip("All Files", active = diff.path == null) {
                if (diff.path != null) service?.fetchWorkspaceGitDiffAsync(sessionId, path = null, staged = diff.staged)
            }
            for (file in status.files.take(25)) {
                val badge = if (file.untracked) "?" else "${file.indexStatus}${file.workTreeStatus}".trim().ifBlank { "M" }
                val shortName = file.path.substringAfterLast('/')
                addFilterChip("[$badge] $shortName", active = diff.path == file.path) {
                    service?.fetchWorkspaceGitDiffAsync(sessionId, path = file.path, staged = diff.staged)
                }
            }

            val chipScroll = HorizontalScrollView(this).apply {
                isHorizontalScrollBarEnabled = false
                setPadding(0, 0, 0, dpToPx(8))
                addView(chipRow)
            }
            root.addView(chipScroll)

            val hScroll = HorizontalScrollView(this).apply {
                isFillViewport = true
                setBackgroundResource(R.drawable.bg_code_surface)
            }
            val diffTv = TextView(this).apply {
                setTextIsSelectable(true)
                typeface = Typeface.MONOSPACE
                textSize = 11f
                setPadding(dpToPx(10), dpToPx(8), dpToPx(10), dpToPx(8))
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.dsh_text_primary))
                setHorizontallyScrolling(true)
                text = if (diff.diff.isBlank()) diffBody else buildHighlightedDiffSpannable(diffBody)
            }
            hScroll.addView(diffTv)

            val vScroll = ScrollView(this).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    dpToPx(320),
                )
                addView(hScroll)
            }
            root.addView(vScroll)

            val scopeLabel = if (diff.staged) "Staged Diff" else "Git Diff"
            val dlg = AlertDialog.Builder(this)
                .setTitle("$scopeLabel · ${DisplayTextSanitizer.sanitizeSingleLine(sessionId).take(22)}")
                .setView(root)
                .setNeutralButton("Copy Diff") { _, _ ->
                    copyTextToClipboard("Git Diff", diffBody, "Copied diff")
                }
                .setNegativeButton("Close", null)
                .create()
            activeDiffDialog = dlg
            dlg.show()
        }
    }

    override fun onSessionCreated(session: SessionRef) {
        runOnUiThread {
            val cleanTitle = DisplayTextSanitizer.sanitizeSingleLine(session.title).ifBlank { session.id }
            appendLog("Created session ${session.id} ($cleanTitle)")
            sessionIdInput.setText(session.id)
        }
    }

    override fun onSessionRenamed(session: SessionRef) {
        runOnUiThread {
            val cleanTitle = DisplayTextSanitizer.sanitizeSingleLine(session.title).ifBlank { session.id }
            appendLog("Session renamed: $cleanTitle")
            renderSessionChips(lastSessions)
        }
    }

    override fun onSessionForked(forked: SessionRef) {
        runOnUiThread {
            val cleanTitle = DisplayTextSanitizer.sanitizeSingleLine(forked.title).ifBlank { forked.id }
            appendLog("Forked session ${forked.id} ($cleanTitle)")
            sessionIdInput.setText(forked.id)
            renderSessionChips(lastSessions)
        }
    }

    override fun onSessionHistoryLoaded(history: SessionHistoryResult) {
        runOnUiThread {
            val inserted = timelineStore.prependHistory(history.sessionId, history.events)
            for (evt in history.events) {
                if (evt.seq > 0L) {
                    markEventSeen("${history.sessionId}:${evt.seq}:${evt.type}")
                }
            }
            if (activeTimelineSessionId() == history.sessionId) {
                refreshTimelineUi(scrollToBottom = false)
            }
            val msg = "Loaded ${history.events.size} history events (+$inserted cards, source=${history.source}, hasMore=${history.hasMore})"
            appendLog(msg)
            Toast.makeText(
                this,
                if (inserted > 0) "Loaded $inserted older timeline entries" else "No older events remaining",
                Toast.LENGTH_SHORT,
            ).show()
        }
    }

    override fun onSessionSearchResults(results: SessionSearchResult) {
        runOnUiThread {
            if (results.hits.isEmpty()) {
                AlertDialog.Builder(this)
                    .setTitle("Search · ${DisplayTextSanitizer.sanitizeSingleLine(results.query)}")
                    .setMessage("No matching messages found across Host sessions.")
                    .setPositiveButton("OK", null)
                    .show()
                return@runOnUiThread
            }
            val labels = results.hits.map { hit ->
                val title = DisplayTextSanitizer.sanitizeSingleLine(hit.title).ifBlank { hit.sessionId }
                val snippet = DisplayTextSanitizer.truncateByCodePoints(
                    DisplayTextSanitizer.sanitizeSingleLine(hit.snippet),
                    120,
                )
                "$title (#${hit.seq})\n$snippet"
            }
            AlertDialog.Builder(this)
                .setTitle("Search (${results.hits.size}${if (results.hasMore) "+" else ""}) · ${DisplayTextSanitizer.sanitizeSingleLine(results.query)}")
                .setItems(labels.toTypedArray()) { _, which ->
                    val chosen = results.hits[which]
                    selectAndAttachSession(chosen.sessionId)
                    appendLog("Jumped to search hit ${chosen.sessionId} seq=${chosen.seq}")
                }
                .setNegativeButton("Close", null)
                .show()
        }
    }

    override fun onCommandsListed(sessionId: String?, commands: List<RemoteCommandDescriptor>) {
        runOnUiThread {
            if (commands.isEmpty()) {
                Toast.makeText(this, "No Host commands advertised", Toast.LENGTH_SHORT).show()
                return@runOnUiThread
            }
            val labels = commands.map { cmd ->
                val cleanName = DisplayTextSanitizer.sanitizeSingleLine(cmd.name)
                val cleanDesc = DisplayTextSanitizer.sanitizeSingleLine(cmd.description)
                val hint = cmd.inputHint?.takeIf { it.isNotBlank() }?.let { " ${DisplayTextSanitizer.sanitizeSingleLine(it)}" }.orEmpty()
                "$cleanName$hint\n$cleanDesc"
            }
            AlertDialog.Builder(this)
                .setTitle("Host Commands (${commands.size})")
                .setItems(labels.toTypedArray()) { _, which ->
                    val chosen = commands[which]
                    val targetSid = sessionId ?: activeTimelineSessionId()
                    if (chosen.inputHint.isNullOrBlank() && targetSid != null) {
                        service?.executeCommandAsync(targetSid, chosen.name)
                    } else {
                        val fill = "${chosen.name} "
                        promptInput.setText(fill)
                        promptInput.setSelection(fill.length)
                        promptInput.requestFocus()
                    }
                }
                .setNegativeButton("Close", null)
                .show()
        }
    }

    override fun onCommandExecuted(sessionId: String, command: String, result: CommandExecuteResult) {
        runOnUiThread {
            val cleanOut = DisplayTextSanitizer.sanitizeMultiline(result.output ?: result.error ?: "", 2_000).trim()
            if (cleanOut.isNotEmpty()) {
                appendLog("[command ${DisplayTextSanitizer.sanitizeSingleLine(command)}] $cleanOut")
                AlertDialog.Builder(this)
                    .setTitle(DisplayTextSanitizer.sanitizeSingleLine(command))
                    .setMessage(cleanOut)
                    .setPositiveButton("OK", null)
                    .show()
            } else {
                val msg = if (result.ok) "Executed $command" else "Command failed"
                Toast.makeText(this, DisplayTextSanitizer.sanitizeSingleLine(msg), Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onSkillsListed(sessionId: String?, skills: List<RemoteSkillSummary>) {
        runOnUiThread {
            if (skills.isEmpty()) {
                Toast.makeText(this, "No Host skills reported", Toast.LENGTH_SHORT).show()
                return@runOnUiThread
            }
            val labels = skills.map { sk ->
                val cleanName = DisplayTextSanitizer.sanitizeSingleLine(sk.name)
                val desc = DisplayTextSanitizer.truncateByCodePoints(
                    DisplayTextSanitizer.sanitizeSingleLine(sk.description),
                    100,
                )
                "$cleanName\n$desc"
            }
            AlertDialog.Builder(this)
                .setTitle("Host Skills (${skills.size})")
                .setItems(labels.toTypedArray()) { _, which ->
                    val sk = skills[which]
                    val fill = "/skill ${sk.name} "
                    promptInput.setText(fill)
                    promptInput.setSelection(fill.length)
                    promptInput.requestFocus()
                }
                .setNegativeButton("Close", null)
                .show()
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
            val modelShort = catalog.currentModel?.takeIf { it.isNotBlank() }?.let { m ->
                DisplayTextSanitizer.sanitizeSingleLine(m).take(14)
            }
            val effortShort = catalog.currentReasoningEffort?.takeIf { it.isNotBlank() }?.let { e ->
                "·${DisplayTextSanitizer.sanitizeSingleLine(e).take(6)}"
            }.orEmpty()
            btnModelPicker.text = if (modelShort != null) "$modelShort$effortShort" else getString(R.string.action_model)
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
        pendingAttachments.clear()
        renderAttachmentBar()
        renderSlashSuggestions("")
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
        updateResponsiveLayoutBudget()
    }

    private fun updateResponsiveLayoutBudget() {
        if (!::rootMainView.isInitialized || !::connectionScroll.isInitialized) return
        val viewportPx = (rootMainView.height - lastInsetsVerticalPx).coerceAtLeast(0)
        if (viewportPx <= 0) return
        val budget = RemoteLayoutBudget.compute(
            viewportHeightPx = viewportPx,
            density = resources.displayMetrics.density,
            imeVisible = lastImeVisible,
            connectionVisible = connectionPanel.visibility == View.VISIBLE,
            logsVisible = logsPanel.visibility == View.VISIBLE,
            pendingVisible = pendingCard.visibility == View.VISIBLE,
        )
        connectionScroll.maxHeightPx = budget.connectionPanelMaxPx
        pendingScroll.maxHeightPx = budget.pendingPanelMaxPx
        val lp = logsPanel.layoutParams
        if (lp != null && lp.height != budget.logsPanelHeightPx) {
            lp.height = budget.logsPanelHeightPx
            logsPanel.layoutParams = lp
        }
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
            val visionTag = if (opt.supportsImageInput) " [Vision]" else ""
            val ctxTag = opt.contextWindow?.let { " ${it / 1000}k" } ?: ""
            "$mark${opt.name} ($providerDisplay)$visionTag$ctxTag"
        }
        AlertDialog.Builder(this)
            .setTitle("Select Host Model")
            .setItems(labels.toTypedArray()) { _, which ->
                val chosen = catalog.models[which]
                if (chosen.reasoningEfforts.isEmpty()) {
                    service?.selectModelAsync(targetSid, chosen.provider, chosen.model)
                } else {
                    showReasoningEffortPickerDialog(targetSid, chosen, catalog.currentReasoningEffort)
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showReasoningEffortPickerDialog(
        sessionId: String,
        model: ModelOptionRef,
        currentEffort: String?,
    ) {
        val activeEffort = currentEffort ?: model.defaultReasoningEffort
        val labels = model.reasoningEfforts.map { effort ->
            val mark = if (effort.value == activeEffort) "✓ " else ""
            val defTag = if (effort.value == model.defaultReasoningEffort) " (default)" else ""
            "$mark${effort.label}$defTag"
        }
        AlertDialog.Builder(this)
            .setTitle("Reasoning Effort · ${model.name}")
            .setItems(labels.toTypedArray()) { _, which ->
                val chosenEffort = model.reasoningEfforts[which]
                service?.selectModelAsync(sessionId, model.provider, model.model, chosenEffort.value)
            }
            .setNeutralButton("Model Default") { _, _ ->
                service?.selectModelAsync(sessionId, model.provider, model.model, model.defaultReasoningEffort)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun handleSendOrSlashCommand() {
        val sid = sessionIdInput.text.toString().trim()
        val rawPrompt = promptInput.text.toString()
        val trimmed = rawPrompt.trim()
        val parsed = SlashCommandHelper.parse(trimmed)
        if (parsed != null) {
            when (parsed) {
                is ParsedSlashCommand.NewSession -> {
                    promptInput.text.clear()
                    stickyStatusError = null
                    service?.createSessionAsync(title = parsed.title, autoAttach = true)
                }
                is ParsedSlashCommand.RenameSession -> {
                    val targetSid = activeTimelineSessionId()
                    if (targetSid == null) {
                        Toast.makeText(this, "Attach or create a session first", Toast.LENGTH_SHORT).show()
                        return
                    }
                    promptInput.text.clear()
                    service?.renameSessionAsync(targetSid, parsed.title)
                }
                is ParsedSlashCommand.ForkSession -> {
                    val targetSid = activeTimelineSessionId()
                    if (targetSid == null) {
                        Toast.makeText(this, "Attach or create a session first", Toast.LENGTH_SHORT).show()
                        return
                    }
                    promptInput.text.clear()
                    stickyStatusError = null
                    service?.forkSessionAsync(targetSid, title = parsed.title, autoAttach = true)
                }
                is ParsedSlashCommand.SearchSessions -> {
                    promptInput.text.clear()
                    service?.searchSessionsAsync(parsed.query)
                }
                ParsedSlashCommand.LoadHistory -> {
                    val targetSid = activeTimelineSessionId()
                    if (targetSid == null) {
                        Toast.makeText(this, "Attach or create a session first", Toast.LENGTH_SHORT).show()
                        return
                    }
                    promptInput.text.clear()
                    val beforeSeq = timelineStore.oldestLoadedSeq(targetSid)
                    service?.loadHistoryAsync(targetSid, beforeSeq = beforeSeq)
                }
                ParsedSlashCommand.ListCommands -> {
                    promptInput.text.clear()
                    service?.listCommandsAsync(activeTimelineSessionId())
                }
                ParsedSlashCommand.ListSkills -> {
                    promptInput.text.clear()
                    service?.listSkillsAsync(activeTimelineSessionId())
                }
                ParsedSlashCommand.StopTurn -> {
                    val targetSid = activeTimelineSessionId()
                    if (targetSid == null) {
                        Toast.makeText(this, "No active session", Toast.LENGTH_SHORT).show()
                        return
                    }
                    promptInput.text.clear()
                    service?.abortTurnAsync(targetSid, keepInbox = false)
                }
                ParsedSlashCommand.OpenModels -> {
                    promptInput.text.clear()
                    val targetSid = activeTimelineSessionId()
                    pendingOpenModelPicker = true
                    service?.refreshModelsAsync(targetSid, silentOnError = false)
                }
                ParsedSlashCommand.OpenSessions -> {
                    promptInput.text.clear()
                    service?.refreshSessionsAsync()
                    showSessionBrowserDialog()
                }
                ParsedSlashCommand.ExportChat -> {
                    promptInput.text.clear()
                    exportCurrentSessionMarkdown()
                }
                ParsedSlashCommand.Help -> {
                    promptInput.text.clear()
                    AlertDialog.Builder(this)
                        .setTitle("Slash Commands")
                        .setMessage(SlashCommandHelper.formatHelpText())
                        .setPositiveButton("OK", null)
                        .show()
                }
                is ParsedSlashCommand.Error -> {
                    Toast.makeText(this, parsed.message, Toast.LENGTH_SHORT).show()
                    appendLog(parsed.message)
                }
                is ParsedSlashCommand.SteerPrompt -> {
                    dispatchUserPrompt(sid, parsed.prompt, modeOverride = "steer")
                }
            }
            return
        }
        dispatchUserPrompt(sid, trimmed, modeOverride = null)
    }

    private fun dispatchUserPrompt(
        sid: String,
        prompt: String,
        modeOverride: String?,
    ) {
        if (sid.isEmpty()) {
            Toast.makeText(this, "Attach or create a session first", Toast.LENGTH_SHORT).show()
            return
        }
        if (prompt.isEmpty() && pendingAttachments.isEmpty()) {
            return
        }
        if (attachedSessionId != sid) {
            selectAndAttachSession(sid)
        }
        val attachmentSnapshot = pendingAttachments.toList()
        val attachmentsToSend = attachmentSnapshot.map { it.first }
        val attachmentLabels = attachmentsToSend.map { it.name ?: it.mediaType }
        if (pendingAttachments.isNotEmpty()) {
            pendingAttachments.clear()
            renderAttachmentBar()
        }
        if (prompt.isEmpty()) {
            promptInput.text.clear()
        }
        lastEventSessionId = sid
        val optimisticId = timelineStore.addOptimisticUserPrompt(sid, prompt, attachmentLabels)
        inFlightPromptSnapshots[optimisticId] = InFlightPromptSnapshot(
            sessionId = sid,
            promptText = prompt,
            attachments = attachmentSnapshot,
        )
        while (inFlightPromptSnapshots.size > 16) {
            val oldest = inFlightPromptSnapshots.keys.firstOrNull() ?: break
            inFlightPromptSnapshots.remove(oldest)
        }
        refreshTimelineUi(scrollToBottom = true)
        val mode = modeOverride ?: if (steerEnabled) "steer" else null
        service?.submitPromptAsync(sid, prompt, mode, attachmentsToSend, optimisticId = optimisticId)
    }

    private fun attachPickedImage(uri: Uri) {
        if (pendingAttachments.size >= PromptImageHelper.MAX_ATTACHMENTS) {
            Toast.makeText(
                this,
                "At most ${PromptImageHelper.MAX_ATTACHMENTS} images per prompt",
                Toast.LENGTH_SHORT,
            ).show()
            return
        }
        val usedBytes = pendingAttachments.sumOf { it.second }
        val remainingBudget = PromptImageHelper.MAX_TOTAL_IMAGE_BYTES - usedBytes
        val targetCap = minOf(PromptImageHelper.MAX_SINGLE_IMAGE_BYTES, remainingBudget)
        if (targetCap < 1024) {
            Toast.makeText(this, "Image attachment budget full (28 KB max)", Toast.LENGTH_SHORT).show()
            return
        }
        Toast.makeText(this, "Compressing image…", Toast.LENGTH_SHORT).show()
        Thread(
            {
                try {
                    val att = PromptImageHelper.compressUriToAttachment(this, uri, maxBytes = targetCap)
                    val byteLen = java.util.Base64.getDecoder().decode(att.dataBase64).size
                    runOnUiThread {
                        val currentUsed = pendingAttachments.sumOf { it.second }
                        if (pendingAttachments.size >= PromptImageHelper.MAX_ATTACHMENTS ||
                            currentUsed + byteLen > PromptImageHelper.MAX_TOTAL_IMAGE_BYTES
                        ) {
                            Toast.makeText(this, "Image budget exceeded; clear existing attachment first", Toast.LENGTH_SHORT).show()
                            return@runOnUiThread
                        }
                        pendingAttachments.add(att to byteLen)
                        renderAttachmentBar()
                    }
                } catch (t: Throwable) {
                    runOnUiThread {
                        val reason = DisplayTextSanitizer.sanitizeSingleLine(t.message).ifBlank { t.javaClass.simpleName }
                        Toast.makeText(this, "Image attach failed: $reason", Toast.LENGTH_SHORT).show()
                        appendLog("[image attach failed] $reason")
                    }
                }
            },
            "dsh-prompt-img",
        ).apply {
            isDaemon = true
            start()
        }
    }

    private fun renderAttachmentBar() {
        if (pendingAttachments.isEmpty()) {
            attachmentBar.visibility = View.GONE
            attachmentSummaryView.text = ""
            return
        }
        attachmentBar.visibility = View.VISIBLE
        val totalKb = maxOf(1, (pendingAttachments.sumOf { it.second } + 512) / 1024)
        val names = pendingAttachments.joinToString(", ") { (att, _) -> att.name ?: "photo.jpg" }
        attachmentSummaryView.text = "📷 ${pendingAttachments.size}/${PromptImageHelper.MAX_ATTACHMENTS}: $names (~${totalKb} KB)"
    }

    private fun renderSlashSuggestions(rawInput: String) {
        val matches = SlashCommandHelper.matchSuggestions(rawInput)
        slashSuggestionsContainer.removeAllViews()
        if (matches.isEmpty()) {
            slashSuggestionsScroll.visibility = View.GONE
            return
        }
        slashSuggestionsScroll.visibility = View.VISIBLE
        val padH = dpToPx(10)
        val padV = dpToPx(5)
        val marginPx = dpToPx(6)
        for (spec in matches) {
            val btn = Button(this).apply {
                text = if (spec.argsHint.isBlank()) spec.name else "${spec.name} ${spec.argsHint}"
                textSize = 11f
                isAllCaps = false
                minHeight = 0
                minimumHeight = 0
                minWidth = 0
                minimumWidth = 0
                setPadding(padH, padV, padH, padV)
                setBackgroundResource(R.drawable.bg_chip_neutral)
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.dsh_text_accent))
                setOnClickListener {
                    if (spec.argsHint.isBlank()) {
                        promptInput.setText(spec.name)
                        handleSendOrSlashCommand()
                    } else {
                        val fill = "${spec.name} "
                        promptInput.setText(fill)
                        promptInput.setSelection(fill.length)
                    }
                }
            }
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                marginEnd = marginPx
            }
            slashSuggestionsContainer.addView(btn, lp)
        }
    }

    private fun showSessionBrowserDialog() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val p = dpToPx(14)
            setPadding(p, p, p, p)
        }
        val searchInput = EditText(this).apply {
            hint = "Search sessions by title or ID…"
            setBackgroundResource(R.drawable.bg_input_field)
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.dsh_text_primary))
            setHintTextColor(ContextCompat.getColor(this@MainActivity, R.color.dsh_text_secondary))
            textSize = 13f
            val h = dpToPx(10)
            val v = dpToPx(8)
            setPadding(h, v, h, v)
            setSingleLine(true)
        }
        val scroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dpToPx(240),
            ).apply {
                topMargin = dpToPx(10)
            }
        }
        val rowsContainer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        scroll.addView(rowsContainer)
        root.addView(searchInput)
        root.addView(scroll)

        var dialogRef: AlertDialog? = null
        fun repopulate() {
            rowsContainer.removeAllViews()
            val query = searchInput.text?.toString()?.trim()?.lowercase().orEmpty()
            val selectedId = attachedSessionId ?: sessionIdInput.text?.toString()?.trim()
            val filtered = lastSessions.filter { s ->
                query.isEmpty() ||
                    s.id.lowercase().contains(query) ||
                    (s.title?.lowercase()?.contains(query) == true)
            }
            if (filtered.isEmpty()) {
                val empty = TextView(this).apply {
                    text = if (lastSessions.isEmpty()) "No sessions loaded yet." else "No sessions match \"$query\"."
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.dsh_text_secondary))
                    textSize = 12f
                    setPadding(dpToPx(4), dpToPx(8), dpToPx(4), dpToPx(8))
                }
                rowsContainer.addView(empty)
                return
            }
            for (s in filtered) {
                val cleanTitle = DisplayTextSanitizer.sanitizeSingleLine(s.title).ifBlank { "(Untitled)" }
                val engPrefix = s.engine?.let { "[${it.take(10)}] " } ?: ""
                val isSelected = s.id == selectedId
                val rowBtn = Button(this).apply {
                    text = (if (isSelected) "● " else "") + "$engPrefix$cleanTitle\n${s.id}"
                    textSize = 12f
                    isAllCaps = false
                    gravity = android.view.Gravity.START or android.view.Gravity.CENTER_VERTICAL
                    minHeight = 0
                    minimumHeight = 0
                    setPadding(dpToPx(10), dpToPx(8), dpToPx(10), dpToPx(8))
                    setBackgroundResource(if (isSelected) R.drawable.bg_chip_accent else R.drawable.bg_chip_neutral)
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.dsh_text_primary))
                    setOnClickListener {
                        selectAndAttachSession(s.id)
                        dialogRef?.dismiss()
                    }
                    setOnLongClickListener {
                        dialogRef?.dismiss()
                        showSessionActionDialog(s)
                        true
                    }
                }
                val lp = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply {
                    bottomMargin = dpToPx(6)
                }
                rowsContainer.addView(rowBtn, lp)
            }
        }

        repopulate()
        searchInput.addTextChangedListener(
            object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) {
                    repopulate()
                }
            },
        )
        onSessionsRefreshedInDialog = { repopulate() }

        val activeForButton = lastSessions.firstOrNull { it.id == (attachedSessionId ?: sessionIdInput.text?.toString()?.trim()) }
        val builder = AlertDialog.Builder(this)
            .setTitle("Sessions (tap switch · long-press rename)")
            .setView(root)
            .setPositiveButton("New Session") { _, _ ->
                stickyStatusError = null
                createSessionWithOptionalEnginePicker(title = null)
            }
            .setNegativeButton("Close", null)
        if (activeForButton != null) {
            builder.setNeutralButton("Rename Active") { _, _ ->
                showRenameSessionDialog(activeForButton)
            }
        }
        val dlg = builder.create()
        dialogRef = dlg
        dlg.setOnDismissListener {
            onSessionsRefreshedInDialog = null
        }
        dlg.show()
    }

    private fun createSessionWithOptionalEnginePicker(title: String?) {
        val available = lastEngines.filter { it.available }
        if (available.size <= 1) {
            service?.createSessionAsync(title = title, autoAttach = true, engine = available.firstOrNull()?.id)
            return
        }
        val labels = available.map { eng ->
            val ver = eng.version?.let { " ($it)" } ?: ""
            "${eng.displayName}$ver"
        }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("Create Session · Choose Agent Engine")
            .setItems(labels) { _, which ->
                val chosen = available[which]
                service?.createSessionAsync(title = title, autoAttach = true, engine = chosen.id)
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showSessionActionDialog(session: SessionRef) {
        val title = DisplayTextSanitizer.sanitizeSingleLine(session.title).ifBlank { session.id }
        val actions = arrayOf(
            "Switch to Session",
            "Review Git Diff (Read-Only)",
            "Rename Session",
            "Fork Session",
            "Load Older History",
            "Copy Session ID",
        )
        AlertDialog.Builder(this)
            .setTitle(title)
            .setItems(actions) { _, which ->
                when (which) {
                    0 -> selectAndAttachSession(session.id)
                    1 -> service?.fetchWorkspaceGitDiffAsync(session.id)
                    2 -> showRenameSessionDialog(session)
                    3 -> service?.forkSessionAsync(session.id, autoAttach = true)
                    4 -> {
                        val before = timelineStore.oldestLoadedSeq(session.id)
                        service?.loadHistoryAsync(session.id, beforeSeq = before)
                    }
                    5 -> copyTextToClipboard("Session ID", session.id, "Copied session ID")
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showRenameSessionDialog(session: SessionRef) {
        val currentTitle = DisplayTextSanitizer.sanitizeSingleLine(session.title)
        val input = EditText(this).apply {
            setText(currentTitle)
            hint = "Session title"
            setSingleLine(true)
            setSelection(text?.length ?: 0)
        }
        val pad = dpToPx(16)
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, dpToPx(8), pad, 0)
            addView(input)
        }
        AlertDialog.Builder(this)
            .setTitle("Rename Session")
            .setView(container)
            .setPositiveButton("Save") { _, _ ->
                val newTitle = input.text?.toString()?.trim().orEmpty()
                if (newTitle.isNotEmpty()) {
                    service?.renameSessionAsync(session.id, newTitle)
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showSavedHostActionDialog(host: TrustedHostRecord) {
        val actions = arrayOf("Reconnect", "Rename Host", "Forget Host")
        val label = DisplayTextSanitizer.sanitizeSingleLine(host.label).ifBlank { host.hostFingerprint.take(12) }
        AlertDialog.Builder(this)
            .setTitle(label)
            .setItems(actions) { _, which ->
                when (which) {
                    0 -> {
                        stickyStatusError = null
                        userPinnedConnectionDrawer = null
                        service?.reconnectSavedHost(host.hostFingerprint)
                    }
                    1 -> showRenameHostDialog(host)
                    2 -> {
                        stickyStatusError = null
                        service?.forgetHost(host.hostFingerprint)
                    }
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showRenameHostDialog(host: TrustedHostRecord) {
        val input = EditText(this).apply {
            setText(DisplayTextSanitizer.sanitizeSingleLine(host.label))
            hint = "Host display name"
            setSingleLine(true)
            setSelection(text?.length ?: 0)
        }
        val pad = dpToPx(16)
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, dpToPx(8), pad, 0)
            addView(input)
        }
        AlertDialog.Builder(this)
            .setTitle("Rename Saved Host")
            .setView(container)
            .setPositiveButton("Save") { _, _ ->
                val newName = input.text?.toString()?.trim().orEmpty()
                if (newName.isNotEmpty()) {
                    service?.renameSavedHost(host.hostFingerprint, newName)
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showTimelineItemActionsDialog(item: ChatTimelineItem) {
        val fullText: String
        val codeBlock: String?
        val canQuote: Boolean
        val canResend: Boolean
        when (item) {
            is UserMessageItem -> {
                fullText = item.text.ifBlank { item.attachmentLabels.joinToString(", ") { "[Image: $it]" } }
                codeBlock = null
                canQuote = fullText.isNotBlank()
                canResend = item.text.isNotBlank()
            }
            is AssistantTurnItem -> {
                fullText = item.markdownText.ifBlank { item.thinkingText }
                codeBlock = ChatMarkdownFormatter.extractFirstCodeBlock(item.markdownText)
                canQuote = fullText.isNotBlank()
                canResend = false
            }
            is ToolExecutionItem -> {
                fullText = buildString {
                    appendLine("Tool: ${item.toolName}")
                    if (item.argumentsText.isNotBlank()) appendLine(item.argumentsText)
                    if (item.outputText.isNotBlank()) append(item.outputText)
                }.trim()
                codeBlock = null
                canQuote = false
                canResend = false
            }
            is SystemNoticeItem -> {
                fullText = item.text
                codeBlock = null
                canQuote = false
                canResend = false
            }
        }
        if (fullText.isBlank()) return

        val labels = ArrayList<String>()
        val handlers = ArrayList<() -> Unit>()
        labels.add("Copy text")
        handlers.add { copyTextToClipboard("DSH Message", fullText, "Copied message") }

        if (!codeBlock.isNullOrBlank()) {
            labels.add("Copy code block")
            handlers.add { copyTextToClipboard("DSH Code", codeBlock, "Copied code block") }
        }
        if (canQuote) {
            labels.add("Quote in composer")
            handlers.add {
                val quoted = fullText.lines().take(6).joinToString("\n") { "> $it" } + "\n\n"
                val cur = promptInput.text?.toString().orEmpty()
                val next = if (cur.isBlank()) quoted else "$quoted$cur"
                promptInput.setText(next)
                promptInput.setSelection(next.length)
                promptInput.requestFocus()
            }
        }
        if (canResend) {
            labels.add("Re-use in composer")
            handlers.add {
                promptInput.setText(fullText)
                promptInput.setSelection(fullText.length)
                promptInput.requestFocus()
            }
        }
        AlertDialog.Builder(this)
            .setTitle("Message Actions")
            .setItems(labels.toTypedArray()) { _, which ->
                handlers[which].invoke()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun copyTextToClipboard(label: String, text: String, toastMessage: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
        clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
        Toast.makeText(this, toastMessage, Toast.LENGTH_SHORT).show()
    }

    private fun exportCurrentSessionMarkdown() {
        val sid = activeTimelineSessionId()
        if (sid.isNullOrBlank()) {
            val msg = "Select or attach a session first before exporting chat"
            appendLog(msg)
            Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
            return
        }
        val title = lastSessions.firstOrNull { it.id == sid }?.title
        val md = timelineStore.exportAsMarkdown(sid, title)
        if (md.isBlank()) {
            val msg = "No messages to export yet for session $sid"
            appendLog(msg)
            Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
            return
        }
        val sendIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, "DSH Session ${title ?: sid}")
            putExtra(Intent.EXTRA_TEXT, md)
        }
        try {
            startActivity(Intent.createChooser(sendIntent, "Export DSH Conversation"))
        } catch (_: Throwable) {
            copyTextToClipboard("DSH Session", md, "No share target available — copied exported Markdown")
        }
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
                val msg = "Unable to open battery optimization settings on this device"
                appendLog(msg)
                Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
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
                val baseLabel = cleanTitle.takeIf { it.isNotBlank() } ?: session.id.take(14)
                val label = session.engine?.let { "[${it.take(8)}] $baseLabel" } ?: baseLabel
                val selected = session.id == selectedId
                ChipSpec(
                    label = label,
                    backgroundRes = if (selected) R.drawable.bg_chip_accent else R.drawable.bg_chip_neutral,
                    onClick = { selectAndAttachSession(session.id) },
                    onLongClick = { showSessionActionDialog(session) },
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
                    onLongClick = { showSavedHostActionDialog(host) },
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
                if (chip.onLongClick != null) {
                    setOnLongClickListener {
                        chip.onLongClick.invoke()
                        true
                    }
                }
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
                showUiFailure(msg, isWarning = true)
            }
            DiscoverySelectOutcome.REVOKED_HOST -> {
                val msg = "[REVOKED] Discovered host ${host.hostFingerprint?.take(12)}... is revoked — Forget & re-pair after Host re-trusts"
                showUiFailure(msg, isWarning = false)
            }
            DiscoverySelectOutcome.MISSING_FINGERPRINT, null -> {
                showUiFailure(
                    "Discovered mDNS host ${host.hostDisplayLabel} missing hostFingerprint — scan QR or paste dsh-remote:// URI instead",
                    isWarning = true,
                )
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

    private fun showUiFailure(message: String, isWarning: Boolean = false) {
        val clean = DisplayTextSanitizer.sanitizeSingleLine(message)
        stickyStatusError = clean
        statusView.text = clean
        statusView.setTextColor(
            ContextCompat.getColor(
                this,
                if (isWarning) R.color.dsh_status_warn else R.color.dsh_status_danger,
            ),
        )
        appendLog(clean)
        Toast.makeText(this, clean, Toast.LENGTH_LONG).show()
    }

    override fun onActionFailed(action: String, reason: String) {
        val cleanAction = DisplayTextSanitizer.sanitizeSingleLine(action)
        val cleanReason = DisplayTextSanitizer.sanitizeSingleLine(reason)
        runOnUiThread {
            renderApprovalBanner()
            showUiFailure("$cleanAction failed: $cleanReason")
        }
    }

    override fun onPromptSubmitSucceeded(sessionId: String, optimisticId: String?) {
        runOnUiThread {
            if (optimisticId != null) {
                inFlightPromptSnapshots.remove(optimisticId)
            }
        }
    }

    override fun onPromptSubmitFailed(sessionId: String, optimisticId: String?, reason: String) {
        val cleanReason = DisplayTextSanitizer.sanitizeSingleLine(reason)
        runOnUiThread {
            if (timelineStore.markOptimisticUserFailed(sessionId, optimisticId, cleanReason)) {
                refreshTimelineUi(scrollToBottom = false)
            }
            val snapshot = if (optimisticId != null) inFlightPromptSnapshots.remove(optimisticId) else null
            if (snapshot != null && snapshot.sessionId == attachedSessionId) {
                if (snapshot.attachments.isNotEmpty() && pendingAttachments.isEmpty()) {
                    pendingAttachments.addAll(snapshot.attachments)
                    renderAttachmentBar()
                }
                if (snapshot.promptText.isNotEmpty() && promptInput.text.isNullOrBlank()) {
                    promptInput.setText(snapshot.promptText)
                    promptInput.setSelection(promptInput.text.length)
                }
            }
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
                etAnswerVisibility(visible = false)
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
                etAnswerVisibility(visible = true)
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
                btnApprovalDiff.visibility = View.VISIBLE
                etAnswerVisibility(visible = false)
                questionOptionsScroll.visibility = View.GONE
            }
            headQuestion != null -> {
                val extra = latestQuestions.size - 1
                val suffix = if (extra > 0) " (+$extra more)" else ""
                val cleanPrompt = if (headQuestion.questions.size > 1) {
                    headQuestion.questions.joinToString(" | ") { spec ->
                        val label = DisplayTextSanitizer.sanitizeSingleLine(spec.header ?: spec.id)
                        val qText = DisplayTextSanitizer.sanitizeSingleLine(spec.question)
                        if (qText.isNotEmpty()) "$label: $qText" else label
                    }
                } else {
                    DisplayTextSanitizer.sanitizeSingleLine(headQuestion.prompt)
                }
                approvalBanner.text = "QUESTION (${headQuestion.questionId}): $cleanPrompt$suffix"
                pendingCard.visibility = View.VISIBLE
                btnApprove.visibility = View.GONE
                btnReject.visibility = View.GONE
                btnApprovalDiff.visibility = View.GONE
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
        updateResponsiveLayoutBudget()
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
            return
        }
        Toast.makeText(this, "Select an option or type a reply first", Toast.LENGTH_SHORT).show()
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
