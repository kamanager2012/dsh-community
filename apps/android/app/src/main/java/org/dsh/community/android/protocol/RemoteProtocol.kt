package org.dsh.community.android.protocol

import java.util.UUID

/**
 * Wire-compatible JSON-RPC 2.0 & streamed event definitions for `@dsh-community/remote-adapter`.
 */
object RemoteProtocol {
    const val PROTOCOL_VERSION = 1

    const val METHOD_PING = "ping"
    const val METHOD_PAIRING_REQUEST = "pairing.request"
    const val METHOD_SESSION_LIST = "session.list"
    const val METHOD_SESSION_ATTACH = "session.attach"
    const val METHOD_SESSION_HISTORY = "session.history"
    const val METHOD_SESSION_SEARCH = "session.search"
    const val METHOD_SESSION_CREATE = "session.create"
    const val METHOD_SESSION_RENAME = "session.rename"
    const val METHOD_SESSION_FORK = "session.fork"
    const val METHOD_STREAM_ACK = "stream.ack"
    const val METHOD_PROMPT_SUBMIT = "prompt.submit"
    const val METHOD_TURN_ABORT = "turn.abort"
    const val METHOD_APPROVAL_RESPOND = "approval.respond"
    const val METHOD_QUESTION_RESPOND = "question.respond"
    const val METHOD_MODEL_LIST = "model.list"
    const val METHOD_MODEL_SELECT = "model.select"
    const val METHOD_COMMAND_LIST = "command.list"
    const val METHOD_COMMAND_EXECUTE = "command.execute"
    const val METHOD_SKILL_LIST = "skill.list"
    const val METHOD_WORKSPACE_UPLOAD_OPEN = "workspace.upload.open"
    const val METHOD_WORKSPACE_UPLOAD_CHUNK = "workspace.upload.chunk"
    const val METHOD_WORKSPACE_UPLOAD_COMMIT = "workspace.upload.commit"
    const val METHOD_WORKSPACE_UPLOAD_ABORT = "workspace.upload.abort"
}

data class SessionRef(
    val id: String,
    val title: String?,
    val updatedAtMs: Long? = null,
    val cwd: String? = null,
    val status: String? = null,
    val preview: String? = null,
    val pendingApprovals: Int = 0,
    val pendingQuestions: Int = 0,
)

data class SessionHistoryResult(
    val sessionId: String,
    val events: List<OfficialSessionEvent>,
    val hasMore: Boolean,
    val oldestSeq: Long?,
    val latestSeq: Long?,
    val source: String,
)

data class SessionSearchHit(
    val sessionId: String,
    val title: String?,
    val seq: Long,
    val type: String,
    val snippet: String,
    val updatedAt: String? = null,
)

data class SessionSearchResult(
    val query: String,
    val hits: List<SessionSearchHit>,
    val hasMore: Boolean,
)

data class RemoteCommandDescriptor(
    val name: String,
    val description: String,
    val inputHint: String? = null,
    val acceptsAttachments: Boolean = false,
)

data class CommandExecuteResult(
    val ok: Boolean,
    val commandId: String? = null,
    val output: String? = null,
    val error: String? = null,
)

data class RemoteSkillSummary(
    val name: String,
    val description: String,
    val whenToUse: String? = null,
    val source: String? = null,
)

data class WorkspaceUploadOpenResult(
    val uploadId: String,
    val sessionId: String,
    val chunkBytes: Int,
    val maxBytes: Int,
    val relativePath: String,
)

data class WorkspaceUploadChunkResult(
    val uploadId: String,
    val receivedBytes: Int,
    val nextOffset: Int,
)

data class WorkspaceUploadCommitResult(
    val uploadId: String,
    val sessionId: String,
    val relativePath: String,
    val bytesWritten: Int,
    val sha256: String,
)

data class WorkspaceUploadAbortResult(
    val uploadId: String,
    val aborted: Boolean,
)

data class ReasoningEffortOption(
    val value: String,
    val label: String,
    val description: String? = null,
)

data class PromptImageAttachment(
    val mediaType: String,
    val dataBase64: String,
    val name: String? = null,
) {
    fun toJson(): JsonObject = JsonObject.of(
        "type" to JsonString("image"),
        "mediaType" to JsonString(mediaType),
        "dataBase64" to JsonString(dataBase64),
        "name" to name?.trim()?.takeIf { it.isNotEmpty() }?.take(120)?.let { JsonString(it) },
    )
}

