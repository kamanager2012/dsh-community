package org.dsh.community.android.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Binder
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import org.dsh.community.android.MainActivity
import org.dsh.community.android.crypto.DeviceIdentity
import org.dsh.community.android.crypto.EncryptedDeviceIdentityStore
import org.dsh.community.android.crypto.EncryptedTrustedHostStore
import org.dsh.community.android.crypto.TrustedHostRecord
import org.dsh.community.android.protocol.AttachResumeResult
import org.dsh.community.android.protocol.CommandExecuteResult
import org.dsh.community.android.protocol.DisplayTextSanitizer
import org.dsh.community.android.protocol.EngineDescriptor
import org.dsh.community.android.protocol.JsonCodec
import org.dsh.community.android.protocol.JsonNumber
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.JsonString
import org.dsh.community.android.protocol.JsonValue
import org.dsh.community.android.protocol.ModelCatalogResult
import org.dsh.community.android.protocol.OfficialSessionEvent
import org.dsh.community.android.protocol.PromptImageAttachment
import org.dsh.community.android.protocol.QuestionSpec
import org.dsh.community.android.protocol.RemoteCommandDescriptor
import org.dsh.community.android.protocol.RemoteFrameCodec
import org.dsh.community.android.protocol.RemoteSkillSummary
import org.dsh.community.android.protocol.SessionHistoryResult
import org.dsh.community.android.protocol.SessionRef
import org.dsh.community.android.protocol.SessionSearchResult
import org.dsh.community.android.protocol.WorkspaceGitDiffResult
import org.dsh.community.android.protocol.WorkspaceGitStatusResult
import org.dsh.community.android.transport.AndroidWebRtcPeerEngine
import org.dsh.community.android.transport.DiscoveredLanHost
import org.dsh.community.android.transport.FailoverRemoteSession
import org.dsh.community.android.transport.PairingInputHelper
import org.dsh.community.android.transport.PairingQrParser
import org.dsh.community.android.transport.PeerRevokedException
import org.dsh.community.android.transport.RemoteConnectionPhase
import org.dsh.community.android.transport.RemoteEndpointProfile
import org.dsh.community.android.transport.TransportKind
import java.io.File
import java.io.IOException
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

data class BackgroundLifecycleStats(
    val serviceStartCount: Int,
    val reconnectAttempts: Int,
    val networkLossCount: Int,
    val approvalNotificationsPosted: Int,
    val activeCarrier: String?,
    val currentEpoch: Int,
    val lastUpdatedMs: Long,
) {
    fun toJson(): String = JsonObject.of(
        "serviceStartCount" to JsonNumber(serviceStartCount),
        "reconnectAttempts" to JsonNumber(reconnectAttempts),
        "networkLossCount" to JsonNumber(networkLossCount),
        "approvalNotificationsPosted" to JsonNumber(approvalNotificationsPosted),
        "activeCarrier" to activeCarrier?.let { JsonString(it) },
        "currentEpoch" to JsonNumber(currentEpoch),
        "lastUpdatedMs" to JsonNumber(lastUpdatedMs),
    ).stringify()
}

/**
 * Pure Kotlin backoff/lifecycle scheduler for battery-safe background reconnection.
 */
object BackoffPolicy {
    fun nextDelayMs(attempt: Int, baseMs: Long = 1_000L, maxMs: Long = 30_000L): Long {
        val clamped = attempt.coerceIn(0, 10)
        val raw = baseMs shl clamped
        return minOf(raw, maxMs)
    }
}

class ReplayBatchContext {
    internal val addedApprovals = LinkedHashMap<String, String>()
    internal val addedQuestions = LinkedHashMap<String, String>()
}

/**
 * Tracks unreplayed snapshot pending interaction baselines separately from live post-snapshot
 * resolutions so truncated initial `session.attach` replays never let historical resolutions erase
 * unrelated unresolved interactions that fell outside the replay window.
 */
class PendingInteractionCountTracker(
    private val queue: PendingInteractionQueue = PendingInteractionQueue(),
) {
    private val lock = Any()
    private val unreplayedApprovalsBySession = HashMap<String, Int>()
    private val unreplayedQuestionsBySession = HashMap<String, Int>()

    fun clearBaselines() {
        synchronized(lock) {
            unreplayedApprovalsBySession.clear()
            unreplayedQuestionsBySession.clear()
        }
    }

    fun clearSessionBaseline(sessionId: String): Boolean = synchronized(lock) {
        val removedA = unreplayedApprovalsBySession.remove(sessionId) ?: 0
        val removedQ = unreplayedQuestionsBySession.remove(sessionId) ?: 0
        removedA > 0 || removedQ > 0
    }

    fun applySessionSnapshot(sessions: List<SessionRef>) {
        synchronized(lock) {
            val approvals = queue.listApprovals()
            val questions = queue.listQuestions()
            unreplayedApprovalsBySession.clear()
            unreplayedQuestionsBySession.clear()
            for (ref in sessions) {
                val liveA = approvals.count { it.sessionId == ref.id }
                val liveQ = questions.count { it.sessionId == ref.id }
                unreplayedApprovalsBySession[ref.id] = (ref.pendingApprovals - liveA).coerceAtLeast(0)
                unreplayedQuestionsBySession[ref.id] = (ref.pendingQuestions - liveQ).coerceAtLeast(0)
            }
        }
    }

    fun effectiveCounts(sessionId: String): Pair<Int, Int> = synchronized(lock) {
        val liveA = queue.listApprovals().count { it.sessionId == sessionId }
        val liveQ = queue.listQuestions().count { it.sessionId == sessionId }
        val effA = (unreplayedApprovalsBySession[sessionId] ?: 0) + liveA
        val effQ = (unreplayedQuestionsBySession[sessionId] ?: 0) + liveQ
        effA to effQ
    }

    fun beginReplayBatch(): ReplayBatchContext = ReplayBatchContext()

    fun enqueueApproval(
        callId: String,
        summary: String,
        sessionId: String?,
        fromReplay: Boolean = false,
        replayBatch: ReplayBatchContext? = null,
    ): Boolean {
        val added = queue.enqueueApproval(callId, summary, sessionId)
        if (added && fromReplay && !sessionId.isNullOrBlank()) {
            if (replayBatch != null) {
                replayBatch.addedApprovals[callId] = sessionId
            } else {
                consumeUnreplayedApproval(sessionId, 1)
            }
        }
        return added
    }

    fun enqueueQuestion(
        questionId: String,
        prompt: String,
        sessionId: String?,
        specs: List<QuestionSpec> = emptyList(),
        fromReplay: Boolean = false,
        replayBatch: ReplayBatchContext? = null,
    ): Boolean {
        val added = queue.enqueueQuestion(questionId, prompt, sessionId, specs)
        if (added && fromReplay && !sessionId.isNullOrBlank()) {
            if (replayBatch != null) {
                replayBatch.addedQuestions[questionId] = sessionId
            } else {
                consumeUnreplayedQuestion(sessionId, 1)
            }
        }
        return added
    }

    fun resolveApproval(
        sessionId: String,
        callId: String?,
        fromReplay: Boolean = false,
        replayBatch: ReplayBatchContext? = null,
    ): String {
        if (callId != null) {
            val removed = queue.removeApproval(callId)
            replayBatch?.addedApprovals?.remove(callId)
            if (removed != null) {
                return removed.sessionId ?: sessionId
            }
            if (!fromReplay) {
                consumeUnreplayedApproval(sessionId, 1)
            }
            return sessionId
        }
        for (item in queue.listApprovals()) {
            if (item.sessionId == null || item.sessionId == sessionId) {
                queue.removeApproval(item.callId)
                replayBatch?.addedApprovals?.remove(item.callId)
            }
        }
        if (!fromReplay) {
            synchronized(lock) {
                unreplayedApprovalsBySession.remove(sessionId)
            }
        }
        return sessionId
    }

    fun resolveQuestion(
        sessionId: String,
        questionId: String?,
        fromReplay: Boolean = false,
        replayBatch: ReplayBatchContext? = null,
    ): String {
        if (questionId != null) {
            val removed = queue.removeQuestion(questionId)
            replayBatch?.addedQuestions?.remove(questionId)
            if (removed != null) {
                return removed.sessionId ?: sessionId
            }
            if (!fromReplay) {
                consumeUnreplayedQuestion(sessionId, 1)
            }
            return sessionId
        }
        for (item in queue.listQuestions()) {
            if (item.sessionId == null || item.sessionId == sessionId) {
                queue.removeQuestion(item.questionId)
                replayBatch?.addedQuestions?.remove(item.questionId)
            }
        }
        if (!fromReplay) {
            synchronized(lock) {
                unreplayedQuestionsBySession.remove(sessionId)
            }
        }
        return sessionId
    }

    fun finishReplayBatch(sessionId: String, replayBatch: ReplayBatchContext): Boolean {
        val stillOpenApprovals = replayBatch.addedApprovals.values.count { it == sessionId }
        val stillOpenQuestions = replayBatch.addedQuestions.values.count { it == sessionId }
        if (stillOpenApprovals <= 0 && stillOpenQuestions <= 0) return false
        synchronized(lock) {
            var changed = false
            if (stillOpenApprovals > 0) {
                val cur = unreplayedApprovalsBySession[sessionId] ?: 0
                if (cur > 0) {
                    unreplayedApprovalsBySession[sessionId] = (cur - stillOpenApprovals).coerceAtLeast(0)
                    changed = true
                }
            }
            if (stillOpenQuestions > 0) {
                val cur = unreplayedQuestionsBySession[sessionId] ?: 0
                if (cur > 0) {
                    unreplayedQuestionsBySession[sessionId] = (cur - stillOpenQuestions).coerceAtLeast(0)
                    changed = true
                }
            }
            return changed
        }
    }

    private fun consumeUnreplayedApproval(sessionId: String, amount: Int) {
        synchronized(lock) {
            val cur = unreplayedApprovalsBySession[sessionId] ?: 0
            if (cur > 0) {
                unreplayedApprovalsBySession[sessionId] = (cur - amount).coerceAtLeast(0)
            }
        }
    }

    private fun consumeUnreplayedQuestion(sessionId: String, amount: Int) {
        synchronized(lock) {
            val cur = unreplayedQuestionsBySession[sessionId] ?: 0
            if (cur > 0) {
                unreplayedQuestionsBySession[sessionId] = (cur - amount).coerceAtLeast(0)
            }
        }
    }
}

