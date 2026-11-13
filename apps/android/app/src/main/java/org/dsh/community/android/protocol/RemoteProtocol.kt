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
    const val METHOD_SESSION_CREATE = "session.create"
    const val METHOD_STREAM_ACK = "stream.ack"
    const val METHOD_PROMPT_SUBMIT = "prompt.submit"
    const val METHOD_TURN_ABORT = "turn.abort"
    const val METHOD_APPROVAL_RESPOND = "approval.respond"
    const val METHOD_QUESTION_RESPOND = "question.respond"
    const val METHOD_MODEL_LIST = "model.list"
    const val METHOD_MODEL_SELECT = "model.select"
}

data class SessionRef(
    val id: String,
    val title: String?,
)

data class ModelOptionRef(
    val provider: String,
    val providerName: String? = null,
    val model: String,
    val name: String,
    val description: String? = null,
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
            title = obj.str("title"),
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
            ModelOptionRef(
                provider = provider,
                providerName = mObj.str("providerName"),
                model = model,
                name = mObj.str("name")?.takeIf { it.isNotBlank() } ?: model,
                description = mObj.str("description"),
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