data class ModelOptionRef(
    val provider: String,
    val providerName: String? = null,
    val model: String,
    val name: String,
    val description: String? = null,
    val supportsImageInput: Boolean = false,
    val reasoningEfforts: List<ReasoningEffortOption> = emptyList(),
    val defaultReasoningEffort: String? = null,
    val contextWindow: Int? = null,
)

data class ModelCatalogResult(
    val currentProvider: String?,
    val currentModel: String?,
    val currentReasoningEffort: String?,
    val models: List<ModelOptionRef>,
)

data class QuestionOptionSpec(
    val label: String,
    val description: String? = null,
)

data class QuestionSpec(
    val id: String,
    val header: String? = null,
    val question: String,
    val multiSelect: Boolean = false,
    val options: List<QuestionOptionSpec> = emptyList(),
)

data class OfficialSessionEvent(
    val seq: Long,
    val type: String,
    val data: JsonValue?,
)

sealed interface AttachResumeResult {
    data class Events(val events: List<OfficialSessionEvent>) : AttachResumeResult
    data class ResetRequired(val reason: String) : AttachResumeResult
}

data class HandshakeCompleteNotice(
    val connectionEpoch: Int,
    val channelState: String,
)

data class RpcErrorPayload(
    val code: Int,
    val name: String,
    override val message: String,
) : RuntimeException("$name: $message")

sealed interface InboundHostFrame {
    data class HandshakeComplete(val notice: HandshakeCompleteNotice) : InboundHostFrame
    data class RpcSuccess(val id: String, val result: JsonValue) : InboundHostFrame
    data class RpcFailure(val id: String?, val error: RpcErrorPayload) : InboundHostFrame
    data class StreamEvent(val sessionId: String, val event: OfficialSessionEvent) : InboundHostFrame
    data class StreamReset(val sessionId: String, val reason: String) : InboundHostFrame
    data class PeerRevoked(val reason: String) : InboundHostFrame
}

/**
 * Generates stable idempotency keys per logical mutating user operation so retries
 * across LAN -> WebRTC -> Relay failover never execute a prompt/approval/question twice.
 */
class ClientOperationFactory {
    fun nextIdempotencyKey(prefix: String = "android"): String =
        "$prefix-${UUID.randomUUID()}"
}

object RemoteFrameCodec {
    fun encodePairingRequest(
        id: String,
        bootstrapToken: String,
        displayName: String,
    ): String {
        val params = JsonObject.of(
            "token" to JsonString(bootstrapToken),
            "displayName" to JsonString(displayName),
        )
        return JsonObject.of(
            "jsonrpc" to JsonString("2.0"),
            "id" to JsonString(id),
            "method" to JsonString(RemoteProtocol.METHOD_PAIRING_REQUEST),
            "params" to params,
        ).stringify()
    }

    fun encodeRpcRequest(
        id: String,
        method: String,
        connectionEpoch: Int,
        requestSeq: Long,
        params: JsonObject,
        idempotencyKey: String? = null,
    ): String {
        require(connectionEpoch >= 1) { "connectionEpoch must be >= 1" }
        require(requestSeq >= 1L) { "requestSeq must be >= 1" }
        return JsonObject.of(
            "jsonrpc" to JsonString("2.0"),
            "id" to JsonString(id),
            "method" to JsonString(method),
            "protocolVersion" to JsonNumber(RemoteProtocol.PROTOCOL_VERSION),
            "connectionEpoch" to JsonNumber(connectionEpoch),
            "requestSeq" to JsonNumber(requestSeq),
            "idempotencyKey" to idempotencyKey?.let { JsonString(it) },
            "params" to params,
        ).stringify()
    }