enum class DiscoverySelectOutcome {
    UPDATED_AND_RECONNECTING,
    UNKNOWN_UNPAIRED_HOST,
    REVOKED_HOST,
    MISSING_FINGERPRINT,
}

/**
 * Foreground service hosting the Noise IK [FailoverRemoteSession], network-loss failover hook,
 * interactive approval notifications, and battery/background lifecycle evidence counters.
 */
class RemoteSessionService : Service() {
    interface UiObserver {
        fun onStatusChanged(
            phase: RemoteConnectionPhase,
            carrier: TransportKind?,
            epoch: Int,
            deviceId: String,
            message: String,
        )
        fun onSessionsUpdated(sessions: List<SessionRef>)
        fun onEnginesListed(engines: List<EngineDescriptor>) {}
        fun onSessionCreated(session: SessionRef) {}
        fun onSessionRenamed(session: SessionRef) {}
        fun onSessionForked(session: SessionRef) {}
        fun onWorkspaceGitDiffLoaded(sessionId: String, status: WorkspaceGitStatusResult, diff: WorkspaceGitDiffResult) {}
        fun onSessionHistoryLoaded(history: SessionHistoryResult) {}
        fun onSessionSearchResults(results: SessionSearchResult) {}
        fun onCommandsListed(sessionId: String?, commands: List<RemoteCommandDescriptor>) {}
        fun onCommandExecuted(sessionId: String, command: String, result: CommandExecuteResult) {}
        fun onSkillsListed(sessionId: String?, skills: List<RemoteSkillSummary>) {}
        fun onSessionAttached(sessionId: String) {}
        fun onEventReceived(sessionId: String, event: OfficialSessionEvent)
        fun onStreamReset(sessionId: String, reason: String) {}
        fun onAgentStatusChanged(sessionId: String, status: String) {}
        fun onModelCatalogUpdated(sessionId: String?, catalog: ModelCatalogResult) {}
        fun onPeerRevoked(hostFingerprint: String, reason: String) {}
        fun onTrustedHostsChanged(hosts: List<TrustedHostRecord>, activeFingerprint: String?) {}
        fun onPendingApproval(callId: String, summary: String)
        fun onPendingQuestion(questionId: String, prompt: String)
        fun onPendingApprovalsChanged(approvals: List<PendingApprovalItem>) {}
        fun onPendingQuestionsChanged(questions: List<PendingQuestionItem>) {}
        fun onActionSucceeded(action: String, refId: String) {}
        fun onActionFailed(action: String, reason: String) {}
        fun onPromptSubmitSucceeded(sessionId: String, optimisticId: String?) {}
        fun onPromptSubmitFailed(sessionId: String, optimisticId: String?, reason: String) {}
        fun onMetricsUpdated(identity: DeviceIdentity, stats: BackgroundLifecycleStats) {}
    }

    inner class LocalBinder : Binder() {
        fun getService(): RemoteSessionService = this@RemoteSessionService
    }

    companion object {
        private const val STATUS_CHANNEL_ID = "dsh_remote_status"
        private const val APPROVAL_CHANNEL_ID = "dsh_remote_approvals"
        private const val FOREGROUND_NOTIFICATION_ID = 1001
        private const val APPROVAL_NOTIFICATION_ID = 1002
        private const val STATS_FILE = "remote-lifecycle-stats.json"
        private const val HEARTBEAT_INTERVAL_MS = 25_000L
        private const val MAX_REPLAY_EVENTS = 200

        const val ACTION_APPROVE_CALL = "org.dsh.community.android.ACTION_APPROVE_CALL"
        const val ACTION_REJECT_CALL = "org.dsh.community.android.ACTION_REJECT_CALL"
        const val ACTION_DISCONNECT = "org.dsh.community.android.ACTION_DISCONNECT"
        const val EXTRA_CALL_ID = "extra_call_id"
        const val EXTRA_IDEMPOTENCY_KEY = "extra_idempotency_key"

        internal fun syncStatusInSessionList(
            sessions: List<SessionRef>,
            sessionId: String,
            status: String,
        ): List<SessionRef> {
            if (sessions.none { it.id == sessionId && it.status != status }) return sessions
            return sessions.map { ref ->
                if (ref.id == sessionId) ref.copy(status = status) else ref
            }
        }

        internal fun syncPendingCountsInSessionList(
            sessions: List<SessionRef>,
            sessionId: String,
            pendingApprovals: Int,
            pendingQuestions: Int,
        ): List<SessionRef> {
            val cleanA = pendingApprovals.coerceAtLeast(0)
            val cleanQ = pendingQuestions.coerceAtLeast(0)
            if (sessions.none { it.id == sessionId && (it.pendingApprovals != cleanA || it.pendingQuestions != cleanQ) }) {
                return sessions
            }
            return sessions.map { ref ->
                if (ref.id == sessionId) ref.copy(pendingApprovals = cleanA, pendingQuestions = cleanQ) else ref
            }
        }

        internal fun upsertSessionTitleInList(
            sessions: List<SessionRef>,
            sessionId: String,
            title: String,
            liveStatus: String?,
            fallback: SessionRef? = null,
        ): Pair<List<SessionRef>, SessionRef> {
            val idx = sessions.indexOfFirst { it.id == sessionId }
            val updatedRef = if (idx >= 0) {
                val existing = sessions[idx]
                existing.copy(
                    title = title,
                    status = liveStatus ?: existing.status,
                )
            } else {
                val base = fallback ?: SessionRef(id = sessionId, title = title)
                base.copy(
                    title = title,
                    status = liveStatus ?: base.status,
                )
            }
            val updatedList = if (idx >= 0) {
                sessions.toMutableList().apply { set(idx, updatedRef) }
            } else {
                listOf(updatedRef) + sessions
            }
            return updatedList to updatedRef
        }
    }

