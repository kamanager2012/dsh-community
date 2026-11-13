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
import org.dsh.community.android.protocol.JsonCodec
import org.dsh.community.android.protocol.JsonNumber
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.JsonString
import org.dsh.community.android.protocol.OfficialSessionEvent
import org.dsh.community.android.protocol.SessionRef
import org.dsh.community.android.transport.DiscoveredLanHost
import org.dsh.community.android.transport.FailoverRemoteSession
import org.dsh.community.android.transport.PairingQrParser
import org.dsh.community.android.transport.PeerRevokedException
import org.dsh.community.android.transport.RemoteConnectionPhase
import org.dsh.community.android.transport.RemoteEndpointProfile
import org.dsh.community.android.transport.TransportKind
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
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
        fun onEventReceived(sessionId: String, event: OfficialSessionEvent)
        fun onStreamReset(sessionId: String, reason: String) {}
        fun onPeerRevoked(hostFingerprint: String, reason: String) {}
        fun onTrustedHostsChanged(hosts: List<TrustedHostRecord>, activeFingerprint: String?) {}
        fun onPendingApproval(callId: String, summary: String)
        fun onPendingQuestion(questionId: String, prompt: String)
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

        const val ACTION_APPROVE_CALL = "org.dsh.community.android.ACTION_APPROVE_CALL"
        const val ACTION_REJECT_CALL = "org.dsh.community.android.ACTION_REJECT_CALL"
        const val ACTION_DISCONNECT = "org.dsh.community.android.ACTION_DISCONNECT"
        const val EXTRA_CALL_ID = "extra_call_id"
        const val EXTRA_IDEMPOTENCY_KEY = "extra_idempotency_key"
    }

    private val binder = LocalBinder()
    private val ioExecutor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "dsh-remote-io").apply { isDaemon = true }
    }
    private val uiObservers = CopyOnWriteArrayList<UiObserver>()
    private val networkAvailable = AtomicBoolean(true)

    private val startCount = AtomicInteger(0)
    private val reconnectAttempts = AtomicInteger(0)
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
    private var reconnectFuture: ScheduledFuture<*>? = null

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
        ensureForeground("Idle ($count starts)")

        when (intent?.action) {
            ACTION_DISCONNECT -> {
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
        unregisterNetworkObserver()
        reconnectFuture?.cancel(false)
        activeSession?.close("service destroyed")
        ioExecutor.shutdownNow()
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
    }

    fun listTrustedHosts(): List<TrustedHostRecord> = trustedHostStore.list()

    fun currentHostFingerprint(): String? = activeHostFingerprint

    fun currentIdentity(): DeviceIdentity = ensureDeviceIdentity()

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
        ioExecutor.execute {
            try {
                val descriptor = PairingQrParser.parse(rawDescriptorJson)
                val profile = RemoteEndpointProfile.fromDescriptor(descriptor)
                connectProfileInternal(profile, displayName)
            } catch (t: Throwable) {
                updateStatus(RemoteConnectionPhase.FAILED, null, 0, "Pairing parse/connect failed: ${t.message}")
            }
        }
    }

    fun connectProfile(profile: RemoteEndpointProfile, displayName: String = Build.MODEL ?: "Android") {
        ioExecutor.execute {
            connectProfileInternal(profile, displayName)
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
    ) {
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
            notifyTrustedHosts()

            if (target.isRevoked) {
                val reason = target.revokedReason ?: "device revoked by host"
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
            connectProfileInternal(tokenlessProfile, displayName)
        }
    }

    /**
     * Removes a saved Host profile (and tears down the live connection if active).
     */
    fun forgetHost(hostFingerprint: String? = null) {
        ioExecutor.execute {
            val targetFp = hostFingerprint?.takeIf { it.isNotBlank() }
                ?: activeHostFingerprint
                ?: trustedHostStore.list().firstOrNull()?.hostFingerprint
                ?: return@execute
            if (activeHostFingerprint.equals(targetFp, ignoreCase = true)) {
                reconnectFuture?.cancel(false)
                activeSession?.close("host forgotten")
                activeSession = null
                activeHostFingerprint = null
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
            val reason = existing.revokedReason ?: "device revoked by host"
            uiObservers.forEach { it.onPeerRevoked(fp, reason) }
            ioExecutor.execute {
                updateStatus(RemoteConnectionPhase.REVOKED, null, 0, "REVOKED: $reason")
            }
            return DiscoverySelectOutcome.REVOKED_HOST
        }
        val updated = trustedHostStore.updateLanFromDiscovery(
            hostFingerprint = fp,
            lanUrl = discovered.endpointUrl,
            displayLabel = discovered.hostDisplayLabel,
        ) ?: return DiscoverySelectOutcome.UNKNOWN_UNPAIRED_HOST
        notifyTrustedHosts()
        reconnectSavedHost(updated.hostFingerprint)
        return DiscoverySelectOutcome.UPDATED_AND_RECONNECTING
    }

    fun refreshSessionsAsync() {
        ioExecutor.execute {
            val session = activeSession ?: return@execute
            try {
                val list = session.listSessions()
                uiObservers.forEach { it.onSessionsUpdated(list) }
            } catch (t: Throwable) {
                updateStatus(session.phase, session.activeCarrier, session.currentEpoch, "session.list error: ${t.message}")
            }
        }
    }

    fun attachSessionAsync(sessionId: String) {
        ioExecutor.execute {
            val session = activeSession ?: return@execute
            try {
                when (val result = session.attachSession(sessionId)) {
                    is AttachResumeResult.Events -> {
                        for (evt in result.events) {
                            dispatchEventToObservers(sessionId, evt)
                        }
                    }
                    is AttachResumeResult.ResetRequired -> {
                        updateStatus(
                            session.phase,
                            session.activeCarrier,
                            session.currentEpoch,
                            "Replay window unavailable (${result.reason}); re-sync from official session",
                        )
                    }
                }
            } catch (t: Throwable) {
                updateStatus(session.phase, session.activeCarrier, session.currentEpoch, "attach failed: ${t.message}")
            }
        }
    }

    fun submitPromptAsync(sessionId: String, prompt: String) {
        ioExecutor.execute {
            val session = activeSession ?: return@execute
            val opKey = session.newOperationKey("prompt")
            try {
                session.submitPrompt(sessionId, prompt, opKey)
            } catch (t: Throwable) {
                updateStatus(session.phase, session.activeCarrier, session.currentEpoch, "prompt.submit failed: ${t.message}")
            }
        }
    }

    fun respondApprovalAsync(callId: String, approved: Boolean, explicitKey: String? = null) {
        ioExecutor.execute {
            val session = activeSession ?: return@execute
            val opKey = explicitKey ?: session.newOperationKey("approval-$callId")
            try {
                session.respondApproval(callId, approved, opKey)
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.cancel(APPROVAL_NOTIFICATION_ID)
            } catch (t: Throwable) {
                updateStatus(session.phase, session.activeCarrier, session.currentEpoch, "approval.respond failed: ${t.message}")
            }
        }
    }

    fun respondQuestionAsync(questionId: String, answer: String) {
        ioExecutor.execute {
            val session = activeSession ?: return@execute
            val opKey = session.newOperationKey("question-$questionId")
            try {
                session.respondQuestion(questionId, answer, opKey)
            } catch (t: Throwable) {
                updateStatus(session.phase, session.activeCarrier, session.currentEpoch, "question.respond failed: ${t.message}")
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
                updateStatus(
                    session.phase,
                    session.activeCarrier,
                    session.currentEpoch,
                    "Connected via ${session.activeCarrier?.wireName} (epoch ${session.currentEpoch})",
                )
            } catch (t: Throwable) {
                if (t is PeerRevokedException || session.revokedByHost) {
                    handlePeerRevocation(
                        activeHostFingerprint ?: "",
                        session,
                        (t as? PeerRevokedException)?.reason ?: t.message ?: "device revoked",
                    )
                } else {
                    updateStatus(RemoteConnectionPhase.FAILED, null, session.currentEpoch, "Failover failed: ${t.message}")
                }
            } finally {
                persistStats()
            }
        }
    }

    fun disconnect() {
        reconnectFuture?.cancel(false)
        activeSession?.close("user disconnect")
        activeSession = null
        updateStatus(RemoteConnectionPhase.DISCONNECTED, null, 0, "Disconnected")
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun connectProfileInternal(profile: RemoteEndpointProfile, displayName: String) {
        reconnectFuture?.cancel(false)
        activeSession?.close("reconnecting")
        activeHostFingerprint = profile.hostFingerprint
        notifyTrustedHosts()

        val identity = ensureDeviceIdentity()
        val session = FailoverRemoteSession(identity, profile)
        session.addListener(
            object : FailoverRemoteSession.Listener {
                override fun onPhaseChanged(phase: RemoteConnectionPhase, carrier: TransportKind?, epoch: Int) {
                    val label = "${phase.name} via ${carrier?.wireName ?: "-"} (epoch=$epoch)"
                    updateStatus(phase, carrier, epoch, label)
                }

                override fun onStreamEvent(sessionId: String, event: OfficialSessionEvent) {
                    dispatchEventToObservers(sessionId, event)
                    session.ackStream(sessionId, event.seq)
                }

                override fun onStreamReset(sessionId: String, reason: String) {
                    uiObservers.forEach { it.onStreamReset(sessionId, reason) }
                }

                override fun onPeerRevoked(reason: String) {
                    handlePeerRevocation(profile.hostFingerprint, session, reason)
                }

                override fun onTransportClosed(carrier: TransportKind, reason: String) {
                    scheduleBatterySafeReconnect(session, carrier, reason)
                }
            },
        )
        activeSession = session
        try {
            val phase = session.connect()
            if (phase == RemoteConnectionPhase.PAIRING_PENDING && !profile.bootstrapToken.isNullOrBlank()) {
                val res = session.requestPairing(displayName, profile.bootstrapToken)
                val cid = res.str("candidateId") ?: "pending"
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
                notifyTrustedHosts()
                val sessions = session.listSessions()
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
                handlePeerRevocation(
                    profile.hostFingerprint,
                    session,
                    (t as? PeerRevokedException)?.reason ?: t.message ?: "device revoked",
                )
            } else {
                updateStatus(RemoteConnectionPhase.FAILED, null, session.currentEpoch, "Connect failed: ${t.message}")
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
        reconnectFuture?.cancel(false)
        if (hostFingerprint.isNotBlank()) {
            trustedHostStore.markRevoked(hostFingerprint, reason)
            notifyTrustedHosts()
            uiObservers.forEach { it.onPeerRevoked(hostFingerprint, reason) }
        }
        updateStatus(RemoteConnectionPhase.REVOKED, null, session.currentEpoch, "REVOKED: $reason")
    }

    private fun notifyTrustedHosts() {
        val snapshot = trustedHostStore.list()
        val fp = activeHostFingerprint
        uiObservers.forEach { it.onTrustedHostsChanged(snapshot, fp) }
    }

    private fun scheduleBatterySafeReconnect(session: FailoverRemoteSession, droppedCarrier: TransportKind, reason: String) {
        if (session.revokedByHost || session.phase == RemoteConnectionPhase.REVOKED) return
        if (activeSession !== session || !networkAvailable.get()) return
        val attempt = reconnectAttempts.incrementAndGet()
        if (attempt > 5) {
            updateStatus(
                RemoteConnectionPhase.FAILED,
                null,
                session.currentEpoch,
                "Stopped reconnect after 5 attempts (battery guard)",
            )
            return
        }
        val delayMs = BackoffPolicy.nextDelayMs(attempt - 1)
        updateStatus(
            RemoteConnectionPhase.CONNECTING,
            null,
            session.currentEpoch,
            "$droppedCarrier closed ($reason); failover in ${delayMs}ms",
        )
        reconnectFuture?.cancel(false)
        reconnectFuture = ioExecutor.schedule(
            {
                if (activeSession === session && networkAvailable.get()) {
                    failoverAsync()
                }
            },
            delayMs,
            TimeUnit.MILLISECONDS,
        )
    }

    private fun dispatchEventToObservers(sessionId: String, event: OfficialSessionEvent) {
        uiObservers.forEach { it.onEventReceived(sessionId, event) }
        val dataObj = event.data as? JsonObject ?: return
        if (event.type == "approval.resolved" || event.type == "question.resolved") {
            return
        }
        if (event.type.contains("approval", ignoreCase = true) || event.type.contains("permission", ignoreCase = true)) {
            val callId = dataObj.str("callId") ?: return
            val toolLabel = dataObj.str("toolName") ?: dataObj.str("tool") ?: dataObj.str("summary") ?: event.type
            val reason = dataObj.str("reason")
            val summary = if (!reason.isNullOrBlank()) "$toolLabel — $reason" else toolLabel
            uiObservers.forEach { it.onPendingApproval(callId, summary) }
            postApprovalNotification(callId, summary)
        } else if (event.type.contains("question", ignoreCase = true)) {
            val questionId = dataObj.str("questionId") ?: return
            val firstQuestion = dataObj.arr("questions")?.items?.firstOrNull() as? JsonObject
            val prompt = dataObj.str("prompt")
                ?: dataObj.str("question")
                ?: firstQuestion?.str("question")
                ?: firstQuestion?.str("prompt")
                ?: firstQuestion?.str("header")
                ?: event.type
            uiObservers.forEach { it.onPendingQuestion(questionId, prompt) }
        }
    }

    private fun updateStatus(phase: RemoteConnectionPhase, carrier: TransportKind?, epoch: Int, message: String) {
        statusText = message
        lastStatusMessage.set(System.currentTimeMillis())
        val id = ensureDeviceIdentity()
        ensureForeground(message)
        val stats = currentStats()
        uiObservers.forEach {
            it.onStatusChanged(phase, carrier, epoch, id.deviceId, message)
            it.onMetricsUpdated(id, stats)
        }
    }

    private fun ensureDeviceIdentity(): DeviceIdentity {
        deviceIdentity?.let { return it }
        val created = EncryptedDeviceIdentityStore.createForAndroid(this).loadOrCreate()
        deviceIdentity = created
        return created
    }

    private fun registerNetworkObserver() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        connectivityManager = cm
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                networkAvailable.set(true)
            }

            override fun onLost(network: Network) {
                networkAvailable.set(false)
                networkLosses.incrementAndGet()
                persistStats()
            }
        }
        networkCallback = cb
        try {
            cm.registerDefaultNetworkCallback(cb)
        } catch (_: SecurityException) {
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

    private fun ensureForeground(contentText: String) {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val disconnectIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, RemoteSessionService::class.java).setAction(ACTION_DISCONNECT),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
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

    private fun postApprovalNotification(callId: String, summary: String) {
        approvalNotifications.incrementAndGet()
        val idempotencyKey = activeSession?.newOperationKey("notif-$callId") ?: "notif-$callId"

        val approveIntent = PendingIntent.getService(
            this,
            10,
            Intent(this, RemoteSessionService::class.java)
                .setAction(ACTION_APPROVE_CALL)
                .putExtra(EXTRA_CALL_ID, callId)
                .putExtra(EXTRA_IDEMPOTENCY_KEY, idempotencyKey),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val rejectIntent = PendingIntent.getService(
            this,
            11,
            Intent(this, RemoteSessionService::class.java)
                .setAction(ACTION_REJECT_CALL)
                .putExtra(EXTRA_CALL_ID, callId)
                .putExtra(EXTRA_IDEMPOTENCY_KEY, idempotencyKey),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(this, APPROVAL_CHANNEL_ID)
            .setContentTitle("Tool Approval Required ($callId)")
            .setContentText(summary)
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