    fun decodeHostFrame(jsonText: String): InboundHostFrame {
        val obj = JsonCodec.parseObject(jsonText)
        val type = obj.str("type")
        if (type == "handshake.complete") {
            val epoch = obj.intVal("connectionEpoch")
                ?: throw IllegalArgumentException("handshake.complete missing connectionEpoch")
            if (epoch < 1) {
                throw SecurityException("host sent invalid non-positive connectionEpoch=$epoch")
            }
            val state = obj.str("state")
                ?: throw IllegalArgumentException("handshake.complete missing state")
            return InboundHostFrame.HandshakeComplete(
                HandshakeCompleteNotice(connectionEpoch = epoch, channelState = state),
            )
        }

        if (type == "stream.event") {
            val sessionId = obj.str("sessionId")
                ?: throw IllegalArgumentException("stream.event missing sessionId")
            val evtObj = obj.obj("event")
                ?: throw IllegalArgumentException("stream.event missing event")
            val event = parseSessionEvent(evtObj)
            return InboundHostFrame.StreamEvent(sessionId = sessionId, event = event)
        }

        if (type == "stream.reset") {
            val sessionId = obj.str("sessionId")
                ?: throw IllegalArgumentException("stream.reset missing sessionId")
            val reason = obj.str("reason") ?: "window-unavailable"
            return InboundHostFrame.StreamReset(sessionId = sessionId, reason = reason)
        }

        if (type == "peer.revoked") {
            val reason = obj.str("reason") ?: "device revoked"
            return InboundHostFrame.PeerRevoked(reason = reason)
        }

        if (obj.str("jsonrpc") == "2.0") {
            val id = obj.str("id")
            val errObj = obj.obj("error")
            if (errObj != null) {
                val code = errObj.intVal("code") ?: -32000
                val name = errObj.str("name") ?: "REMOTE_ERROR"
                val message = errObj.str("message") ?: "unknown error"
                return InboundHostFrame.RpcFailure(
                    id = id,
                    error = RpcErrorPayload(code = code, name = name, message = message),
                )
            }
            val result = obj.fields["result"] ?: JsonNull
            return InboundHostFrame.RpcSuccess(
                id = id ?: throw IllegalArgumentException("JSON-RPC response missing id"),
                result = result,
            )
        }

        throw IllegalArgumentException("unrecognized host frame: $jsonText")
    }

    fun parseSessionList(result: JsonValue): List<SessionRef> {
        val arr = result as? JsonArray
            ?: throw IllegalArgumentException("session.list result must be JSON array")
        return arr.items.map { item -> parseSessionRef(item) }
    }

    fun parseSessionRef(result: JsonValue): SessionRef {
        val rawObj = result as? JsonObject
            ?: throw IllegalArgumentException("session item must be JSON object")
        val obj = rawObj.obj("session") ?: rawObj
        return SessionRef(
            id = obj.str("id") ?: throw IllegalArgumentException("session item missing id"),
            title = obj.str("title")?.let(DisplayTextSanitizer::sanitizeLoneSurrogates),
            updatedAtMs = obj.longVal("updatedAtMs"),
            cwd = obj.str("cwd")?.let(DisplayTextSanitizer::sanitizeLoneSurrogates),
            status = obj.str("status"),
            preview = obj.str("preview")?.let {
                DisplayTextSanitizer.truncateByCodePoints(DisplayTextSanitizer.sanitizeSingleLine(it), 160)
            },
            pendingApprovals = obj.intVal("pendingApprovals") ?: 0,
            pendingQuestions = obj.intVal("pendingQuestions") ?: 0,
        )
    }

    fun parseSessionHistoryResult(result: JsonValue): SessionHistoryResult {
        val obj = result as? JsonObject
            ?: throw IllegalArgumentException("session.history result must be JSON object")
        val eventsArr = obj.arr("events")?.items.orEmpty()
        val events = eventsArr.map { item ->
            parseSessionEvent(
                item as? JsonObject
                    ?: throw IllegalArgumentException("session.history event must be JSON object"),
            )
        }
        return SessionHistoryResult(
            sessionId = obj.str("sessionId")
                ?: throw IllegalArgumentException("session.history result missing sessionId"),
            events = events,
            hasMore = obj.bool("hasMore") == true,
            oldestSeq = obj.longVal("oldestSeq"),
            latestSeq = obj.longVal("latestSeq"),
            source = obj.str("source") ?: "live",
        )
    }

