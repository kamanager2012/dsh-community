package org.dsh.community.android.transport

import org.dsh.community.android.crypto.DeviceIdentity
import org.dsh.community.android.crypto.NoiseIkClient
import org.dsh.community.android.crypto.TrustedHostRecord
import org.dsh.community.android.protocol.AttachResumeResult
import org.dsh.community.android.protocol.ClientOperationFactory
import org.dsh.community.android.protocol.CommandExecuteResult
import org.dsh.community.android.protocol.DisplayTextSanitizer
import org.dsh.community.android.protocol.EngineDescriptor
import org.dsh.community.android.protocol.InboundHostFrame
import org.dsh.community.android.protocol.JsonArray
import org.dsh.community.android.protocol.JsonBool
import org.dsh.community.android.protocol.JsonCodec
import org.dsh.community.android.protocol.JsonNumber
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.JsonString
import org.dsh.community.android.protocol.JsonValue
import org.dsh.community.android.protocol.ModelCatalogResult
import org.dsh.community.android.protocol.ModelOptionRef
import org.dsh.community.android.protocol.OfficialSessionEvent
import org.dsh.community.android.protocol.PromptImageAttachment
import org.dsh.community.android.protocol.RemoteCommandDescriptor
import org.dsh.community.android.protocol.RemoteFrameCodec
import org.dsh.community.android.protocol.RemoteProtocol
import org.dsh.community.android.protocol.RemoteSkillSummary
import org.dsh.community.android.protocol.RpcErrorPayload
import org.dsh.community.android.protocol.SessionHistoryResult
import org.dsh.community.android.protocol.SessionRef
import org.dsh.community.android.protocol.SessionSearchResult
import org.dsh.community.android.protocol.WorkspaceGitDiffResult
import org.dsh.community.android.protocol.WorkspaceGitStatusResult
import org.dsh.community.android.protocol.WorkspaceUploadAbortResult
import org.dsh.community.android.protocol.WorkspaceUploadCommitResult
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64
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
    val durationMs: Long = 0L,
    val attemptAtMs: Long = 0L,
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
    private val failureCooldownMs: Long = 0L,
    private val iceTransportPolicy: WebRtcIceTransportPolicy = WebRtcIceTransportPolicy.ALL,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    companion object {
        const val MAX_FAILOVER_HISTORY = 64
        const val DEFAULT_UPLOAD_CHUNK_BYTES = 32_768
        private val SECRET_QUERY_RE = Regex("""([?&](?:token|clientToken|bootstrapToken|auth|key)=)[^&\s]+""", RegexOption.IGNORE_CASE)
        private val BEARER_RE = Regex("""(Bearer\s+)[A-Za-z0-9._\-+/=]+""", RegexOption.IGNORE_CASE)

        fun sanitizeDiagnosticMessage(raw: String?): String {
            if (raw.isNullOrBlank()) return "transport error"
            val maskedQuery = SECRET_QUERY_RE.replace(raw, "$1[REDACTED]")
            val maskedBearer = BEARER_RE.replace(maskedQuery, "$1[REDACTED]")
            return DisplayTextSanitizer.truncateByCodePoints(
                DisplayTextSanitizer.sanitizeSingleLine(maskedBearer),
                240,
            ).ifBlank { "transport error" }
        }
    }
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
    val failoverHistory: MutableList<TransportFailureRecord> = CopyOnWriteArrayList()
    private val cooldownUntilByKind = ConcurrentHashMap<TransportKind, Long>()

    fun addListener(listener: Listener) {
        listeners.add(listener)
    }

    fun removeListener(listener: Listener) {
        listeners.remove(listener)
    }

    fun getLastConfirmedSeq(sessionId: String): Long? = lastConfirmedSeqBySession[sessionId]

    fun resetCooldowns() {
        cooldownUntilByKind.clear()
    }

    fun isTransportOpen(): Boolean = activeTransport?.isOpen() == true

    /**
     * Connects using ordered fallback (`LAN -> WebRTC -> Relay`), skipping carriers currently
     * inside `failureCooldownMs` (unless all configured carriers are cooling down, preventing
     * failover deadlock).
     */
    fun connect(allowedKinds: List<TransportKind> = listOf(TransportKind.LAN, TransportKind.WEBRTC, TransportKind.RELAY)): RemoteConnectionPhase {
        attemptErrors.clear()
        revokedByHost = false
        revokedReason = null
        val allCandidates = buildCandidateSpecs(allowedKinds)
        if (allCandidates.isEmpty()) {
            phase = RemoteConnectionPhase.FAILED
            notifyPhase()
            throw IOException("no configured transport candidates for $allowedKinds")
        }

        val now = clock()
        val eligible = if (failureCooldownMs > 0L) {
            allCandidates.filter { (kind, _) ->
                val until = cooldownUntilByKind[kind] ?: 0L
                now >= until
            }
        } else {
            allCandidates
        }
        val candidates = if (eligible.isNotEmpty()) eligible else allCandidates

        for ((kind, factory) in candidates) {
            val startedMs = clock()
            try {
                val transport = factory()
                connectSingleTransport(transport)
                cooldownUntilByKind.remove(kind)
                return phase
            } catch (t: Throwable) {
                val finishedMs = clock()
                val elapsedMs = maxOf(0L, finishedMs - startedMs)
                val record = TransportFailureRecord(
                    kind = kind,
                    message = sanitizeDiagnosticMessage(t.message ?: t.javaClass.simpleName),
                    durationMs = elapsedMs,
                    attemptAtMs = finishedMs,
                )
                attemptErrors.add(record)
                failoverHistory.add(record)
                while (failoverHistory.size > MAX_FAILOVER_HISTORY) {
                    failoverHistory.removeAt(0)
                }
                if (t is PeerRevokedException || revokedByHost) {
                    phase = RemoteConnectionPhase.REVOKED
                    notifyPhase()
                    throw t
                }
                if (failureCooldownMs > 0L) {
                    cooldownUntilByKind[kind] = finishedMs + failureCooldownMs
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

    fun listEngines(): List<EngineDescriptor> {
        val res = dispatchRpc(RemoteProtocol.METHOD_ENGINE_LIST, JsonObject.of())
        return RemoteFrameCodec.parseEngineList(res)
    }

    fun listSessions(): List<SessionRef> {
        val res = dispatchRpc(RemoteProtocol.METHOD_SESSION_LIST, JsonObject.of())
        return RemoteFrameCodec.parseSessionList(res)
    }

    fun createSession(
        title: String? = null,
        sessionId: String? = null,
        idempotencyKey: String = newOperationKey("create"),
        engine: String? = null,
        cwd: String? = null,
    ): SessionRef {
        val params = JsonObject.of(
            "sessionId" to sessionId?.takeIf { it.isNotBlank() }?.let { JsonString(it) },
            "title" to title?.takeIf { it.isNotBlank() }?.let { JsonString(it) },
            "engine" to engine?.takeIf { it.isNotBlank() }?.let { JsonString(it) },
            "cwd" to cwd?.takeIf { it.isNotBlank() }?.let { JsonString(it) },
        )
        val res = dispatchRpc(RemoteProtocol.METHOD_SESSION_CREATE, params, idempotencyKey = idempotencyKey)
        return RemoteFrameCodec.parseSessionRef(res)
    }

    fun getWorkspaceGitStatus(sessionId: String): WorkspaceGitStatusResult {
        val params = JsonObject.of("sessionId" to JsonString(sessionId))
        val res = dispatchRpc(RemoteProtocol.METHOD_WORKSPACE_GIT_STATUS, params)
        return RemoteFrameCodec.parseGitStatusResult(res)
    }

    fun getWorkspaceGitDiff(
        sessionId: String,
        path: String? = null,
        staged: Boolean = false,
        maxBytes: Int? = null,
    ): WorkspaceGitDiffResult {
        val params = JsonObject.of(
            "sessionId" to JsonString(sessionId),
            "path" to path?.takeIf { it.isNotBlank() }?.let { JsonString(it) },
            "staged" to if (staged) JsonBool(true) else null,
            "maxBytes" to maxBytes?.takeIf { it > 0 }?.let { JsonNumber(it) },
        )
        val res = dispatchRpc(RemoteProtocol.METHOD_WORKSPACE_GIT_DIFF, params)
        return RemoteFrameCodec.parseGitDiffResult(res)
    }

    fun renameSession(
        sessionId: String,
        title: String,
        idempotencyKey: String = newOperationKey("rename"),
    ): SessionRef {
        val cleanTitle = title.trim()
        require(cleanTitle.isNotEmpty()) { "title must not be blank" }
        val params = JsonObject.of(
            "sessionId" to JsonString(sessionId),
            "title" to JsonString(cleanTitle),
        )
        val res = dispatchRpc(RemoteProtocol.METHOD_SESSION_RENAME, params, idempotencyKey = idempotencyKey)
        return RemoteFrameCodec.parseSessionRef(res)
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
        mode: String? = null,
        attachments: List<PromptImageAttachment> = emptyList(),
    ): JsonValue {
        require(attachments.size <= 2) { "at most 2 image attachments per prompt" }
        val params = JsonObject.of(
            "sessionId" to JsonString(sessionId),
            "prompt" to JsonString(prompt),
            "mode" to mode?.takeIf { it.isNotBlank() }?.let { JsonString(it) },
            "attachments" to if (attachments.isEmpty()) null else JsonArray(attachments.map { it.toJson() }),
        )
        return dispatchRpc(RemoteProtocol.METHOD_PROMPT_SUBMIT, params, idempotencyKey = idempotencyKey)
    }

    fun abortTurn(
        sessionId: String,
        keepInbox: Boolean = false,
        idempotencyKey: String = newOperationKey("abort"),
    ): Boolean {
        val params = JsonObject.of(
            "sessionId" to JsonString(sessionId),
            "keepInbox" to if (keepInbox) JsonBool(true) else null,
        )
        val res = dispatchRpc(RemoteProtocol.METHOD_TURN_ABORT, params, idempotencyKey = idempotencyKey)
        return (res as? JsonObject)?.bool("aborted") ?: true
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
    ): JsonValue = respondQuestionJson(questionId, JsonString(answer), idempotencyKey)

    fun respondQuestionJson(
        questionId: String,
        answerValue: JsonValue,
        idempotencyKey: String = newOperationKey("question"),
    ): JsonValue {
        val params = JsonObject.of(
            "questionId" to JsonString(questionId),
            "answer" to answerValue,
        )
        return dispatchRpc(RemoteProtocol.METHOD_QUESTION_RESPOND, params, idempotencyKey = idempotencyKey)
    }

    fun listModels(sessionId: String? = null): ModelCatalogResult {
        val params = JsonObject.of(
            "sessionId" to sessionId?.takeIf { it.isNotBlank() }?.let { JsonString(it) },
        )
        val res = dispatchRpc(RemoteProtocol.METHOD_MODEL_LIST, params)
        return RemoteFrameCodec.parseModelCatalog(res)
    }

    fun selectModel(
        sessionId: String,
        provider: String,
        model: String,
        reasoningEffort: String? = null,
        idempotencyKey: String = newOperationKey("model"),
    ): ModelOptionRef {
        val params = JsonObject.of(
            "sessionId" to JsonString(sessionId),
            "provider" to JsonString(provider),
            "model" to JsonString(model),
            "reasoningEffort" to reasoningEffort?.takeIf { it.isNotBlank() }?.let { JsonString(it) },
        )
        dispatchRpc(RemoteProtocol.METHOD_MODEL_SELECT, params, idempotencyKey = idempotencyKey)
        return ModelOptionRef(provider = provider, model = model, name = model)
    }

    fun getSessionHistory(
        sessionId: String,
        beforeSeq: Long? = null,
        limit: Int = 50,
        minTurns: Int? = null,
    ): SessionHistoryResult {
        val params = JsonObject.of(
            "sessionId" to JsonString(sessionId),
            "beforeSeq" to beforeSeq?.let { JsonNumber(it) },
            "limit" to JsonNumber(limit.coerceIn(1, 200)),
            "minTurns" to minTurns?.let { JsonNumber(it) },
        )
        val res = dispatchRpc(RemoteProtocol.METHOD_SESSION_HISTORY, params)
        return RemoteFrameCodec.parseSessionHistoryResult(res)
    }

    fun searchSessions(
        query: String,
        sessionId: String? = null,
        limit: Int = 30,
    ): SessionSearchResult {
        val cleanQuery = query.trim()
        require(cleanQuery.isNotEmpty()) { "search query must not be blank" }
        val params = JsonObject.of(
            "query" to JsonString(cleanQuery),
            "sessionId" to sessionId?.takeIf { it.isNotBlank() }?.let { JsonString(it) },
            "limit" to JsonNumber(limit.coerceIn(1, 100)),
        )
        val res = dispatchRpc(RemoteProtocol.METHOD_SESSION_SEARCH, params)
        return RemoteFrameCodec.parseSessionSearchResult(res)
    }

    fun forkSession(
        sessionId: String,
        atSeq: Long? = null,
        title: String? = null,
        idempotencyKey: String = newOperationKey("fork"),
    ): SessionRef {
        val params = JsonObject.of(
            "sessionId" to JsonString(sessionId),
            "atSeq" to atSeq?.let { JsonNumber(it) },
            "title" to title?.trim()?.takeIf { it.isNotEmpty() }?.let { JsonString(it) },
        )
        val res = dispatchRpc(RemoteProtocol.METHOD_SESSION_FORK, params, idempotencyKey = idempotencyKey)
        return RemoteFrameCodec.parseSessionRef(res)
    }

    fun listCommands(sessionId: String? = null): List<RemoteCommandDescriptor> {
        val params = JsonObject.of(
            "sessionId" to sessionId?.takeIf { it.isNotBlank() }?.let { JsonString(it) },
        )
        val res = dispatchRpc(RemoteProtocol.METHOD_COMMAND_LIST, params)
        return RemoteFrameCodec.parseCommandList(res)
    }

    fun executeCommand(
        sessionId: String,
        command: String,
        idempotencyKey: String = newOperationKey("cmd"),
    ): CommandExecuteResult {
        val cleanCmd = command.trim()
        require(cleanCmd.isNotEmpty()) { "command must not be blank" }
        val params = JsonObject.of(
            "sessionId" to JsonString(sessionId),
            "command" to JsonString(cleanCmd),
        )
        val res = dispatchRpc(RemoteProtocol.METHOD_COMMAND_EXECUTE, params, idempotencyKey = idempotencyKey)
        return RemoteFrameCodec.parseCommandExecuteResult(res)
    }

    fun listSkills(sessionId: String? = null): List<RemoteSkillSummary> {
        val params = JsonObject.of(
            "sessionId" to sessionId?.takeIf { it.isNotBlank() }?.let { JsonString(it) },
        )
        val res = dispatchRpc(RemoteProtocol.METHOD_SKILL_LIST, params)
        return RemoteFrameCodec.parseSkillList(res)
    }

    fun uploadWorkspaceBytes(
        sessionId: String,
        filename: String,
        bytes: ByteArray,
        chunkBytes: Int = DEFAULT_UPLOAD_CHUNK_BYTES,
        conflictPolicy: String = "rename",
        expectedSha256: String? = null,
    ): WorkspaceUploadCommitResult {
        require(bytes.isNotEmpty()) { "upload bytes must not be empty" }
        val digestHex = expectedSha256?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
            ?: MessageDigest.getInstance("SHA-256")
                .digest(bytes)
                .joinToString("") { b -> "%02x".format(b) }
        val boundedChunk = chunkBytes.coerceIn(1, DEFAULT_UPLOAD_CHUNK_BYTES)
        val openRes = RemoteFrameCodec.parseWorkspaceUploadOpenResult(
            dispatchRpc(
                RemoteProtocol.METHOD_WORKSPACE_UPLOAD_OPEN,
                JsonObject.of(
                    "sessionId" to JsonString(sessionId),
                    "filename" to JsonString(filename),
                    "sizeBytes" to JsonNumber(bytes.size),
                    "chunkBytes" to JsonNumber(boundedChunk),
                    "sha256" to JsonString(digestHex),
                    "conflictPolicy" to JsonString(conflictPolicy),
                ),
                idempotencyKey = newOperationKey("upl-open"),
            ),
        )
        val stepBytes = openRes.chunkBytes.coerceIn(1, DEFAULT_UPLOAD_CHUNK_BYTES)
        val encoder = Base64.getEncoder()
        var uploadSucceeded = false
        try {
            var offset = 0
            while (offset < bytes.size) {
                val end = minOf(bytes.size, offset + stepBytes)
                val slice = bytes.copyOfRange(offset, end)
                val b64 = encoder.encodeToString(slice)
                RemoteFrameCodec.parseWorkspaceUploadChunkResult(
                    dispatchRpc(
                        RemoteProtocol.METHOD_WORKSPACE_UPLOAD_CHUNK,
                        JsonObject.of(
                            "uploadId" to JsonString(openRes.uploadId),
                            "offset" to JsonNumber(offset),
                            "dataBase64" to JsonString(b64),
                        ),
                    ),
                )
                offset = end
            }
            val commitRes = RemoteFrameCodec.parseWorkspaceUploadCommitResult(
                dispatchRpc(
                    RemoteProtocol.METHOD_WORKSPACE_UPLOAD_COMMIT,
                    JsonObject.of(
                        "uploadId" to JsonString(openRes.uploadId),
                        "sha256" to JsonString(digestHex),
                    ),
                    idempotencyKey = newOperationKey("upl-commit"),
                ),
            )
            uploadSucceeded = true
            return commitRes
        } finally {
            if (!uploadSucceeded) {
                try {
                    abortWorkspaceUpload(openRes.uploadId)
                } catch (_: Throwable) {
                }
            }
        }
    }

    fun abortWorkspaceUpload(
        uploadId: String,
        idempotencyKey: String = newOperationKey("upl-abort"),
    ): WorkspaceUploadAbortResult {
        val res = dispatchRpc(
            RemoteProtocol.METHOD_WORKSPACE_UPLOAD_ABORT,
            JsonObject.of("uploadId" to JsonString(uploadId)),
            idempotencyKey = idempotencyKey,
        )
        return RemoteFrameCodec.parseWorkspaceUploadAbortResult(res)
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

    private fun buildCandidateSpecs(allowedKinds: List<TransportKind>): List<Pair<TransportKind, () -> RemoteClientTransport>> {
        val list = ArrayList<Pair<TransportKind, () -> RemoteClientTransport>>()
        for (kind in allowedKinds) {
            when (kind) {
                TransportKind.LAN -> {
                    val lan = profile.lanUrl
                    if (!lan.isNullOrBlank()) {
                        list.add(
                            TransportKind.LAN to {
                                lanFactory?.invoke(lan) ?: LanWebSocketTransport(lan)
                            },
                        )
                    }
                }
                TransportKind.WEBRTC -> {
                    val sig = profile.signalingUrl
                    if (!sig.isNullOrBlank()) {
                        list.add(
                            TransportKind.WEBRTC to {
                                WebRtcDataChannelTransport(
                                    signalingUrl = sig,
                                    roomId = profile.signalingRoomId ?: profile.hostFingerprint,
                                    stunUrls = profile.stunUrls,
                                    peerEngine = webRtcPeerEngine,
                                    iceTransportPolicy = iceTransportPolicy,
                                )
                            },
                        )
                    }
                }
                TransportKind.RELAY -> {
                    val relay = profile.relayUrl
                    if (!relay.isNullOrBlank()) {
                        val room = profile.relayRoomId ?: profile.hostFingerprint
                        list.add(
                            TransportKind.RELAY to {
                                relayFactory?.invoke(relay, room, profile.relayClientToken)
                                    ?: RelayWebSocketTransport(relay, room, profile.relayClientToken)
                            },
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
