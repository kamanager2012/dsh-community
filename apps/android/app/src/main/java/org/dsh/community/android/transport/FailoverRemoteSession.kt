package org.dsh.community.android.transport

import org.dsh.community.android.crypto.DeviceIdentity
import org.dsh.community.android.crypto.NoiseIkClient
import org.dsh.community.android.crypto.TrustedHostRecord
import org.dsh.community.android.protocol.AttachResumeResult
import org.dsh.community.android.protocol.ClientOperationFactory
import org.dsh.community.android.protocol.InboundHostFrame
import org.dsh.community.android.protocol.JsonBool
import org.dsh.community.android.protocol.JsonCodec
import org.dsh.community.android.protocol.JsonNumber
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.JsonString
import org.dsh.community.android.protocol.JsonValue
import org.dsh.community.android.protocol.OfficialSessionEvent
import org.dsh.community.android.protocol.RemoteFrameCodec
import org.dsh.community.android.protocol.RemoteProtocol
import org.dsh.community.android.protocol.RpcErrorPayload
import org.dsh.community.android.protocol.SessionRef
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

data class RemoteEndpointProfile(
    val hostPublicKey: ByteArray,
    val hostFingerprint: String,
    val lanUrl: String? = null,
    val signalingUrl: String? = null,
    val signalingRoomId: String? = null,
    val stunUrls: List<String> = emptyList(),
    val relayUrl: String? = null,
    val relayRoomId: String? = null,
    val relayClientToken: String? = null,
    val bootstrapToken: String? = null,
) {
    companion object {
        fun fromDescriptor(descriptor: PairingBootstrapDescriptor): RemoteEndpointProfile =
            RemoteEndpointProfile(
                hostPublicKey = descriptor.hostPublicKeyBytes,
                hostFingerprint = descriptor.hostFingerprint,
                lanUrl = descriptor.endpointUrl,
                signalingUrl = descriptor.signalingUrl,
                signalingRoomId = descriptor.signalingRoomId ?: descriptor.hostFingerprint,
                stunUrls = descriptor.stunUrls ?: emptyList(),
                relayUrl = descriptor.relayUrl,
                relayRoomId = descriptor.relayRoomId ?: descriptor.hostFingerprint,
                bootstrapToken = descriptor.bootstrapToken,
            )

        /**
         * Constructs a tokenless reconnect profile from a verified persisted [TrustedHostRecord].
         */
        fun fromTrustedRecord(
            record: TrustedHostRecord,
            lanUrlOverride: String? = null,
        ): RemoteEndpointProfile =
            RemoteEndpointProfile(
                hostPublicKey = record.hostPublicKeyBytes,
                hostFingerprint = record.hostFingerprint,
                lanUrl = lanUrlOverride?.takeIf { it.isNotBlank() } ?: record.lanUrl,
                signalingUrl = record.signalingUrl,
                signalingRoomId = record.signalingRoomId ?: record.hostFingerprint,
                stunUrls = record.stunUrls,
                relayUrl = record.relayUrl,
                relayRoomId = record.relayRoomId ?: record.hostFingerprint,
                bootstrapToken = null,
            )
    }
}

enum class RemoteConnectionPhase {
    DISCONNECTED,
    CONNECTING,
    PAIRING_PENDING,
    ACTIVE,
    FAILED,
    REVOKED,
}

class PeerRevokedException(val reason: String) :
    IOException("device revoked by host: $reason")

data class TransportFailureRecord(
    val kind: TransportKind,
    val message: String,
)

/**
 * Android Remote Client session coordinator managing Noise IK E2EE, ordered carrier failover
 * (`LAN -> WebRTC -> Relay`), monotonic `connectionEpoch` verification, confirmed replay cursor
 * tracking (`session.attach(afterSeq)`), and stable `idempotencyKey` preservation across retries.
 */