    private val binder = LocalBinder()
    private val ioExecutor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "dsh-remote-io").apply { isDaemon = true }
    }
    private val ackExecutor: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "dsh-remote-ack").apply { isDaemon = true }
    }
    private val heartbeatExecutor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "dsh-remote-hb").apply { isDaemon = true }
    }
    private val uiObservers = CopyOnWriteArrayList<UiObserver>()
    private val activeNetworks = ConcurrentHashMap.newKeySet<Network>()
    private val networkObserverRegistered = AtomicBoolean(false)
    private val autoReconnectEligible = AtomicBoolean(false)
    private val pendingInteractions = PendingInteractionQueue()
    private val pendingTracker = PendingInteractionCountTracker(pendingInteractions)
    private val pendingAckSeqs = ConcurrentHashMap<String, Long>()
    private val ackScheduled = ConcurrentHashMap<String, AtomicBoolean>()
    private val highestEpochByHost = ConcurrentHashMap<String, Int>()
    private val reconnectLock = Any()
    private val sessionsLock = Any()
    private val replayLock = Any()
    private val recentEvents = ArrayDeque<Pair<String, OfficialSessionEvent>>()

    private val startCount = AtomicInteger(0)
    private val reconnectAttempts = AtomicInteger(0)
    private val consecutiveReconnectFailures = AtomicInteger(0)
    private val networkLosses = AtomicInteger(0)
    private val approvalNotifications = AtomicInteger(0)
    private val lastStatusMessage = AtomicLong(0L)

    @Volatile
    private var statusText: String = "Disconnected (remote-only thin client)"

    @Volatile
    private var deviceIdentity: DeviceIdentity? = null

    private val trustedHostStore: EncryptedTrustedHostStore by lazy {
        EncryptedTrustedHostStore.createForAndroid(this)
    }

    @Volatile
    private var activeHostFingerprint: String? = null

    @Volatile
    private var activeSession: FailoverRemoteSession? = null

    @Volatile
    private var lastSessions: List<SessionRef> = emptyList()
    @Volatile
    private var attachedSessionId: String? = null
    @Volatile
    private var lastModelCatalog: ModelCatalogResult? = null
    private val agentStatusBySession = ConcurrentHashMap<String, String>()

    @Volatile
    private var lastProfile: RemoteEndpointProfile? = null

    @Volatile
    private var lastDisplayName: String = Build.MODEL ?: "Android"

    @Volatile
    private var reconnectFuture: ScheduledFuture<*>? = null

    @Volatile
    private var heartbeatFuture: ScheduledFuture<*>? = null

    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
        ensureDeviceIdentity()
        registerNetworkObserver()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val count = startCount.incrementAndGet()
        ensureForeground(
            PairingInputHelper.resolveForegroundNotificationText(
                hasActiveSession = activeSession != null,
                currentStatus = statusText,
                startCount = count,
            ),
        )

        when (intent?.action) {
            ACTION_DISCONNECT -> {
                cancelApprovalNotification()
                disconnect()
            }
            ACTION_APPROVE_CALL -> {
                val callId = intent.getStringExtra(EXTRA_CALL_ID)
                val key = intent.getStringExtra(EXTRA_IDEMPOTENCY_KEY)
                if (!callId.isNullOrBlank()) {
                    respondApprovalAsync(callId, approved = true, explicitKey = key)
                }
            }
            ACTION_REJECT_CALL -> {
                val callId = intent.getStringExtra(EXTRA_CALL_ID)
                val key = intent.getStringExtra(EXTRA_IDEMPOTENCY_KEY)
                if (!callId.isNullOrBlank()) {
                    respondApprovalAsync(callId, approved = false, explicitKey = key)
                }
            }
        }
        persistStats()
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        autoReconnectEligible.set(false)
        unregisterNetworkObserver()
        stopHeartbeat()
        synchronized(reconnectLock) {
            reconnectFuture?.cancel(false)
            reconnectFuture = null
        }
        val toClose = activeSession
        activeSession = null
        ioExecutor.shutdownNow()
        ackExecutor.shutdownNow()
        heartbeatExecutor.shutdownNow()
        closeSessionOffMainThread(toClose, "service destroyed")
        persistStats()
        super.onDestroy()
    }

    fun addObserver(observer: UiObserver) {
        uiObservers.add(observer)
        val id = ensureDeviceIdentity()
        val s = activeSession
        observer.onStatusChanged(
            phase = s?.phase ?: RemoteConnectionPhase.DISCONNECTED,
            carrier = s?.activeCarrier,
            epoch = s?.currentEpoch ?: 0,
            deviceId = id.deviceId,
            message = statusText,
        )
        observer.onMetricsUpdated(id, currentStats())
        observer.onTrustedHostsChanged(trustedHostStore.list(), activeHostFingerprint)

        val sessionsSnapshot = lastSessions
        if (sessionsSnapshot.isNotEmpty()) {
            observer.onSessionsUpdated(sessionsSnapshot)
        }
        attachedSessionId?.let { attached ->
            observer.onSessionAttached(attached)
            agentStatusBySession[attached]?.let { st ->
                observer.onAgentStatusChanged(attached, st)
            }
        }
        lastModelCatalog?.let { catalog ->
            observer.onModelCatalogUpdated(attachedSessionId, catalog)
        }
        val replaySnapshot = synchronized(replayLock) { recentEvents.toList() }
        for ((sid, evt) in replaySnapshot) {
            observer.onEventReceived(sid, evt)
        }
        val pendingApprovals = pendingInteractions.listApprovals()
        observer.onPendingApprovalsChanged(pendingApprovals)
        pendingApprovals.firstOrNull()?.let { observer.onPendingApproval(it.callId, it.summary) }
        val pendingQuestions = pendingInteractions.listQuestions()
        observer.onPendingQuestionsChanged(pendingQuestions)
        pendingQuestions.firstOrNull()?.let { observer.onPendingQuestion(it.questionId, it.prompt) }
    }

    fun listTrustedHosts(): List<TrustedHostRecord> = trustedHostStore.list()

    fun currentHostFingerprint(): String? = activeHostFingerprint

    fun currentIdentity(): DeviceIdentity = ensureDeviceIdentity()

    fun currentAttachedSessionId(): String? = attachedSessionId

    fun currentAgentStatus(sessionId: String): String = agentStatusBySession[sessionId] ?: "idle"

    fun currentSessionsSnapshot(): List<SessionRef> = synchronized(sessionsLock) { lastSessions }

    fun currentModelCatalog(): ModelCatalogResult? = lastModelCatalog

    fun replayEventsForSession(sessionId: String): List<OfficialSessionEvent> =
        synchronized(replayLock) {
            recentEvents.filter { it.first == sessionId }.map { it.second }
        }

    fun currentStatsFile(): File = File(noBackupFilesDir, STATS_FILE)

    fun removeObserver(observer: UiObserver) {
        uiObservers.remove(observer)
    }

    fun currentStats(): BackgroundLifecycleStats = BackgroundLifecycleStats(
        serviceStartCount = startCount.get(),
        reconnectAttempts = reconnectAttempts.get(),
        networkLossCount = networkLosses.get(),
        approvalNotificationsPosted = approvalNotifications.get(),
        activeCarrier = activeSession?.activeCarrier?.wireName,
        currentEpoch = activeSession?.currentEpoch ?: 0,
        lastUpdatedMs = System.currentTimeMillis(),
    )

    fun connectWithPairingInput(rawInput: String, displayName: String = Build.MODEL ?: "Android") {
        connectWithPairingJson(rawInput, displayName)
    }

    fun connectWithPairingJson(rawDescriptorJson: String, displayName: String = Build.MODEL ?: "Android") {
        val sanitizedName = DisplayTextSanitizer.sanitizeSingleLine(displayName).ifBlank { "Android" }
        ioExecutor.execute {
            try {
                val descriptor = PairingQrParser.parse(rawDescriptorJson)
                val profile = RemoteEndpointProfile.fromDescriptor(descriptor)
                if (!profile.bootstrapToken.isNullOrBlank()) {
                    // Fresh QR pairing may target a restarted Host process whose epoch resets to 1.
                    highestEpochByHost.remove(profile.hostFingerprint)
                }
                clearReplayEvents()
                pendingAckSeqs.clear()
                pendingInteractions.clearAll()
                synchronized(sessionsLock) {
                    lastSessions = emptyList()
                    pendingTracker.clearBaselines()
                }
                attachedSessionId = null
                lastModelCatalog = null
                agentStatusBySession.clear()
                cancelApprovalNotification()
                refreshPendingUi(approvalsChanged = true, questionsChanged = true)
                connectProfileInternal(profile, sanitizedName)
            } catch (t: Throwable) {
                updateStatus(RemoteConnectionPhase.FAILED, null, 0, "Pairing parse/connect failed: ${sanitizeErr(t)}")
            }
        }
    }

    fun connectProfile(profile: RemoteEndpointProfile, displayName: String = Build.MODEL ?: "Android") {
        val sanitizedName = DisplayTextSanitizer.sanitizeSingleLine(displayName).ifBlank { "Android" }
        ioExecutor.execute {
            connectProfileInternal(profile, sanitizedName)
        }
    }

    /**
     * Reconnects to a persisted trusted Host using its Keystore-wrapped profile and local
     * Curve25519 identity without any pairing `bootstrapToken`. Fails closed when revoked.
     */
    fun reconnectSavedHost(
        hostFingerprint: String? = null,
        lanUrlOverride: String? = null,
        displayName: String = Build.MODEL ?: "Android",
        resetEpochFence: Boolean = true,
    ) {
        val sanitizedName = DisplayTextSanitizer.sanitizeSingleLine(displayName).ifBlank { "Android" }
        ioExecutor.execute {
            val all = trustedHostStore.list()
            val target = if (!hostFingerprint.isNullOrBlank()) {
                trustedHostStore.get(hostFingerprint)
            } else {
                activeHostFingerprint?.let { trustedHostStore.get(it) }
                    ?: all.firstOrNull { !it.isRevoked }
                    ?: all.firstOrNull()
            }

            if (target == null) {
                updateStatus(RemoteConnectionPhase.FAILED, null, 0, "No saved Host profile available")
                return@execute
            }

            activeHostFingerprint = target.hostFingerprint
            if (resetEpochFence) {
                // Explicit user reconnect may follow a Host daemon restart whose epoch restarts at 1.
                highestEpochByHost.remove(target.hostFingerprint)
            }
            notifyTrustedHosts()

            if (target.isRevoked) {
                val reason = DisplayTextSanitizer.sanitizeSingleLine(target.revokedReason ?: "device revoked by host")
                uiObservers.forEach { it.onPeerRevoked(target.hostFingerprint, reason) }
                updateStatus(
                    RemoteConnectionPhase.REVOKED,
                    null,
                    0,
                    "REVOKED (cached): $reason — Forget & re-pair after Host re-trusts",
                )
                return@execute
            }

            val tokenlessProfile = RemoteEndpointProfile.fromTrustedRecord(target, lanUrlOverride)
            connectProfileInternal(tokenlessProfile, sanitizedName)
        }
    }

    /**
     * Removes a saved Host profile (and tears down the live connection if active).
     */
    fun renameSavedHost(hostFingerprint: String, newLabel: String): Boolean {
        val updated = trustedHostStore.renameHost(hostFingerprint, newLabel) ?: return false
        notifyTrustedHosts()
        uiObservers.forEach { it.onActionSucceeded("host.rename", updated.hostFingerprint) }
        return true
    }

    fun forgetHost(hostFingerprint: String? = null) {
        ioExecutor.execute {
            val targetFp = hostFingerprint?.takeIf { it.isNotBlank() }
                ?: activeHostFingerprint
                ?: trustedHostStore.list().firstOrNull()?.hostFingerprint
                ?: return@execute
            highestEpochByHost.remove(targetFp)
            if (activeHostFingerprint.equals(targetFp, ignoreCase = true)) {
                autoReconnectEligible.set(false)
                consecutiveReconnectFailures.set(0)
                stopHeartbeat()
                synchronized(reconnectLock) {
                    reconnectFuture?.cancel(false)
                    reconnectFuture = null
                }
                val toClose = activeSession
                activeSession = null
                activeHostFingerprint = null
                lastProfile = null
                synchronized(sessionsLock) {
                    lastSessions = emptyList()
                    pendingTracker.clearBaselines()
                }
                attachedSessionId = null
                lastModelCatalog = null
                agentStatusBySession.clear()
                pendingAckSeqs.clear()
                clearReplayEvents()
                pendingInteractions.clearAll()
                cancelApprovalNotification()
                refreshPendingUi(approvalsChanged = true, questionsChanged = true)
                uiObservers.forEach { it.onSessionsUpdated(emptyList()) }
                closeSessionOffMainThread(toClose, "host forgotten")
            }
            val removed = trustedHostStore.forget(targetFp)
            notifyTrustedHosts()
            updateStatus(
                RemoteConnectionPhase.DISCONNECTED,
                null,
                0,
                if (removed) "Forgot saved Host ${targetFp.take(12)}..." else "Disconnected",
            )
        }
    }

    /**
     * Enforces `discovery !== trust`: updates `lanUrl` and reconnects tokenlessly ONLY if
     * [DiscoveredLanHost.hostFingerprint] matches an existing non-revoked trusted Host.
     */
    fun applyDiscoveredLanHost(discovered: DiscoveredLanHost): DiscoverySelectOutcome {
        val fp = discovered.hostFingerprint?.trim()?.takeIf { it.isNotEmpty() }
            ?: return DiscoverySelectOutcome.MISSING_FINGERPRINT
        val existing = trustedHostStore.get(fp)
            ?: return DiscoverySelectOutcome.UNKNOWN_UNPAIRED_HOST
        if (existing.isRevoked) {
            val reason = DisplayTextSanitizer.sanitizeSingleLine(existing.revokedReason ?: "device revoked by host")
            uiObservers.forEach { it.onPeerRevoked(fp, reason) }
            ioExecutor.execute {
                updateStatus(RemoteConnectionPhase.REVOKED, null, 0, "REVOKED: $reason")
            }
            return DiscoverySelectOutcome.REVOKED_HOST
        }
        val updated = trustedHostStore.updateLanFromDiscovery(
            hostFingerprint = fp,
            lanUrl = discovered.endpointUrl,
            displayLabel = DisplayTextSanitizer.sanitizeSingleLine(discovered.hostDisplayLabel),
        ) ?: return DiscoverySelectOutcome.UNKNOWN_UNPAIRED_HOST
        notifyTrustedHosts()
        reconnectSavedHost(updated.hostFingerprint, resetEpochFence = false)
        return DiscoverySelectOutcome.UPDATED_AND_RECONNECTING
    }

    fun refreshSessionsAsync() {
        ioExecutor.execute {
            val session = activeSession ?: return@execute
            try {
                try {
                    val engines = session.listEngines()
                    uiObservers.forEach { it.onEnginesListed(engines) }
                } catch (_: Throwable) {
                    // Older single-engine DSH hosts may not implement engine.list yet.
                }
                val list = session.listSessions()
                storeHostSessionsSnapshot(list)
                uiObservers.forEach { it.onSessionsUpdated(list) }
            } catch (t: Throwable) {
                updateStatus(session.phase, session.activeCarrier, session.currentEpoch, "session.list error: ${sanitizeErr(t)}")
            }
        }
    }

    fun listEnginesAsync() {
        ioExecutor.execute {
            val session = activeSession ?: return@execute
            try {
                val engines = session.listEngines()
                uiObservers.forEach { it.onEnginesListed(engines) }
            } catch (t: Throwable) {
                val reason = sanitizeErr(t)
                uiObservers.forEach { it.onActionFailed("engine.list", reason) }
            }
        }
    }

    fun createSessionAsync(title: String? = null, autoAttach: Boolean = true, engine: String? = null) {
        ioExecutor.execute {
            val session = activeSession ?: run {
                uiObservers.forEach { it.onActionFailed("session.create", "Not connected to Host") }
                return@execute
            }
            val opKey = session.newOperationKey("session-create")
            try {
                val created = session.createSession(title = title, engine = engine, idempotencyKey = opKey)
                val refreshed = try {
                    session.listSessions()
                } catch (_: Throwable) {
                    synchronized(sessionsLock) {
                        listOf(created) + lastSessions.filterNot { it.id == created.id }
                    }
                }
                storeHostSessionsSnapshot(refreshed)
                uiObservers.forEach { it.onSessionsUpdated(refreshed) }
                uiObservers.forEach { it.onSessionCreated(created) }
                uiObservers.forEach { it.onActionSucceeded("session.create", created.id) }
                if (autoAttach) {
                    attachSessionInternal(session, created.id)
                }
            } catch (t: Throwable) {
                val reason = sanitizeErr(t)
                updateStatus(session.phase, session.activeCarrier, session.currentEpoch, "session.create failed: $reason")
                uiObservers.forEach { it.onActionFailed("session.create", reason) }
            }
        }
    }

    fun attachSessionAsync(sessionId: String) {
        ioExecutor.execute {
            val session = activeSession ?: return@execute
            attachSessionInternal(session, sessionId)
        }
    }

    private fun attachSessionInternal(session: FailoverRemoteSession, sessionId: String) {
        attachedSessionId = sessionId
        uiObservers.forEach { it.onSessionAttached(sessionId) }
        agentStatusBySession[sessionId]?.let { st ->
            uiObservers.forEach { it.onAgentStatusChanged(sessionId, st) }
        }
        try {
            when (val result = session.attachSession(sessionId)) {
                is AttachResumeResult.Events -> {
                    val replayBatch = pendingTracker.beginReplayBatch()
                    for (evt in result.events) {
                        enqueueReplayEvent(sessionId, evt)
                        dispatchEventToObservers(sessionId, evt, fromReplay = true, replayBatch = replayBatch)
                    }
                    if (pendingTracker.finishReplayBatch(sessionId, replayBatch)) {
                        syncCachedSessionPendingCounts(sessionId)
                        refreshPendingUi(approvalsChanged = true, questionsChanged = true)
                    }
                    result.events.lastOrNull()?.let { lastEvt ->
                        enqueueStreamAck(session, sessionId, lastEvt.seq)
                    }
                }
                is AttachResumeResult.ResetRequired -> {
                    clearReplayEvents(sessionId)
                    agentStatusBySession.remove(sessionId)
                    uiObservers.forEach { it.onAgentStatusChanged(sessionId, "idle") }
                    updateStatus(
                        session.phase,
                        session.activeCarrier,
                        session.currentEpoch,
                        "Replay window unavailable (${DisplayTextSanitizer.sanitizeSingleLine(result.reason)}); re-sync from official session",
                    )
                }
            }
        } catch (t: Throwable) {
            updateStatus(session.phase, session.activeCarrier, session.currentEpoch, "attach failed: ${sanitizeErr(t)}")
        }
    }

    fun renameSessionAsync(sessionId: String, newTitle: String) {
        ioExecutor.execute {
            val cleanTitle = newTitle.trim()
            if (cleanTitle.isEmpty()) {
                uiObservers.forEach { it.onActionFailed("session.rename", "Session title must not be empty") }
                return@execute
            }
            val session = activeSession ?: run {
                uiObservers.forEach { it.onActionFailed("session.rename", "Not connected to Host") }
                return@execute
            }
            val opKey = session.newOperationKey("session-rename")
            try {
                val renamed = session.renameSession(sessionId, cleanTitle, opKey)
                val updatedRef = updateCachedSessionTitle(
                    sessionId = renamed.id,
                    title = renamed.title ?: cleanTitle,
                    fallback = renamed,
                )
                uiObservers.forEach { it.onSessionRenamed(updatedRef) }
                uiObservers.forEach { it.onActionSucceeded("session.rename", updatedRef.id) }
            } catch (t: Throwable) {
                val reason = sanitizeErr(t)
                updateStatus(session.phase, session.activeCarrier, session.currentEpoch, "session.rename failed: $reason")
                uiObservers.forEach { it.onActionFailed("session.rename", reason) }
            }
        }
    }

    fun submitPromptAsync(
        sessionId: String,
        prompt: String,
        mode: String? = null,
        attachments: List<PromptImageAttachment> = emptyList(),
        optimisticId: String? = null,
    ) {
        ioExecutor.execute {
            val session = activeSession ?: run {
                uiObservers.forEach {
                    it.onActionFailed("prompt", "Not connected to Host")
                    it.onPromptSubmitFailed(sessionId, optimisticId, "Not connected to Host")
                }
                return@execute
            }
            val opKey = session.newOperationKey("prompt")
            try {
                session.submitPrompt(sessionId, prompt, opKey, mode, attachments)
                uiObservers.forEach {
                    it.onActionSucceeded("prompt", sessionId)
                    it.onPromptSubmitSucceeded(sessionId, optimisticId)
                }
            } catch (t: Throwable) {
                val reason = sanitizeErr(t)
                updateStatus(session.phase, session.activeCarrier, session.currentEpoch, "prompt.submit failed: $reason")
                uiObservers.forEach {
                    it.onActionFailed("prompt", reason)
                    it.onPromptSubmitFailed(sessionId, optimisticId, reason)
                }
            }
        }
    }

    fun abortTurnAsync(sessionId: String, keepInbox: Boolean = false) {
        ioExecutor.execute {
            val session = activeSession ?: run {
                uiObservers.forEach { it.onActionFailed("abort", "Not connected to Host") }
                return@execute
            }
            val opKey = session.newOperationKey("abort-$sessionId")
            try {
                session.abortTurn(sessionId, keepInbox, opKey)
                agentStatusBySession[sessionId] = "idle"
                syncCachedSessionStatus(sessionId, "idle")
                uiObservers.forEach { it.onAgentStatusChanged(sessionId, "idle") }
                var removedApproval = false
                for (item in pendingInteractions.listApprovals()) {
                    if (item.sessionId == sessionId && pendingInteractions.removeApproval(item.callId) != null) {
                        removedApproval = true
                    }
                }
                var removedQuestion = false
                for (item in pendingInteractions.listQuestions()) {
                    if (item.sessionId == sessionId && pendingInteractions.removeQuestion(item.questionId) != null) {
                        removedQuestion = true
                    }
                }
                val hadBaseline = clearSessionPendingBaseline(sessionId)
                if (removedApproval || removedQuestion || hadBaseline) {
                    syncCachedSessionPendingCounts(sessionId)
                    refreshPendingUi(
                        approvalsChanged = removedApproval || hadBaseline,
                        questionsChanged = removedQuestion || hadBaseline,
                    )
                    if (pendingInteractions.peekApproval() == null) {
                        cancelApprovalNotification()
                    }
                }
                uiObservers.forEach { it.onActionSucceeded("abort", sessionId) }
            } catch (t: Throwable) {
                val reason = sanitizeErr(t)
                updateStatus(session.phase, session.activeCarrier, session.currentEpoch, "turn.abort failed: $reason")
                uiObservers.forEach { it.onActionFailed("abort", reason) }
            }
        }
    }

    fun respondApprovalAsync(callId: String, approved: Boolean, explicitKey: String? = null) {
        ioExecutor.execute {
            val session = activeSession ?: run {
                uiObservers.forEach { it.onActionFailed("approval", "Not connected to Host") }
                return@execute
            }
            val opKey = explicitKey ?: session.newOperationKey("approval-$callId")
            try {
                session.respondApproval(callId, approved, opKey)
                val removed = pendingInteractions.removeApproval(callId)
                removed?.sessionId?.let { syncCachedSessionPendingCounts(it) }
                refreshPendingUi(approvalsChanged = true)
                val nextApproval = pendingInteractions.peekApproval()
                if (nextApproval == null) {
                    cancelApprovalNotification()
                } else {
                    postApprovalNotification(nextApproval.callId, nextApproval.summary, countMetric = false)
                }
                uiObservers.forEach { it.onActionSucceeded("approval", callId) }
            } catch (t: Throwable) {
                val reason = sanitizeErr(t)
                updateStatus(session.phase, session.activeCarrier, session.currentEpoch, "approval.respond failed: $reason")
                refreshPendingUi(approvalsChanged = true)
                pendingInteractions.peekApproval()?.let {
                    postApprovalNotification(it.callId, it.summary, countMetric = false)
                }
                uiObservers.forEach { it.onActionFailed("approval", reason) }
            }
        }
    }

    fun respondQuestionAsync(questionId: String, answer: String) {
        respondQuestionInternal(questionId) { session, opKey ->
            session.respondQuestion(questionId, answer, opKey)
        }
    }

    fun respondQuestionStructuredAsync(questionId: String, answerValue: JsonValue) {
        respondQuestionInternal(questionId) { session, opKey ->
            session.respondQuestionJson(questionId, answerValue, opKey)
        }
    }

    private fun respondQuestionInternal(
        questionId: String,
        sendFn: (FailoverRemoteSession, String) -> Unit,
    ) {
        ioExecutor.execute {
            val session = activeSession ?: run {
                uiObservers.forEach { it.onActionFailed("question", "Not connected to Host") }
                return@execute
            }
            val opKey = session.newOperationKey("question-$questionId")
            try {
                sendFn(session, opKey)
                val removed = pendingInteractions.removeQuestion(questionId)
                removed?.sessionId?.let { syncCachedSessionPendingCounts(it) }
                refreshPendingUi(questionsChanged = true)
                uiObservers.forEach { it.onActionSucceeded("question", questionId) }
            } catch (t: Throwable) {
                val reason = sanitizeErr(t)
                updateStatus(session.phase, session.activeCarrier, session.currentEpoch, "question.respond failed: $reason")
                refreshPendingUi(questionsChanged = true)
                uiObservers.forEach { it.onActionFailed("question", reason) }
            }
        }
    }

    fun refreshModelsAsync(sessionId: String? = attachedSessionId, silentOnError: Boolean = false) {
        ioExecutor.execute {
            val session = activeSession ?: run {
                if (!silentOnError) {
                    uiObservers.forEach { it.onActionFailed("model.list", "Not connected to Host") }
                }
                return@execute
            }
            try {
                val catalog = session.listModels(sessionId)
                lastModelCatalog = catalog
                uiObservers.forEach { it.onModelCatalogUpdated(sessionId, catalog) }
                uiObservers.forEach { it.onActionSucceeded("model.list", catalog.currentModel ?: "") }
            } catch (t: Throwable) {
                if (!silentOnError) {
                    val reason = sanitizeErr(t)
                    updateStatus(session.phase, session.activeCarrier, session.currentEpoch, "model.list failed: $reason")
                    uiObservers.forEach { it.onActionFailed("model.list", reason) }
                }
            }
        }
    }

    fun selectModelAsync(
        sessionId: String,
        provider: String,
        model: String,
        reasoningEffort: String? = null,
    ) {
        ioExecutor.execute {
            val session = activeSession ?: run {
                uiObservers.forEach { it.onActionFailed("model.select", "Not connected to Host") }
                return@execute
            }
            val opKey = session.newOperationKey("model-select")
            try {
                val selected = session.selectModel(sessionId, provider, model, reasoningEffort, opKey)
                val updated = lastModelCatalog?.copy(
                    currentProvider = selected.provider,
                    currentModel = selected.model,
                    currentReasoningEffort = reasoningEffort ?: lastModelCatalog?.currentReasoningEffort,
                ) ?: ModelCatalogResult(
                    currentProvider = selected.provider,
                    currentModel = selected.model,
                    currentReasoningEffort = reasoningEffort,
                    models = listOf(selected),
                )
                lastModelCatalog = updated
                uiObservers.forEach { it.onModelCatalogUpdated(sessionId, updated) }
                uiObservers.forEach { it.onActionSucceeded("model.select", "${selected.provider}/${selected.model}") }
            } catch (t: Throwable) {
                val reason = sanitizeErr(t)
                updateStatus(session.phase, session.activeCarrier, session.currentEpoch, "model.select failed: $reason")
                uiObservers.forEach { it.onActionFailed("model.select", reason) }
            }
        }
    }

    fun loadHistoryAsync(sessionId: String, beforeSeq: Long? = null, limit: Int = 50) {
        ioExecutor.execute {
            val session = activeSession ?: run {
                uiObservers.forEach { it.onActionFailed("session.history", "Not connected to Host") }
                return@execute
            }
            try {
                val history = session.getSessionHistory(sessionId, beforeSeq = beforeSeq, limit = limit)
                uiObservers.forEach { it.onSessionHistoryLoaded(history) }
                uiObservers.forEach { it.onActionSucceeded("session.history", sessionId) }
            } catch (t: Throwable) {
                val reason = sanitizeErr(t)
                uiObservers.forEach { it.onActionFailed("session.history", reason) }
            }
        }
    }

    fun searchSessionsAsync(query: String, sessionId: String? = null, limit: Int = 30) {
        ioExecutor.execute {
            val cleanQuery = query.trim()
            if (cleanQuery.isEmpty()) {
                uiObservers.forEach { it.onActionFailed("session.search", "Search query must not be empty") }
                return@execute
            }
            val session = activeSession ?: run {
                uiObservers.forEach { it.onActionFailed("session.search", "Not connected to Host") }
                return@execute
            }
            try {
                val results = session.searchSessions(cleanQuery, sessionId = sessionId, limit = limit)
                uiObservers.forEach { it.onSessionSearchResults(results) }
                uiObservers.forEach { it.onActionSucceeded("session.search", cleanQuery) }
            } catch (t: Throwable) {
                val reason = sanitizeErr(t)
                uiObservers.forEach { it.onActionFailed("session.search", reason) }
            }
        }
    }

    fun forkSessionAsync(
        sessionId: String,
        atSeq: Long? = null,
        title: String? = null,
        autoAttach: Boolean = true,
    ) {
        ioExecutor.execute {
            val session = activeSession ?: run {
                uiObservers.forEach { it.onActionFailed("session.fork", "Not connected to Host") }
                return@execute
            }
            val opKey = session.newOperationKey("session-fork")
            try {
                val forked = session.forkSession(sessionId, atSeq = atSeq, title = title, idempotencyKey = opKey)
                val refreshed = try {
                    session.listSessions()
                } catch (_: Throwable) {
                    synchronized(sessionsLock) {
                        listOf(forked) + lastSessions.filterNot { it.id == forked.id }
                    }
                }
                storeHostSessionsSnapshot(refreshed)
                uiObservers.forEach { it.onSessionsUpdated(refreshed) }
                uiObservers.forEach { it.onSessionForked(forked) }
                uiObservers.forEach { it.onActionSucceeded("session.fork", forked.id) }
                if (autoAttach) {
                    attachSessionInternal(session, forked.id)
                }
            } catch (t: Throwable) {
                val reason = sanitizeErr(t)
                updateStatus(session.phase, session.activeCarrier, session.currentEpoch, "session.fork failed: $reason")
                uiObservers.forEach { it.onActionFailed("session.fork", reason) }
            }
        }
    }

    fun listCommandsAsync(sessionId: String? = attachedSessionId) {
        ioExecutor.execute {
            val session = activeSession ?: run {
                uiObservers.forEach { it.onActionFailed("command.list", "Not connected to Host") }
                return@execute
            }
            try {
                val commands = session.listCommands(sessionId)
                uiObservers.forEach { it.onCommandsListed(sessionId, commands) }
                uiObservers.forEach { it.onActionSucceeded("command.list", "${commands.size}") }
            } catch (t: Throwable) {
                val reason = sanitizeErr(t)
                uiObservers.forEach { it.onActionFailed("command.list", reason) }
            }
        }
    }

    fun executeCommandAsync(sessionId: String, command: String) {
        ioExecutor.execute {
            val session = activeSession ?: run {
                uiObservers.forEach { it.onActionFailed("command.execute", "Not connected to Host") }
                return@execute
            }
            val opKey = session.newOperationKey("cmd")
            try {
                val res = session.executeCommand(sessionId, command, idempotencyKey = opKey)
                uiObservers.forEach { it.onCommandExecuted(sessionId, command, res) }
                uiObservers.forEach { it.onActionSucceeded("command.execute", res.commandId ?: command) }
            } catch (t: Throwable) {
                val reason = sanitizeErr(t)
                uiObservers.forEach { it.onActionFailed("command.execute", reason) }
            }
        }
    }

    fun listSkillsAsync(sessionId: String? = attachedSessionId) {
        ioExecutor.execute {
            val session = activeSession ?: run {
                uiObservers.forEach { it.onActionFailed("skill.list", "Not connected to Host") }
                return@execute
            }
            try {
                val skills = session.listSkills(sessionId)
                uiObservers.forEach { it.onSkillsListed(sessionId, skills) }
                uiObservers.forEach { it.onActionSucceeded("skill.list", "${skills.size}") }
            } catch (t: Throwable) {
                val reason = sanitizeErr(t)
                uiObservers.forEach { it.onActionFailed("skill.list", reason) }
            }
        }
    }

    fun fetchWorkspaceGitDiffAsync(
        sessionId: String,
        path: String? = null,
        staged: Boolean = false,
    ) {
        ioExecutor.execute {
            val session = activeSession ?: run {
                uiObservers.forEach { it.onActionFailed("workspace.git.diff", "Not connected to Host") }
                return@execute
            }
            try {
                val status = session.getWorkspaceGitStatus(sessionId)
                val diff = session.getWorkspaceGitDiff(sessionId, path = path, staged = staged)
                uiObservers.forEach { it.onWorkspaceGitDiffLoaded(sessionId, status, diff) }
                uiObservers.forEach { it.onActionSucceeded("workspace.git.diff", sessionId) }
            } catch (t: Throwable) {
                val reason = sanitizeErr(t)
                uiObservers.forEach { it.onActionFailed("workspace.git.diff", reason) }
            }
        }
    }

    fun failoverAsync() {
        ioExecutor.execute {
            val session = activeSession ?: return@execute
            val attempt = reconnectAttempts.incrementAndGet()
            try {
                updateStatus(
                    RemoteConnectionPhase.CONNECTING,
                    session.activeCarrier,
                    session.currentEpoch,
                    "Failing over carrier (attempt #$attempt)...",
                )
                session.failoverAndResume()
                consecutiveReconnectFailures.set(0)
                autoReconnectEligible.set(true)
                activeHostFingerprint?.let { fp ->
                    highestEpochByHost.merge(fp, session.currentEpoch, ::maxOf)
                }
                startHeartbeat(session)
                try {
                    val sessions = session.listSessions()
                    storeHostSessionsSnapshot(sessions)
                    uiObservers.forEach { it.onSessionsUpdated(sessions) }
                } catch (_: Throwable) {
                    // Best-effort refresh; stream replay already resumed.
                }
                updateStatus(
                    session.phase,
                    session.activeCarrier,
                    session.currentEpoch,
                    "Connected via ${session.activeCarrier?.wireName} (epoch ${session.currentEpoch})",
                )
            } catch (t: Throwable) {
                if (t is PeerRevokedException || session.revokedByHost) {
                    stopHeartbeat()
                    autoReconnectEligible.set(false)
                    handlePeerRevocation(
                        activeHostFingerprint ?: "",
                        session,
                        sanitizeErr(t),
                    )
                } else {
                    val reason = sanitizeErr(t)
                    updateStatus(RemoteConnectionPhase.FAILED, null, session.currentEpoch, "Failover failed: $reason")
                    scheduleBatterySafeReconnect(session, session.activeCarrier ?: TransportKind.RELAY, reason)
                }
            } finally {
                persistStats()
            }
        }
    }

    fun disconnect() {
        autoReconnectEligible.set(false)
        consecutiveReconnectFailures.set(0)
        stopHeartbeat()
        cancelApprovalNotification()
        synchronized(reconnectLock) {
            reconnectFuture?.cancel(false)
            reconnectFuture = null
        }
        val toClose = activeSession
        activeSession = null
        synchronized(sessionsLock) {
            lastSessions = emptyList()
            pendingTracker.clearBaselines()
        }
        attachedSessionId = null
        lastModelCatalog = null
        agentStatusBySession.clear()
        pendingAckSeqs.clear()
        clearReplayEvents()
        pendingInteractions.clearAll()
        refreshPendingUi(approvalsChanged = true, questionsChanged = true)
        uiObservers.forEach { it.onSessionsUpdated(emptyList()) }
        updateStatus(RemoteConnectionPhase.DISCONNECTED, null, 0, "Disconnected")
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        closeSessionOffMainThread(toClose, "user disconnect")
    }

    private fun connectProfileInternal(profile: RemoteEndpointProfile, displayName: String) {
        val prevFp = activeHostFingerprint
        val hostChanged = prevFp != null && !prevFp.equals(profile.hostFingerprint, ignoreCase = true)
        synchronized(reconnectLock) {
            reconnectFuture?.cancel(false)
            reconnectFuture = null
        }
        stopHeartbeat()
        autoReconnectEligible.set(false)
        consecutiveReconnectFailures.set(0)
        val previousSession = activeSession
        activeSession = null
        closeSessionOffMainThread(previousSession, "reconnecting")

        if (hostChanged) {
            synchronized(sessionsLock) {
                lastSessions = emptyList()
                pendingTracker.clearBaselines()
            }
            attachedSessionId = null
            lastModelCatalog = null
            agentStatusBySession.clear()
            pendingAckSeqs.clear()
            clearReplayEvents()
            pendingInteractions.clearAll()
            cancelApprovalNotification()
            refreshPendingUi(approvalsChanged = true, questionsChanged = true)
            uiObservers.forEach { it.onSessionsUpdated(emptyList()) }
        }

        lastProfile = profile
        lastDisplayName = displayName
        activeHostFingerprint = profile.hostFingerprint
        notifyTrustedHosts()

        val identity = ensureDeviceIdentity()
        val initialHighestEpoch = highestEpochByHost[profile.hostFingerprint] ?: 0
        val session = FailoverRemoteSession(
            identity,
            profile,
            webRtcPeerEngine = AndroidWebRtcPeerEngine(applicationContext),
            initialHighestEpoch = initialHighestEpoch,
            failureCooldownMs = 15_000L,
        )
        session.addListener(
            object : FailoverRemoteSession.Listener {
                override fun onPhaseChanged(phase: RemoteConnectionPhase, carrier: TransportKind?, epoch: Int) {
                    if (epoch > 0) {
                        highestEpochByHost.merge(profile.hostFingerprint, epoch, ::maxOf)
                    }
                    val label = "${phase.name} via ${carrier?.wireName ?: "-"} (epoch=$epoch)"
                    updateStatus(phase, carrier, epoch, label)
                }

                override fun onStreamEvent(sessionId: String, event: OfficialSessionEvent) {
                    enqueueReplayEvent(sessionId, event)
                    dispatchEventToObservers(sessionId, event)
                    enqueueStreamAck(session, sessionId, event.seq)
                }

                override fun onStreamReset(sessionId: String, reason: String) {
                    clearReplayEvents(sessionId)
                    agentStatusBySession.remove(sessionId)
                    syncCachedSessionStatus(sessionId, "idle")
                    uiObservers.forEach { it.onAgentStatusChanged(sessionId, "idle") }
                    for (item in pendingInteractions.listApprovals()) {
                        if (item.sessionId == sessionId) {
                            pendingInteractions.removeApproval(item.callId)
                        }
                    }
                    for (item in pendingInteractions.listQuestions()) {
                        if (item.sessionId == sessionId) {
                            pendingInteractions.removeQuestion(item.questionId)
                        }
                    }
                    clearSessionPendingBaseline(sessionId)
                    syncCachedSessionPendingCounts(sessionId)
                    refreshPendingUi(approvalsChanged = true, questionsChanged = true)
                    if (pendingInteractions.peekApproval() == null) {
                        cancelApprovalNotification()
                    }
                    val cleanReason = DisplayTextSanitizer.sanitizeSingleLine(reason)
                    uiObservers.forEach { it.onStreamReset(sessionId, cleanReason) }
                }

                override fun onPeerRevoked(reason: String) {
                    stopHeartbeat()
                    autoReconnectEligible.set(false)
                    handlePeerRevocation(profile.hostFingerprint, session, reason)
                }

                override fun onTransportClosed(carrier: TransportKind, reason: String) {
                    stopHeartbeat()
                    scheduleBatterySafeReconnect(session, carrier, reason)
                }
            },
        )
        activeSession = session
        try {
            val phase = session.connect()
            if (phase == RemoteConnectionPhase.PAIRING_PENDING && !profile.bootstrapToken.isNullOrBlank()) {
                val res = session.requestPairing(displayName, profile.bootstrapToken)
                val cid = DisplayTextSanitizer.sanitizeSingleLine(res.str("candidateId") ?: "pending")
                trustedHostStore.upsertTrustedHost(
                    hostPublicKey = profile.hostPublicKey,
                    lanUrl = profile.lanUrl,
                    signalingUrl = profile.signalingUrl,
                    signalingRoomId = profile.signalingRoomId,
                    stunUrls = profile.stunUrls,
                    relayUrl = profile.relayUrl,
                    relayRoomId = profile.relayRoomId,
                    markConnected = false,
                )
                notifyTrustedHosts()
                updateStatus(
                    phase,
                    session.activeCarrier,
                    session.currentEpoch,
                    "Pairing requested (candidate=$cid); confirm on Host then Reconnect",
                )
            } else if (phase == RemoteConnectionPhase.ACTIVE) {
                consecutiveReconnectFailures.set(0)
                autoReconnectEligible.set(true)
                highestEpochByHost.merge(profile.hostFingerprint, session.currentEpoch, ::maxOf)
                trustedHostStore.upsertTrustedHost(
                    hostPublicKey = profile.hostPublicKey,
                    lanUrl = profile.lanUrl,
                    signalingUrl = profile.signalingUrl,
                    signalingRoomId = profile.signalingRoomId,
                    stunUrls = profile.stunUrls,
                    relayUrl = profile.relayUrl,
                    relayRoomId = profile.relayRoomId,
                    markConnected = true,
                )
                trustedHostStore.get(profile.hostFingerprint)?.let { saved ->
                    lastProfile = RemoteEndpointProfile.fromTrustedRecord(saved, profile.lanUrl)
                }
                notifyTrustedHosts()
                val sessions = session.listSessions()
                storeHostSessionsSnapshot(sessions)
                startHeartbeat(session)
                updateStatus(
                    phase,
                    session.activeCarrier,
                    session.currentEpoch,
                    "Connected (${sessions.size} official session${if (sessions.size == 1) "" else "s"})",
                )
                uiObservers.forEach { it.onSessionsUpdated(sessions) }
            }
        } catch (t: Throwable) {
            if (t is PeerRevokedException || session.revokedByHost) {
                stopHeartbeat()
                autoReconnectEligible.set(false)
                handlePeerRevocation(
                    profile.hostFingerprint,
                    session,
                    sanitizeErr(t),
                )
            } else {
                if (profile.bootstrapToken == null) {
                    autoReconnectEligible.set(true)
                }
                updateStatus(RemoteConnectionPhase.FAILED, null, session.currentEpoch, "Connect failed: ${sanitizeErr(t)}")
            }
        } finally {
            persistStats()
        }
    }

    private fun handlePeerRevocation(
        hostFingerprint: String,
        session: FailoverRemoteSession,
        reason: String,
    ) {
        autoReconnectEligible.set(false)
        stopHeartbeat()
        synchronized(reconnectLock) {
            reconnectFuture?.cancel(false)
            reconnectFuture = null
        }
        val cleanReason = DisplayTextSanitizer.sanitizeSingleLine(reason)
        if (hostFingerprint.isNotBlank()) {
            highestEpochByHost.remove(hostFingerprint)
            trustedHostStore.markRevoked(hostFingerprint, cleanReason)
            notifyTrustedHosts()
            uiObservers.forEach { it.onPeerRevoked(hostFingerprint, cleanReason) }
        }
        updateStatus(RemoteConnectionPhase.REVOKED, null, session.currentEpoch, "REVOKED: $cleanReason")
    }

    private fun notifyTrustedHosts() {
        val snapshot = trustedHostStore.list()
        val fp = activeHostFingerprint
        uiObservers.forEach { it.onTrustedHostsChanged(snapshot, fp) }
    }

    private fun scheduleBatterySafeReconnect(session: FailoverRemoteSession, droppedCarrier: TransportKind, reason: String) {
        if (session.revokedByHost || session.phase == RemoteConnectionPhase.REVOKED) return
        if (!autoReconnectEligible.get() || activeSession !== session) return
        val cleanReason = DisplayTextSanitizer.sanitizeSingleLine(reason)
        if (!hasUsableNetwork()) {
            updateStatus(
                RemoteConnectionPhase.FAILED,
                null,
                session.currentEpoch,
                "Waiting for network ($droppedCarrier closed: $cleanReason)",
            )
            return
        }
        val failureAttempt = consecutiveReconnectFailures.incrementAndGet()
        if (failureAttempt > 5) {
            updateStatus(
                RemoteConnectionPhase.FAILED,
                null,
                session.currentEpoch,
                "Stopped reconnect after 5 attempts (battery guard)",
            )
            return
        }
        val delayMs = BackoffPolicy.nextDelayMs(failureAttempt - 1)
        updateStatus(
            RemoteConnectionPhase.CONNECTING,
            null,
            session.currentEpoch,
            "$droppedCarrier closed ($cleanReason); failover in ${delayMs}ms",
        )
        synchronized(reconnectLock) {
            reconnectFuture?.cancel(false)
            reconnectFuture = ioExecutor.schedule(
                {
                    if (activeSession === session && autoReconnectEligible.get() && hasUsableNetwork()) {
                        failoverAsync()
                    }
                },
                delayMs,
                TimeUnit.MILLISECONDS,
            )
        }
    }

    private fun storeHostSessionsSnapshot(sessions: List<SessionRef>) {
        synchronized(sessionsLock) {
            pendingTracker.applySessionSnapshot(sessions)
            lastSessions = sessions
            for (ref in sessions) {
                val st = ref.status?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
                if (st != null) {
                    agentStatusBySession[ref.id] = st
                }
            }
        }
    }

    private fun clearSessionPendingBaseline(sessionId: String): Boolean =
        pendingTracker.clearSessionBaseline(sessionId)

    private fun syncCachedSessionPendingCounts(sessionId: String) {
        val (effA, effQ) = pendingTracker.effectiveCounts(sessionId)
        synchronized(sessionsLock) {
            lastSessions = syncPendingCountsInSessionList(lastSessions, sessionId, effA, effQ)
        }
    }

    private fun syncCachedSessionStatus(sessionId: String, status: String) {
        synchronized(sessionsLock) {
            lastSessions = syncStatusInSessionList(lastSessions, sessionId, status)
        }
    }

    private fun updateCachedSessionTitle(
        sessionId: String,
        title: String,
        fallback: SessionRef? = null,
    ): SessionRef = synchronized(sessionsLock) {
        val (updatedList, updatedRef) = upsertSessionTitleInList(
            sessions = lastSessions,
            sessionId = sessionId,
            title = title,
            liveStatus = agentStatusBySession[sessionId],
            fallback = fallback,
        )
        lastSessions = updatedList
        updatedRef
    }

    private fun dispatchEventToObservers(
        sessionId: String,
        event: OfficialSessionEvent,
        fromReplay: Boolean = false,
        replayBatch: ReplayBatchContext? = null,
    ) {
        uiObservers.forEach { it.onEventReceived(sessionId, event) }
        val dataObj = event.data as? JsonObject ?: return
        if (event.type == "agent/status") {
            val status = dataObj.str("status")?.trim()?.lowercase()?.ifBlank { "idle" } ?: "idle"
            agentStatusBySession[sessionId] = status
            syncCachedSessionStatus(sessionId, status)
            uiObservers.forEach { it.onAgentStatusChanged(sessionId, status) }
            return
        }
        if (event.type == "turn/end") {
            agentStatusBySession[sessionId] = "idle"
            syncCachedSessionStatus(sessionId, "idle")
            uiObservers.forEach { it.onAgentStatusChanged(sessionId, "idle") }
            return
        }
        if (event.type == "session/title") {
            val title = dataObj.str("title")?.trim()?.takeIf { it.isNotEmpty() } ?: return
            val updatedRef = updateCachedSessionTitle(sessionId, title)
            uiObservers.forEach { it.onSessionRenamed(updatedRef) }
            return
        }
        if (event.type == "session.model" || event.type == "model.selected") {
            val provider = dataObj.str("provider")
            val model = dataObj.str("model")
            val effort = dataObj.str("reasoningEffort")
            if (!provider.isNullOrBlank() && !model.isNullOrBlank()) {
                val updated = (lastModelCatalog ?: ModelCatalogResult(null, null, null, emptyList())).copy(
                    currentProvider = provider,
                    currentModel = model,
                    currentReasoningEffort = effort ?: lastModelCatalog?.currentReasoningEffort,
                )
                lastModelCatalog = updated
                uiObservers.forEach { it.onModelCatalogUpdated(sessionId, updated) }
            }
            return
        }
        if (event.type == "approval.resolved") {
            val resolvedCallId = dataObj.str("callId")
            val removedSessionId = pendingTracker.resolveApproval(
                sessionId = sessionId,
                callId = resolvedCallId,
                fromReplay = fromReplay,
                replayBatch = replayBatch,
            )
            syncCachedSessionPendingCounts(removedSessionId)
            refreshPendingUi(approvalsChanged = true)
            val nextApproval = pendingInteractions.peekApproval()
            if (nextApproval == null) {
                cancelApprovalNotification()
            } else {
                postApprovalNotification(nextApproval.callId, nextApproval.summary, countMetric = false)
            }
            return
        }
        if (event.type == "question.resolved") {
            val resolvedQuestionId = dataObj.str("questionId")
            val removedSessionId = pendingTracker.resolveQuestion(
                sessionId = sessionId,
                questionId = resolvedQuestionId,
                fromReplay = fromReplay,
                replayBatch = replayBatch,
            )
            syncCachedSessionPendingCounts(removedSessionId)
            refreshPendingUi(questionsChanged = true)
            return
        }
        if (event.type.contains("approval", ignoreCase = true) || event.type.contains("permission", ignoreCase = true)) {
            val callId = dataObj.str("callId") ?: return
            val toolLabel = dataObj.str("toolName") ?: dataObj.str("tool") ?: dataObj.str("summary") ?: event.type
            val reason = dataObj.str("reason")
            val rawSummary = if (!reason.isNullOrBlank()) "$toolLabel — $reason" else toolLabel
            val summary = DisplayTextSanitizer.sanitizeSingleLine(rawSummary)
            val added = pendingTracker.enqueueApproval(
                callId = callId,
                summary = summary,
                sessionId = sessionId,
                fromReplay = fromReplay,
                replayBatch = replayBatch,
            )
            syncCachedSessionPendingCounts(sessionId)
            val approvals = pendingInteractions.listApprovals()
            uiObservers.forEach { it.onPendingApprovalsChanged(approvals) }
            approvals.firstOrNull()?.let { head ->
                uiObservers.forEach { it.onPendingApproval(head.callId, head.summary) }
            }
            val headForNotif = approvals.firstOrNull() ?: PendingApprovalItem(callId, summary, sessionId)
            postApprovalNotification(headForNotif.callId, headForNotif.summary, countMetric = added)
        } else if (event.type.contains("question", ignoreCase = true)) {
            val questionId = dataObj.str("questionId") ?: return
            val specs = RemoteFrameCodec.parseQuestionSpecs(dataObj)
            val firstQuestion = dataObj.arr("questions")?.items?.firstOrNull() as? JsonObject
            val rawPrompt = dataObj.str("prompt")
                ?: dataObj.str("question")
                ?: specs.firstOrNull()?.question
                ?: firstQuestion?.str("question")
                ?: firstQuestion?.str("prompt")
                ?: firstQuestion?.str("header")
                ?: event.type
            val prompt = DisplayTextSanitizer.sanitizeSingleLine(rawPrompt)
            val added = pendingTracker.enqueueQuestion(
                questionId = questionId,
                prompt = prompt,
                sessionId = sessionId,
                specs = specs,
                fromReplay = fromReplay,
                replayBatch = replayBatch,
            )
            syncCachedSessionPendingCounts(sessionId)
            val questions = pendingInteractions.listQuestions()
            uiObservers.forEach { it.onPendingQuestionsChanged(questions) }
            questions.firstOrNull()?.let { head ->
                uiObservers.forEach { it.onPendingQuestion(head.questionId, head.prompt) }
            }
        }
    }

    private fun updateStatus(phase: RemoteConnectionPhase, carrier: TransportKind?, epoch: Int, message: String) {
        val cleanMsg = DisplayTextSanitizer.sanitizeSingleLine(message)
        statusText = cleanMsg
        lastStatusMessage.set(System.currentTimeMillis())
        val id = ensureDeviceIdentity()
        ensureForeground(cleanMsg)
        val stats = currentStats()
        uiObservers.forEach {
            it.onStatusChanged(phase, carrier, epoch, id.deviceId, cleanMsg)
            it.onMetricsUpdated(id, stats)
        }
    }

    private fun sanitizeErr(t: Throwable): String =
        DisplayTextSanitizer.sanitizeSingleLine(t.message).ifBlank { t.javaClass.simpleName }

    private fun closeSessionOffMainThread(session: FailoverRemoteSession?, reason: String) {
        if (session == null) return
        Thread(
            {
                try {
                    session.close(reason)
                } catch (_: Throwable) {
                }
            },
            "dsh-remote-close",
        ).apply {
            isDaemon = true
            start()
        }
    }

    private fun enqueueReplayEvent(sessionId: String, event: OfficialSessionEvent) {
        synchronized(replayLock) {
            recentEvents.addLast(sessionId to event)
            while (recentEvents.size > MAX_REPLAY_EVENTS) {
                recentEvents.removeFirst()
            }
        }
    }

    private fun clearReplayEvents(sessionId: String? = null) {
        synchronized(replayLock) {
            if (sessionId == null) {
                recentEvents.clear()
            } else {
                val it = recentEvents.iterator()
                while (it.hasNext()) {
                    if (it.next().first == sessionId) {
                        it.remove()
                    }
                }
            }
        }
    }

    private fun enqueueStreamAck(session: FailoverRemoteSession, sessionId: String, seq: Long) {
        pendingAckSeqs.merge(sessionId, seq, ::maxOf)
        val scheduledFlag = ackScheduled.computeIfAbsent(sessionId) { AtomicBoolean(false) }
        if (!scheduledFlag.compareAndSet(false, true)) {
            return
        }
        try {
            ackExecutor.execute {
                try {
                    scheduledFlag.set(false)
                    val targetSeq = pendingAckSeqs[sessionId] ?: return@execute
                    val confirmed = session.getLastConfirmedSeq(sessionId) ?: -1L
                    if (targetSeq > confirmed && activeSession === session && session.isTransportOpen()) {
                        session.ackStream(sessionId, targetSeq)
                    }
                } catch (_: Throwable) {
                    // Best-effort ack; next attach resumes from confirmed cursor.
                }
            }
        } catch (_: Throwable) {
            scheduledFlag.set(false)
        }
    }

    private fun stopHeartbeat() {
        heartbeatFuture?.cancel(false)
        heartbeatFuture = null
    }

    private fun startHeartbeat(session: FailoverRemoteSession) {
        stopHeartbeat()
        try {
            heartbeatFuture = heartbeatExecutor.scheduleWithFixedDelay(
                {
                    if (activeSession !== session || session.phase != RemoteConnectionPhase.ACTIVE) {
                        stopHeartbeat()
                        return@scheduleWithFixedDelay
                    }
                    if (!hasUsableNetwork()) {
                        return@scheduleWithFixedDelay
                    }
                    try {
                        val ok = session.ping()
                        if (!ok) {
                            throw IOException("heartbeat ping returned not ok")
                        }
                    } catch (t: Throwable) {
                        stopHeartbeat()
                        if (t is PeerRevokedException || session.revokedByHost) {
                            handlePeerRevocation(
                                activeHostFingerprint ?: "",
                                session,
                                sanitizeErr(t),
                            )
                        } else {
                            val carrier = session.activeCarrier ?: TransportKind.LAN
                            scheduleBatterySafeReconnect(session, carrier, "heartbeat failed: ${sanitizeErr(t)}")
                        }
                    }
                },
                HEARTBEAT_INTERVAL_MS,
                HEARTBEAT_INTERVAL_MS,
                TimeUnit.MILLISECONDS,
            )
        } catch (_: Throwable) {
            // Executor already shutting down during service destroy.
        }
    }

    private fun refreshPendingUi(approvalsChanged: Boolean = false, questionsChanged: Boolean = false) {
        if (approvalsChanged) {
            val approvals = pendingInteractions.listApprovals()
            uiObservers.forEach { it.onPendingApprovalsChanged(approvals) }
            approvals.firstOrNull()?.let { head ->
                uiObservers.forEach { it.onPendingApproval(head.callId, head.summary) }
            }
        }
        if (questionsChanged) {
            val questions = pendingInteractions.listQuestions()
            uiObservers.forEach { it.onPendingQuestionsChanged(questions) }
            questions.firstOrNull()?.let { head ->
                uiObservers.forEach { it.onPendingQuestion(head.questionId, head.prompt) }
            }
        }
    }

    private fun hasUsableNetwork(): Boolean {
        if (activeNetworks.isNotEmpty()) return true
        val cm = connectivityManager ?: return true
        return try {
            val active = cm.activeNetwork ?: return false
            val caps = cm.getNetworkCapabilities(active) ?: return true
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        } catch (_: Throwable) {
            true
        }
    }

    private fun resumeAfterNetworkRestore() {
        if (!autoReconnectEligible.get() || !hasUsableNetwork()) return
        try {
            ioExecutor.execute {
                if (!autoReconnectEligible.get() || !hasUsableNetwork()) return@execute
                val current = activeSession
                if (current != null) {
                    if (current.revokedByHost || current.phase == RemoteConnectionPhase.REVOKED) return@execute
                    if (current.phase == RemoteConnectionPhase.ACTIVE && current.isTransportOpen()) return@execute
                    if (current.phase == RemoteConnectionPhase.CONNECTING ||
                        current.phase == RemoteConnectionPhase.PAIRING_PENDING
                    ) {
                        return@execute
                    }
                    consecutiveReconnectFailures.set(0)
                    failoverAsync()
                    return@execute
                }
                val savedFp = activeHostFingerprint
                val tokenlessProfile = savedFp?.let { trustedHostStore.get(it) }
                    ?.takeIf { !it.isRevoked }
                    ?.let { RemoteEndpointProfile.fromTrustedRecord(it, lastProfile?.lanUrl) }
                    ?: lastProfile?.takeIf { it.bootstrapToken == null }
                    ?: return@execute
                consecutiveReconnectFailures.set(0)
                connectProfileInternal(tokenlessProfile, lastDisplayName)
            }
        } catch (_: Throwable) {
            // Service shutting down.
        }
    }

    private fun ensureDeviceIdentity(): DeviceIdentity {
        deviceIdentity?.let { return it }
        val created = EncryptedDeviceIdentityStore.createForAndroid(this).loadOrCreate()
        deviceIdentity = created
        return created
    }

    private fun registerNetworkObserver() {
        if (!networkObserverRegistered.compareAndSet(false, true)) return
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: run {
            networkObserverRegistered.set(false)
            return
        }
        connectivityManager = cm
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val prevCount = activeNetworks.size
                activeNetworks.add(network)
                val s = activeSession
                if (s != null && s.phase == RemoteConnectionPhase.ACTIVE && s.activeCarrier == TransportKind.LAN) {
                    // Default network may have switched (e.g. Wi-Fi -> Cellular); probe LAN socket liveness off main thread.
                    try {
                        ioExecutor.execute {
                            if (activeSession === s && s.phase == RemoteConnectionPhase.ACTIVE) {
                                try {
                                    if (!s.ping()) throw IOException("ping returned false")
                                } catch (t: Throwable) {
                                    scheduleBatterySafeReconnect(s, TransportKind.LAN, "network switch: ${sanitizeErr(t)}")
                                }
                            }
                        }
                    } catch (_: Throwable) {
                    }
                } else if (prevCount == 0 || (s != null && s.phase == RemoteConnectionPhase.FAILED)) {
                    resumeAfterNetworkRestore()
                }
            }

            override fun onLost(network: Network) {
                activeNetworks.remove(network)
                networkLosses.incrementAndGet()
                persistStats()
                val s = activeSession
                if (hasUsableNetwork() && s != null && s.phase == RemoteConnectionPhase.ACTIVE) {
                    try {
                        ioExecutor.execute {
                            if (activeSession === s && s.phase == RemoteConnectionPhase.ACTIVE) {
                                try {
                                    if (!s.ping()) throw IOException("ping returned false")
                                } catch (t: Throwable) {
                                    val carrier = s.activeCarrier ?: TransportKind.LAN
                                    scheduleBatterySafeReconnect(s, carrier, "network lost: ${sanitizeErr(t)}")
                                }
                            }
                        }
                    } catch (_: Throwable) {
                    }
                }
            }
        }
        networkCallback = cb
        try {
            cm.registerDefaultNetworkCallback(cb)
        } catch (_: SecurityException) {
            networkObserverRegistered.set(false)
            // Permission check guarded defensively
        }
    }

    private fun unregisterNetworkObserver() {
        val cm = connectivityManager
        val cb = networkCallback
        if (cm != null && cb != null) {
            try {
                cm.unregisterNetworkCallback(cb)
            } catch (_: IllegalArgumentException) {
            }
        }
        networkCallback = null
        networkObserverRegistered.set(false)
        activeNetworks.clear()
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(
                NotificationChannel(
                    STATUS_CHANNEL_ID,
                    "DSH Remote Session",
                    NotificationManager.IMPORTANCE_LOW,
                ),
            )
            nm.createNotificationChannel(
                NotificationChannel(
                    APPROVAL_CHANNEL_ID,
                    "DSH Remote Approvals",
                    NotificationManager.IMPORTANCE_HIGH,
                ),
            )
        }
    }

    private fun serviceActionPendingIntent(requestCode: Int, actionIntent: Intent): PendingIntent {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            PendingIntent.getForegroundService(this, requestCode, actionIntent, flags)
        } else {
            PendingIntent.getService(this, requestCode, actionIntent, flags)
        }
    }

    private fun cancelApprovalNotification() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        nm?.cancel(APPROVAL_NOTIFICATION_ID)
    }

    private fun ensureForeground(contentText: String) {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val disconnectIntent = serviceActionPendingIntent(
            1,
            Intent(this, RemoteSessionService::class.java).setAction(ACTION_DISCONNECT),
        )
        val notification: Notification = NotificationCompat.Builder(this, STATUS_CHANNEL_ID)
            .setContentTitle("DSH Remote Client [LABS]")
            .setContentText(contentText)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Disconnect", disconnectIntent)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                FOREGROUND_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(FOREGROUND_NOTIFICATION_ID, notification)
        }
    }

    private fun postApprovalNotification(callId: String, summary: String, countMetric: Boolean = true) {
        if (countMetric) {
            approvalNotifications.incrementAndGet()
        }
        val cleanCallId = DisplayTextSanitizer.sanitizeSingleLine(callId)
        val cleanSummary = DisplayTextSanitizer.sanitizeSingleLine(summary)
        val pendingCount = pendingInteractions.listApprovals().size
        val title = if (pendingCount > 1) {
            "Tool Approval Required ($cleanCallId) (+${pendingCount - 1} more)"
        } else {
            "Tool Approval Required ($cleanCallId)"
        }
        val idempotencyKey = activeSession?.newOperationKey("notif-$cleanCallId") ?: "notif-$cleanCallId"

        val approveIntent = serviceActionPendingIntent(
            10,
            Intent(this, RemoteSessionService::class.java)
                .setAction(ACTION_APPROVE_CALL)
                .putExtra(EXTRA_CALL_ID, callId)
                .putExtra(EXTRA_IDEMPOTENCY_KEY, idempotencyKey),
        )
        val rejectIntent = serviceActionPendingIntent(
            11,
            Intent(this, RemoteSessionService::class.java)
                .setAction(ACTION_REJECT_CALL)
                .putExtra(EXTRA_CALL_ID, callId)
                .putExtra(EXTRA_IDEMPOTENCY_KEY, idempotencyKey),
        )

        val notification = NotificationCompat.Builder(this, APPROVAL_CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(cleanSummary)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .addAction(android.R.drawable.ic_input_add, "Approve", approveIntent)
            .addAction(android.R.drawable.ic_delete, "Reject", rejectIntent)
            .build()

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        ) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(APPROVAL_NOTIFICATION_ID, notification)
        }
        persistStats()
    }

    private fun persistStats() {
        val stats = currentStats()
        try {
            File(noBackupFilesDir, STATS_FILE).writeText(stats.toJson())
        } catch (_: Throwable) {
            // Diagnostic telemetry must never crash foreground transport
        }
        val id = deviceIdentity
        if (id != null) {
            uiObservers.forEach { it.onMetricsUpdated(id, stats) }
        }
    }
}