    fun parseSessionSearchResult(result: JsonValue): SessionSearchResult {
        val obj = result as? JsonObject
            ?: throw IllegalArgumentException("session.search result must be JSON object")
        val hitsArr = obj.arr("hits")?.items.orEmpty()
        val hits = hitsArr.mapNotNull { item ->
            val hObj = item as? JsonObject ?: return@mapNotNull null
            val sid = hObj.str("sessionId") ?: return@mapNotNull null
            SessionSearchHit(
                sessionId = sid,
                title = hObj.str("title"),
                seq = hObj.longVal("seq") ?: 0L,
                type = hObj.str("type") ?: "event",
                snippet = hObj.str("snippet") ?: "",
                updatedAt = hObj.str("updatedAt"),
            )
        }
        return SessionSearchResult(
            query = obj.str("query") ?: "",
            hits = hits,
            hasMore = obj.bool("hasMore") == true,
        )
    }

    fun parseCommandList(result: JsonValue): List<RemoteCommandDescriptor> {
        val arr = when (result) {
            is JsonArray -> result.items
            is JsonObject -> result.arr("commands")?.items.orEmpty()
            else -> emptyList()
        }
        return arr.mapNotNull { item ->
            val obj = item as? JsonObject ?: return@mapNotNull null
            val name = obj.str("name")?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            RemoteCommandDescriptor(
                name = name,
                description = obj.str("description") ?: "",
                inputHint = obj.str("inputHint"),
                acceptsAttachments = obj.bool("acceptsAttachments") == true,
            )
        }
    }

    fun parseCommandExecuteResult(result: JsonValue): CommandExecuteResult {
        val obj = result as? JsonObject ?: return CommandExecuteResult(ok = false, error = "invalid response")
        return CommandExecuteResult(
            ok = obj.bool("ok") != false,
            commandId = obj.str("commandId"),
            output = obj.str("output"),
            error = obj.str("error"),
        )
    }

    fun parseSkillList(result: JsonValue): List<RemoteSkillSummary> {
        val arr = when (result) {
            is JsonArray -> result.items
            is JsonObject -> result.arr("skills")?.items.orEmpty()
            else -> emptyList()
        }
        return arr.mapNotNull { item ->
            val obj = item as? JsonObject ?: return@mapNotNull null
            val name = obj.str("name")?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            RemoteSkillSummary(
                name = name,
                description = obj.str("description") ?: "",
                whenToUse = obj.str("whenToUse"),
                source = obj.str("source"),
            )
        }
    }

    fun parseWorkspaceUploadOpenResult(result: JsonValue): WorkspaceUploadOpenResult {
        val obj = result as? JsonObject
            ?: throw IllegalArgumentException("workspace.upload.open result must be JSON object")
        return WorkspaceUploadOpenResult(
            uploadId = obj.str("uploadId")
                ?: throw IllegalArgumentException("workspace.upload.open missing uploadId"),
            sessionId = obj.str("sessionId") ?: "",
            chunkBytes = obj.intVal("chunkBytes") ?: 32_768,
            maxBytes = obj.intVal("maxBytes") ?: 20 * 1024 * 1024,
            relativePath = obj.str("relativePath") ?: "",
        )
    }

    fun parseWorkspaceUploadChunkResult(result: JsonValue): WorkspaceUploadChunkResult {
        val obj = result as? JsonObject
            ?: throw IllegalArgumentException("workspace.upload.chunk result must be JSON object")
        return WorkspaceUploadChunkResult(
            uploadId = obj.str("uploadId")
                ?: throw IllegalArgumentException("workspace.upload.chunk missing uploadId"),
            receivedBytes = obj.intVal("receivedBytes") ?: 0,
            nextOffset = obj.intVal("nextOffset") ?: 0,
        )
    }

    fun parseWorkspaceUploadCommitResult(result: JsonValue): WorkspaceUploadCommitResult {
        val obj = result as? JsonObject
            ?: throw IllegalArgumentException("workspace.upload.commit result must be JSON object")
        return WorkspaceUploadCommitResult(
            uploadId = obj.str("uploadId")
                ?: throw IllegalArgumentException("workspace.upload.commit missing uploadId"),
            sessionId = obj.str("sessionId") ?: "",
            relativePath = obj.str("relativePath") ?: "",
            bytesWritten = obj.intVal("bytesWritten") ?: 0,
            sha256 = obj.str("sha256") ?: "",
        )
    }