class FailoverRemoteSession(
    private val identity: DeviceIdentity,
    private val profile: RemoteEndpointProfile,
    private val webRtcPeerEngine: WebRtcPeerEngine = UnattachedWebRtcPeerEngine,
    private val lanFactory: ((String) -> RemoteClientTransport)? = null,
    private val relayFactory: ((String, String, String?) -> RemoteClientTransport)? = null,
    private val requestTimeoutMs: Long = 10_000L,
    private val handshakeTimeoutMs: Long = 10_000L,
    initialHighestEpoch: Int = 0,
) {
    interface Listener {
        fun onPhaseChanged(phase: RemoteConnectionPhase, carrier: TransportKind?, epoch: Int) {}
        fun onStreamEvent(sessionId: String, event: OfficialSessionEvent) {}
        fun onStreamReset(sessionId: String, reason: String) {}
        fun onPeerRevoked(reason: String) {}
        fun onTransportClosed(carrier: TransportKind, reason: String) {}
    }

    private val listeners = CopyOnWriteArrayList<Listener>()
    private val opFactory = ClientOperationFactory()
    private val requestIdCounter = AtomicInteger(0)
    private val requestSeq = AtomicLong(0)
    private val pendingRpc = ConcurrentHashMap<String, CompletableFuture<JsonValue>>()
    private val lastConfirmedSeqBySession = ConcurrentHashMap<String, Long>()
    private val attachedSessionIds = ConcurrentHashMap.newKeySet<String>()
    private val highestEpoch = AtomicInteger(initialHighestEpoch.coerceAtLeast(0))
    private val sessionLock = Any()
    private val sendLock = Any()

    @Volatile
    private var activeTransport: RemoteClientTransport? = null

    @Volatile
    private var noiseSession: NoiseIkClient? = null

    @Volatile
    var phase: RemoteConnectionPhase = RemoteConnectionPhase.DISCONNECTED
        private set

    @Volatile
    var activeCarrier: TransportKind? = null
        private set

    @Volatile
    var currentEpoch: Int = 0
        private set

    @Volatile
    var revokedByHost: Boolean = false
        private set

    @Volatile
    var revokedReason: String? = null
        private set

    val attemptErrors: MutableList<TransportFailureRecord> = CopyOnWriteArrayList()

    fun addListener(listener: Listener) {
        listeners.add(listener)
    }

    fun removeListener(listener: Listener) {
        listeners.remove(listener)
    }

    fun getLastConfirmedSeq(sessionId: String): Long? = lastConfirmedSeqBySession[sessionId]

    fun isTransportOpen(): Boolean = activeTransport?.isOpen() == true

    /**
     * Connects using ordered fallback (`LAN -> WebRTC -> Relay`), or starting from the requested
     * subset of carriers (e.g., when reconnecting after LAN failure).
     */
    fun connect(allowedKinds: List<TransportKind> = listOf(TransportKind.LAN, TransportKind.WEBRTC, TransportKind.RELAY)): RemoteConnectionPhase {
        attemptErrors.clear()
        revokedByHost = false
        revokedReason = null
        val candidates = buildCandidateTransports(allowedKinds)
        if (candidates.isEmpty()) {
            phase = RemoteConnectionPhase.FAILED
            notifyPhase()
            throw IOException("no configured transport candidates for $allowedKinds")
        }

        for (transport in candidates) {
            try {
                connectSingleTransport(transport)
                return phase
            } catch (t: Throwable) {
                attemptErrors.add(
                    TransportFailureRecord(
                        transport.kind,
                        t.message ?: t.javaClass.simpleName,
                    ),
                )
                if (t is PeerRevokedException || revokedByHost) {
                    phase = RemoteConnectionPhase.REVOKED
                    notifyPhase()
                    throw t
                }
            }
        }

        phase = RemoteConnectionPhase.FAILED
        notifyPhase()
        val detail = attemptErrors.joinToString("; ") { "${it.kind.wireName}: ${it.message}" }
        throw IOException("all remote transports failed [$detail]")
    }

    /**
     * Initiates device pairing when connected channel is in `PAIRING_PENDING` state.
     */
    fun requestPairing(displayName: String, bootstrapToken: String? = profile.bootstrapToken): JsonObject {
        val token = bootstrapToken?.takeIf { it.isNotBlank() }
            ?: throw IllegalStateException("bootstrapToken is required for pairing.request")
        val id = "pair-${requestIdCounter.incrementAndGet()}"
        val frameJson = RemoteFrameCodec.encodePairingRequest(
            id = id,
            bootstrapToken = token,
            displayName = displayName,
        )
        val result = sendEncryptedAwaitResult(id, frameJson)
        return result as? JsonObject
            ?: throw IOException("unexpected pairing.request response: $result")
    }

    fun ping(): Boolean {
        val res = dispatchRpc(RemoteProtocol.METHOD_PING, JsonObject.of())
        return (res as? JsonObject)?.bool("ok") == true
    }

    fun listSessions(): List<SessionRef> {
        val res = dispatchRpc(RemoteProtocol.METHOD_SESSION_LIST, JsonObject.of())
        return RemoteFrameCodec.parseSessionList(res)
    }

    fun attachSession(sessionId: String, explicitAfterSeq: Long? = null): AttachResumeResult {
        attachedSessionIds.add(sessionId)
        val resumeAfter = explicitAfterSeq ?: lastConfirmedSeqBySession[sessionId]
        val params = JsonObject.of(
            "sessionId" to JsonString(sessionId),
            "afterSeq" to resumeAfter?.let { JsonNumber(it) },
        )
        val res = dispatchRpc(RemoteProtocol.METHOD_SESSION_ATTACH, params)
        val parsed = RemoteFrameCodec.parseAttachResult(res)
        if (parsed is AttachResumeResult.Events) {
            for (evt in parsed.events) {
                advanceConfirmedSeq(sessionId, evt.seq)
            }
        }
        return parsed
    }

    fun ackStream(sessionId: String, seq: Long) {
        val params = JsonObject.of(
            "sessionId" to JsonString(sessionId),
            "seq" to JsonNumber(seq),
        )
        dispatchRpc(RemoteProtocol.METHOD_STREAM_ACK, params)
        advanceConfirmedSeq(sessionId, seq)
    }

    fun newOperationKey(prefix: String = "android"): String = opFactory.nextIdempotencyKey(prefix)

    fun submitPrompt(
        sessionId: String,
        prompt: String,
        idempotencyKey: String = newOperationKey("prompt"),
    ): JsonValue {
        val params = JsonObject.of(
            "sessionId" to JsonString(sessionId),
            "prompt" to JsonString(prompt),
        )
        return dispatchRpc(RemoteProtocol.METHOD_PROMPT_SUBMIT, params, idempotencyKey = idempotencyKey)
    }

    fun respondApproval(
        callId: String,
        approved: Boolean,
        idempotencyKey: String = newOperationKey("approval"),
    ): JsonValue {
        val decision = if (approved) "approved" else "rejected"
        val params = JsonObject.of(
            "callId" to JsonString(callId),
            "decision" to JsonString(decision),
        )
        return dispatchRpc(RemoteProtocol.METHOD_APPROVAL_RESPOND, params, idempotencyKey = idempotencyKey)
    }

    fun respondQuestion(
        questionId: String,
        answer: String,
        idempotencyKey: String = newOperationKey("question"),
    ): JsonValue {
        val params = JsonObject.of(
            "questionId" to JsonString(questionId),
            "answer" to JsonString(answer),
        )
        return dispatchRpc(RemoteProtocol.METHOD_QUESTION_RESPOND, params, idempotencyKey = idempotencyKey)
    }

    /**
     * Switches carriers (e.g. drops LAN and connects via WebRTC -> Relay) on a fresh Noise
     * session while enforcing monotonic `connectionEpoch` and re-attaching all tracked sessions.
     */
    fun failoverAndResume(
        preferredKinds: List<TransportKind> = listOf(TransportKind.LAN, TransportKind.WEBRTC, TransportKind.RELAY),
    ): Map<String, AttachResumeResult> {
        closeCurrentTransportOnly("failover requested")
        val nextPhase = connect(preferredKinds)
        if (nextPhase != RemoteConnectionPhase.ACTIVE) {
            throw IOException("cannot resume sessions in phase $nextPhase")
        }
        val resumed = LinkedHashMap<String, AttachResumeResult>()
        for (sessionId in attachedSessionIds) {
            resumed[sessionId] = attachSession(sessionId, explicitAfterSeq = lastConfirmedSeqBySession[sessionId])
        }
        return resumed
    }

    fun close(reason: String = "session closed") {
        closeCurrentTransportOnly(reason)
        phase = RemoteConnectionPhase.DISCONNECTED
        notifyPhase()
    }

    private fun closeCurrentTransportOnly(reason: String) {
        closeMatchingTransport(expectedTransport = null, expectedNoise = null, reason = reason)
    }

    private fun closeMatchingTransport(
        expectedTransport: RemoteClientTransport?,
        expectedNoise: NoiseIkClient?,
        reason: String,
        failureError: Throwable? = null,
    ) {
        val transportToClose: RemoteClientTransport?
        val noiseToClose: NoiseIkClient?
        val failPending: Boolean
        synchronized(sessionLock) {
            val matchesTransport = expectedTransport == null || activeTransport === expectedTransport
            val matchesNoise = expectedNoise == null || noiseSession === expectedNoise
            transportToClose = expectedTransport ?: activeTransport
            noiseToClose = expectedNoise ?: noiseSession
            if (matchesTransport) {
                activeTransport = null
                activeCarrier = null
            }
            if (matchesNoise) {
                noiseSession = null
            }
            failPending = matchesTransport
        }
        try {
            transportToClose?.close(reason)
        } finally {
            noiseToClose?.close()
            if (failPending) {
                val err = failureError ?: IOException("transport closed: $reason")
                for ((id, future) in pendingRpc.entries) {
                    if (pendingRpc.remove(id, future)) {
                        future.completeExceptionally(err)
                    }
                }
            }
        }
    }

    private fun buildCandidateTransports(allowedKinds: List<TransportKind>): List<RemoteClientTransport> {
        val list = ArrayList<RemoteClientTransport>()
        for (kind in allowedKinds) {
            when (kind) {
                TransportKind.LAN -> {
                    val lan = profile.lanUrl
                    if (!lan.isNullOrBlank()) {
                        list.add(lanFactory?.invoke(lan) ?: LanWebSocketTransport(lan))
                    }
                }
                TransportKind.WEBRTC -> {
                    val sig = profile.signalingUrl
                    if (!sig.isNullOrBlank()) {
                        list.add(
                            WebRtcDataChannelTransport(
                                signalingUrl = sig,
                                roomId = profile.signalingRoomId ?: profile.hostFingerprint,
                                stunUrls = profile.stunUrls,
                                peerEngine = webRtcPeerEngine,
                            ),
                        )
                    }
                }
                TransportKind.RELAY -> {
                    val relay = profile.relayUrl
                    if (!relay.isNullOrBlank()) {
                        val room = profile.relayRoomId ?: profile.hostFingerprint
                        list.add(
                            relayFactory?.invoke(relay, room, profile.relayClientToken)
                                ?: RelayWebSocketTransport(relay, room, profile.relayClientToken),
                        )
                    }
                }
            }
        }
        return list
    }

    private enum class HandshakeStage {
        WAIT_MSG2,
        WAIT_COMPLETE,
        READY,
    }

    private fun connectSingleTransport(transport: RemoteClientTransport) {
        closeCurrentTransportOnly("switching transport")
        val noise = NoiseIkClient(
            localStaticKeyPair = identity.keyPair,
            remoteHostStaticPublicKey = profile.hostPublicKey,
        )
        synchronized(sessionLock) {
            phase = RemoteConnectionPhase.CONNECTING
            activeCarrier = transport.kind
            noiseSession = noise
            activeTransport = transport
        }
        requestSeq.set(0)
        notifyPhase()

        val stage = AtomicReference(HandshakeStage.WAIT_MSG2)
        val latch = CountDownLatch(1)
        val handshakeError = AtomicReference<Throwable?>(null)
        val initialPhase = AtomicReference(RemoteConnectionPhase.CONNECTING)
        val revokedThisAttempt = AtomicBoolean(false)
        val closedNotified = AtomicBoolean(false)

        val callbacks = object : RemoteTransportCallbacks {
            override fun onBinaryFrame(frame: ByteArray) {
                when (stage.get()) {
                    HandshakeStage.WAIT_MSG2 -> {
                        try {
                            noise.readMessage2(frame)
                            stage.set(HandshakeStage.WAIT_COMPLETE)
                        } catch (t: Throwable) {
                            handshakeError.compareAndSet(null, t)
                            latch.countDown()
                        }
                    }
                    HandshakeStage.WAIT_COMPLETE -> {
                        try {
                            val pt = noise.decrypt(frame)
                            val parsed = RemoteFrameCodec.decodeHostFrame(String(pt, StandardCharsets.UTF_8))
                            if (parsed is InboundHostFrame.PeerRevoked) {
                                revokedThisAttempt.set(true)
                                val err = PeerRevokedException(parsed.reason)
                                handshakeError.compareAndSet(null, err)
                                closeMatchingTransport(
                                    expectedTransport = transport,
                                    expectedNoise = noise,
                                    reason = "peer revoked",
                                    failureError = err,
                                )
                                applyPeerRevoked(parsed.reason)
                                latch.countDown()
                                return
                            }
                            if (parsed !is InboundHostFrame.HandshakeComplete) {
                                throw SecurityException("expected handshake.complete after Noise Msg2")
                            }
                            val newEpoch = parsed.notice.connectionEpoch
                            val prev = highestEpoch.get()
                            if (newEpoch < 1 || newEpoch <= prev) {
                                throw SecurityException(
                                    "host connectionEpoch regression/replay detected: new=$newEpoch prev=$prev",
                                )
                            }
                            highestEpoch.set(newEpoch)
                            currentEpoch = newEpoch

                            val nextPhase = when (parsed.notice.channelState) {
                                "PAIRING_PENDING" -> RemoteConnectionPhase.PAIRING_PENDING
                                "ACTIVE" -> RemoteConnectionPhase.ACTIVE
                                else -> throw SecurityException("unexpected channel state: ${parsed.notice.channelState}")
                            }
                            phase = nextPhase
                            initialPhase.set(nextPhase)
                            stage.set(HandshakeStage.READY)
                            latch.countDown()
                        } catch (t: Throwable) {
                            handshakeError.compareAndSet(null, t)
                            latch.countDown()
                        }
                    }
                    HandshakeStage.READY -> {
                        handleActiveBinaryFrame(transport, noise, frame, revokedThisAttempt)
                    }
                }
            }

            override fun onClosed(reason: String) {
                if (stage.get() != HandshakeStage.READY) {
                    val err = if (revokedThisAttempt.get() || reason.contains("revoked", ignoreCase = true)) {
                        revokedThisAttempt.set(true)
                        if (!revokedByHost) {
                            applyPeerRevoked(reason)
                        }
                        PeerRevokedException(reason)
                    } else {
                        IOException("closed during handshake: $reason")
                    }
                    handshakeError.compareAndSet(null, err)
                    latch.countDown()
                } else if (
                    !revokedThisAttempt.get() &&
                    !revokedByHost &&
                    activeTransport === transport &&
                    closedNotified.compareAndSet(false, true)
                ) {
                    val err = IOException("remote channel closed: $reason")
                    closeMatchingTransport(
                        expectedTransport = transport,
                        expectedNoise = noise,
                        reason = reason,
                        failureError = err,
                    )
                    listeners.forEach { it.onTransportClosed(transport.kind, reason) }
                }
            }

            override fun onError(error: Throwable) {
                if (stage.get() != HandshakeStage.READY) {
                    handshakeError.compareAndSet(null, error)
                    latch.countDown()
                } else if (
                    !revokedThisAttempt.get() &&
                    !revokedByHost &&
                    activeTransport === transport &&
                    closedNotified.compareAndSet(false, true)
                ) {
                    val reason = error.message?.takeIf { it.isNotBlank() } ?: error::class.java.simpleName
                    closeMatchingTransport(
                        expectedTransport = transport,
                        expectedNoise = noise,
                        reason = reason,
                        failureError = error,
                    )
                    listeners.forEach { it.onTransportClosed(transport.kind, reason) }
                }
            }
        }

        try {
            transport.connect(callbacks)
            val msg1 = noise.writeMessage1()
            transport.sendBinary(msg1)

            if (!latch.await(handshakeTimeoutMs, TimeUnit.MILLISECONDS)) {
                throw IOException("Noise IK handshake timed out on ${transport.kind.wireName}")
            }
            handshakeError.get()?.let { throw it }
            notifyPhase()
        } catch (t: Throwable) {
            closeMatchingTransport(
                expectedTransport = transport,
                expectedNoise = noise,
                reason = "handshake failure",
                failureError = t,
            )
            throw t
        }
    }

    private fun handleActiveBinaryFrame(
        transport: RemoteClientTransport,
        noise: NoiseIkClient,
        frame: ByteArray,
        revokedThisAttempt: AtomicBoolean,
    ) {
        val pt = try {
            noise.decrypt(frame)
        } catch (t: Throwable) {
            if (!revokedThisAttempt.get() && activeTransport === transport) {
                close("ciphertext verification failed: ${t.message}")
            }
            return
        }
        val decoded = try {
            RemoteFrameCodec.decodeHostFrame(String(pt, StandardCharsets.UTF_8))
        } catch (t: Throwable) {
            return
        }

        when (decoded) {
            is InboundHostFrame.RpcSuccess -> {
                pendingRpc.remove(decoded.id)?.complete(decoded.result)
            }
            is InboundHostFrame.RpcFailure -> {
                val id = decoded.id
                if (decoded.error.name == "DEVICE_REVOKED") {
                    val err = PeerRevokedException(decoded.error.message)
                    if (id != null) {
                        pendingRpc.remove(id)?.completeExceptionally(err)
                    }
                    handleRevokedInActiveFrame(transport, noise, decoded.error.message, revokedThisAttempt)
                } else if (id != null) {
                    pendingRpc.remove(id)?.completeExceptionally(decoded.error)
                }
            }
            is InboundHostFrame.StreamEvent -> {
                advanceConfirmedSeq(decoded.sessionId, decoded.event.seq)
                listeners.forEach { it.onStreamEvent(decoded.sessionId, decoded.event) }
            }
            is InboundHostFrame.StreamReset -> {
                lastConfirmedSeqBySession.remove(decoded.sessionId)
                listeners.forEach { it.onStreamReset(decoded.sessionId, decoded.reason) }
            }
            is InboundHostFrame.PeerRevoked -> {
                handleRevokedInActiveFrame(transport, noise, decoded.reason, revokedThisAttempt)
            }
            is InboundHostFrame.HandshakeComplete -> Unit
        }
    }

    private fun handleRevokedInActiveFrame(
        transport: RemoteClientTransport,
        noise: NoiseIkClient,
        reason: String,
        revokedThisAttempt: AtomicBoolean,
    ) {
        val resolved = reason.ifBlank { "device revoked by host" }
        val err = PeerRevokedException(resolved)
        revokedThisAttempt.set(true)
        synchronized(sessionLock) {
            revokedByHost = true
            revokedReason = resolved
            phase = RemoteConnectionPhase.REVOKED
        }
        // Tear down this transport and Noise session BEFORE notifying listeners so an immediate
        // reconnect triggered by onPeerRevoked cannot have its fresh session closed by cleanup.
        closeMatchingTransport(
            expectedTransport = transport,
            expectedNoise = noise,
            reason = "peer revoked",
            failureError = err,
        )
        notifyPhase()
        listeners.forEach { it.onPeerRevoked(resolved) }
    }

    private fun applyPeerRevoked(reason: String) {
        val resolved = reason.ifBlank { "device revoked by host" }
        revokedByHost = true
        revokedReason = resolved
        phase = RemoteConnectionPhase.REVOKED
        notifyPhase()
        listeners.forEach { it.onPeerRevoked(resolved) }
    }

    private fun dispatchRpc(
        method: String,
        params: JsonObject,
        idempotencyKey: String? = null,
    ): JsonValue {
        if (phase != RemoteConnectionPhase.ACTIVE) {
            throw RpcErrorPayload(-32001, "UNAUTHORIZED_CHANNEL", "channel state is $phase")
        }
        val id = "rpc-${requestIdCounter.incrementAndGet()}"
        val seq = requestSeq.incrementAndGet()
        val payload = RemoteFrameCodec.encodeRpcRequest(
            id = id,
            method = method,
            connectionEpoch = currentEpoch,
            requestSeq = seq,
            params = params,
            idempotencyKey = idempotencyKey,
        )
        return sendEncryptedAwaitResult(id, payload)
    }

    private fun sendEncryptedAwaitResult(id: String, jsonPayload: String): JsonValue {
        val future = CompletableFuture<JsonValue>()
        pendingRpc[id] = future
        try {
            synchronized(sendLock) {
                val (transport, noise) = synchronized(sessionLock) {
                    val t = activeTransport ?: throw IOException("no active remote transport")
                    val n = noiseSession ?: throw IOException("no active Noise session")
                    t to n
                }
                val ciphertext = noise.encrypt(jsonPayload.toByteArray(StandardCharsets.UTF_8))
                transport.sendBinary(ciphertext)
            }
        } catch (t: Throwable) {
            pendingRpc.remove(id)
            throw t
        }

        return try {
            future.get(requestTimeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: java.util.concurrent.ExecutionException) {
            pendingRpc.remove(id)
            throw (e.cause ?: e)
        } catch (t: Throwable) {
            pendingRpc.remove(id)
            throw t
        }
    }

    private fun advanceConfirmedSeq(sessionId: String, seq: Long) {
        lastConfirmedSeqBySession.merge(sessionId, seq) { oldVal, newVal -> maxOf(oldVal, newVal) }
    }

    private fun notifyPhase() {
        val p = phase
        val c = activeCarrier
        val e = currentEpoch
        listeners.forEach { it.onPhaseChanged(p, c, e) }
    }
}