    fun parseWorkspaceUploadAbortResult(result: JsonValue): WorkspaceUploadAbortResult {
        val obj = result as? JsonObject
            ?: throw IllegalArgumentException("workspace.upload.abort result must be JSON object")
        return WorkspaceUploadAbortResult(
            uploadId = obj.str("uploadId") ?: "",
            aborted = obj.bool("aborted") == true,
        )
    }

    fun parseModelCatalog(result: JsonValue): ModelCatalogResult {
        val obj = result as? JsonObject ?: return ModelCatalogResult(null, null, null, emptyList())
        val currentObj = obj.obj("current")
        val modelsArr = obj.arr("models")?.items.orEmpty()
        val models = modelsArr.mapNotNull { item ->
            val mObj = item as? JsonObject ?: return@mapNotNull null
            val provider = mObj.str("provider")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val model = mObj.str("model")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val efforts = mObj.arr("reasoningEfforts")?.items.orEmpty().mapNotNull { effortItem ->
                val eObj = effortItem as? JsonObject ?: return@mapNotNull null
                val value = eObj.str("value")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                ReasoningEffortOption(
                    value = value,
                    label = eObj.str("label")?.takeIf { it.isNotBlank() } ?: value,
                    description = eObj.str("description"),
                )
            }
            ModelOptionRef(
                provider = provider,
                providerName = mObj.str("providerName"),
                model = model,
                name = mObj.str("name")?.takeIf { it.isNotBlank() } ?: model,
                description = mObj.str("description"),
                supportsImageInput = mObj.bool("supportsImageInput") == true,
                reasoningEfforts = efforts,
                defaultReasoningEffort = mObj.str("defaultReasoningEffort"),
                contextWindow = mObj.intVal("contextWindow"),
            )
        }
        return ModelCatalogResult(
            currentProvider = currentObj?.str("provider"),
            currentModel = currentObj?.str("model"),
            currentReasoningEffort = currentObj?.str("reasoningEffort"),
            models = models,
        )
    }

    fun parseQuestionSpecs(dataObj: JsonObject): List<QuestionSpec> {
        val rawArr = dataObj.arr("questions")?.items.orEmpty()
        val parsed = ArrayList<QuestionSpec>(rawArr.size)
        for ((index, rawItem) in rawArr.withIndex()) {
            val qObj = rawItem as? JsonObject ?: continue
            val qId = qObj.str("id")?.takeIf { it.isNotBlank() } ?: "q${index + 1}"
            val qText = qObj.str("question")
                ?: qObj.str("prompt")
                ?: qObj.str("header")
                ?: ""
            val options = qObj.arr("options")?.items.orEmpty().mapNotNull { optRaw ->
                val optObj = optRaw as? JsonObject ?: return@mapNotNull null
                val label = optObj.str("label")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                QuestionOptionSpec(
                    label = label,
                    description = optObj.str("description"),
                )
            }
            parsed.add(
                QuestionSpec(
                    id = qId,
                    header = qObj.str("header"),
                    question = qText,
                    multiSelect = qObj.bool("multiSelect") == true,
                    options = options,
                ),
            )
        }
        return parsed
    }

    fun parseAttachResult(result: JsonValue): AttachResumeResult {
        val obj = result as? JsonObject
            ?: throw IllegalArgumentException("session.attach result must be JSON object")
        return when (val kind = obj.str("kind")) {
            "events" -> {
                val arr = obj.arr("events")
                    ?: throw IllegalArgumentException("session.attach events result missing events array")
                AttachResumeResult.Events(
                    arr.items.map { item ->
                        parseSessionEvent(
                            item as? JsonObject
                                ?: throw IllegalArgumentException("event entry must be object"),
                        )
                    },
                )
            }
            "reset" -> {
                AttachResumeResult.ResetRequired(obj.str("reason") ?: "window-unavailable")
            }
            else -> throw IllegalArgumentException("unknown session.attach kind: $kind")
        }
    }

    private fun parseSessionEvent(obj: JsonObject): OfficialSessionEvent {
        val seq = obj.longVal("seq")
            ?: throw IllegalArgumentException("session event missing seq")
        val evtType = obj.str("type")
            ?: throw IllegalArgumentException("session event missing type")
        return OfficialSessionEvent(
            seq = seq,
            type = evtType,
            data = obj.fields["data"],
        )
    }
}
