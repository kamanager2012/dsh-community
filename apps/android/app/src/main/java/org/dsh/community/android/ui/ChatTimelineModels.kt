package org.dsh.community.android.ui

import org.dsh.community.android.protocol.DisplayTextSanitizer
import org.dsh.community.android.protocol.JsonArray
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.JsonString
import org.dsh.community.android.protocol.JsonValue
import org.dsh.community.android.protocol.OfficialSessionEvent

enum class ToolExecutionStatus {
    RUNNING,
    COMPLETED,
    ERROR,
}

sealed interface ChatTimelineItem {
    val stableId: String
}

data class UserMessageItem(
    override val stableId: String,
    val seq: Long,
    val text: String,
    val isOptimistic: Boolean = false,
    val attachmentLabels: List<String> = emptyList(),
) : ChatTimelineItem

data class AssistantTurnItem(
    override val stableId: String,
    val seq: Long,
    val thinkingText: String = "",
    val markdownText: String = "",
    val isThinkingExpanded: Boolean = false,
    val isFinalized: Boolean = false,
    val interrupted: Boolean = false,
) : ChatTimelineItem

data class ToolExecutionItem(
    override val stableId: String,
    val seq: Long,
    val callId: String,
    val toolName: String,
    val argumentsText: String = "",
    val outputText: String = "",
    val status: ToolExecutionStatus = ToolExecutionStatus.RUNNING,
    val isExpanded: Boolean = false,
) : ChatTimelineItem

data class SystemNoticeItem(
    override val stableId: String,
    val seq: Long,
    val text: String,
    val isError: Boolean = false,
) : ChatTimelineItem

/**
 * Pure Kotlin state reducer mapping streamed [OfficialSessionEvent] payloads onto an ordered,
 * deduplicated chat timeline per remote session.
 */
class ChatTimelineStore {
    private val itemsBySession = LinkedHashMap<String, MutableList<ChatTimelineItem>>()
    private val highestSeqBySession = HashMap<String, Long>()
    private val seenEventKeysBySession = HashMap<String, HashSet<String>>()
    private var idSeq = 0L

    @Synchronized
    fun addOptimisticUserPrompt(
        sessionId: String,
        prompt: String,
        attachmentNames: List<String> = emptyList(),
    ) {
        val clean = sanitizeMultiline(prompt, MAX_MESSAGE_CHARS).trim()
        val cleanAttachments = attachmentNames
            .mapNotNull { DisplayTextSanitizer.sanitizeSingleLine(it).takeIf { s -> s.isNotEmpty() } }
            .take(2)
        if (clean.isEmpty() && cleanAttachments.isEmpty()) return
        val list = itemsBySession.getOrPut(sessionId) { ArrayList() }
        val localSeq = (highestSeqBySession[sessionId] ?: 0L)
        list.add(
            UserMessageItem(
                stableId = "u-${++idSeq}",
                seq = localSeq,
                text = clean,
                isOptimistic = true,
                attachmentLabels = cleanAttachments,
            ),
        )
    }

    @Synchronized
    fun applyEvent(sessionId: String, event: OfficialSessionEvent) {
        if (event.seq > 0L) {
            val seen = seenEventKeysBySession.getOrPut(sessionId) { HashSet() }
            val key = "${event.seq}:${event.type}"
            if (!seen.add(key)) {
                return
            }
            val prevHigh = highestSeqBySession[sessionId] ?: 0L
            if (event.seq > prevHigh) {
                highestSeqBySession[sessionId] = event.seq
            }
        }

        val list = itemsBySession.getOrPut(sessionId) { ArrayList() }
        val dataObj = event.data as? JsonObject
        val evtType = event.type.trim().lowercase()

        when {
            evtType == "user/message" || evtType == "user.message" || evtType == "prompt" -> {
                val (text, attachments) = extractUserContent(dataObj) ?: return
                val optimisticIdx = list.indexOfLast {
                    it is UserMessageItem && it.isOptimistic && it.text.trim() == text.trim()
                }
                if (optimisticIdx >= 0) {
                    val existing = list[optimisticIdx] as UserMessageItem
                    list[optimisticIdx] = existing.copy(
                        seq = event.seq,
                        isOptimistic = false,
                        attachmentLabels = if (attachments.isNotEmpty()) attachments else existing.attachmentLabels,
                    )
                } else {
                    list.add(
                        UserMessageItem(
                            stableId = "u-${++idSeq}",
                            seq = event.seq,
                            text = text,
                            attachmentLabels = attachments,
                        ),
                    )
                }
            }

            evtType == "assistant/chunk" ||
                evtType == "assistant.chunk" ||
                evtType == "text-delta" ||
                evtType == "reasoning-delta" -> {
                if (dataObj == null) return
                val (isThinking, delta) = extractChunkDelta(evtType, dataObj)
                if (delta.isEmpty()) return
                val tailIdx = list.lastIndex
                val tail = if (tailIdx >= 0) list[tailIdx] else null
                if (tail is AssistantTurnItem && !tail.isFinalized) {
                    val updated = if (isThinking) {
                        tail.copy(
                            seq = event.seq,
                            thinkingText = clampText(tail.thinkingText + delta, MAX_MESSAGE_CHARS),
                        )
                    } else {
                        tail.copy(
                            seq = event.seq,
                            markdownText = clampText(tail.markdownText + delta, MAX_MESSAGE_CHARS),
                        )
                    }
                    list[tailIdx] = updated
                } else {
                    list.add(
                        AssistantTurnItem(
                            stableId = "a-${++idSeq}",
                            seq = event.seq,
                            thinkingText = if (isThinking) clampText(delta, MAX_MESSAGE_CHARS) else "",
                            markdownText = if (isThinking) "" else clampText(delta, MAX_MESSAGE_CHARS),
                            isThinkingExpanded = false,
                            isFinalized = false,
                        ),
                    )
                }
            }

            evtType == "assistant/message" || evtType == "assistant.message" -> {
                val (finalThinking, finalText) = extractFinalAssistantMessage(dataObj)
                val msgObj = dataObj?.obj("message")
                val isInterrupted = msgObj?.bool("interrupted") == true ||
                    dataObj?.str("stopReason") == "aborted" ||
                    msgObj?.str("stopReason") == "aborted"
                val openIdx = findLastOpenAssistantIndex(list)
                if (openIdx >= 0) {
                    val open = list[openIdx] as AssistantTurnItem
                    val resolvedThinking = if (finalThinking.isNotBlank()) finalThinking else open.thinkingText
                    val resolvedText = if (finalText.isNotBlank()) finalText else open.markdownText
                    if (resolvedThinking.isBlank() && resolvedText.isBlank()) {
                        list.removeAt(openIdx)
                    } else {
                        list[openIdx] = open.copy(
                            seq = event.seq,
                            thinkingText = resolvedThinking,
                            markdownText = resolvedText,
                            isFinalized = true,
                            interrupted = isInterrupted || open.interrupted,
                        )
                    }
                } else if (finalThinking.isNotBlank() || finalText.isNotBlank()) {
                    list.add(
                        AssistantTurnItem(
                            stableId = "a-${++idSeq}",
                            seq = event.seq,
                            thinkingText = finalThinking,
                            markdownText = finalText,
                            isThinkingExpanded = false,
                            isFinalized = true,
                            interrupted = isInterrupted,
                        ),
                    )
                }
            }

            evtType == "tool/call" || evtType == "tool.call" -> {
                if (dataObj == null) return
                finalizeOpenAssistantAtTail(list)
                val callObj = dataObj.obj("call")
                val callId = dataObj.str("callId")
                    ?: callObj?.str("id")
                    ?: "call-${event.seq}"
                val toolName = DisplayTextSanitizer.sanitizeSingleLine(
                    dataObj.str("name")
                        ?: dataObj.str("tool")
                        ?: dataObj.str("toolName")
                        ?: callObj?.str("name")
                        ?: "tool",
                )
                val rawArgs = formatValueForDisplay(
                    dataObj.fields["arguments"]
                        ?: dataObj.fields["args"]
                        ?: dataObj.fields["input"]
                        ?: callObj?.fields?.get("arguments"),
                )
                val existingIdx = list.indexOfLast { it is ToolExecutionItem && it.callId == callId }
                if (existingIdx >= 0) {
                    val prev = list[existingIdx] as ToolExecutionItem
                    list[existingIdx] = prev.copy(
                        seq = event.seq,
                        toolName = toolName,
                        argumentsText = rawArgs.ifBlank { prev.argumentsText },
                    )
                } else {
                    list.add(
                        ToolExecutionItem(
                            stableId = "t-${++idSeq}",
                            seq = event.seq,
                            callId = callId,
                            toolName = toolName,
                            argumentsText = rawArgs,
                            outputText = "",
                            status = ToolExecutionStatus.RUNNING,
                            isExpanded = false,
                        ),
                    )
                }
            }

            evtType == "tool/result" || evtType == "tool.result" -> {
                if (dataObj == null) return
                val msgObj = dataObj.obj("message") ?: dataObj
                val callId = msgObj.str("callId") ?: dataObj.str("callId") ?: ""
                val isErr = msgObj.bool("isError") == true ||
                    dataObj.bool("isError") == true ||
                    !dataObj.str("error").isNullOrBlank()
                val rawOut = dataObj.str("error")?.let { sanitizeMultiline(it, MAX_TOOL_CHARS) }
                    ?: extractTextFromContentValue(msgObj.fields["content"])?.let { sanitizeMultiline(it, MAX_TOOL_CHARS) }
                    ?: formatValueForDisplay(dataObj.fields["result"] ?: dataObj.fields["output"], MAX_TOOL_CHARS)
                val idx = if (callId.isNotBlank()) {
                    list.indexOfLast { it is ToolExecutionItem && it.callId == callId }
                } else {
                    list.indexOfLast { it is ToolExecutionItem && it.status == ToolExecutionStatus.RUNNING }
                }
                val newStatus = if (isErr) ToolExecutionStatus.ERROR else ToolExecutionStatus.COMPLETED
                if (idx >= 0) {
                    val prev = list[idx] as ToolExecutionItem
                    list[idx] = prev.copy(
                        seq = event.seq,
                        outputText = rawOut,
                        status = newStatus,
                    )
                } else {
                    list.add(
                        ToolExecutionItem(
                            stableId = "t-${++idSeq}",
                            seq = event.seq,
                            callId = callId.ifBlank { "tool-${event.seq}" },
                            toolName = DisplayTextSanitizer.sanitizeSingleLine(dataObj.str("tool") ?: "tool"),
                            outputText = rawOut,
                            status = newStatus,
                            isExpanded = false,
                        ),
                    )
                }
            }

            evtType == "turn/end" || evtType == "turn.end" -> {
                finalizeAllOpenAssistants(list)
                val reasonObj = dataObj?.obj("reason")
                val kind = reasonObj?.str("kind")?.lowercase() ?: dataObj?.str("reason")?.lowercase()
                if (kind == "aborted") {
                    for (i in list.lastIndex downTo 0) {
                        val tail = list[i]
                        if (tail is AssistantTurnItem) {
                            list[i] = tail.copy(isFinalized = true, interrupted = true)
                            break
                        }
                        if (tail is UserMessageItem) break
                    }
                    list.add(
                        SystemNoticeItem(
                            stableId = "n-${++idSeq}",
                            seq = event.seq,
                            text = "Turn stopped by user",
                            isError = false,
                        ),
                    )
                } else if (kind == "error") {
                    val errMsg = DisplayTextSanitizer.sanitizeSingleLine(
                        reasonObj?.str("message") ?: dataObj?.str("error") ?: "Turn failed",
                    )
                    list.add(
                        SystemNoticeItem(
                            stableId = "n-${++idSeq}",
                            seq = event.seq,
                            text = "Error: $errMsg",
                            isError = true,
                        ),
                    )
                }
            }

            evtType == "error" || evtType == "session/error" -> {
                val errMsg = DisplayTextSanitizer.sanitizeSingleLine(
                    dataObj?.str("message") ?: dataObj?.str("error") ?: event.type,
                )
                list.add(
                    SystemNoticeItem(
                        stableId = "n-${++idSeq}",
                        seq = event.seq,
                        text = "Error: $errMsg",
                        isError = true,
                    ),
                )
            }
        }
    }

    @Synchronized
    fun clearSession(sessionId: String) {
        itemsBySession.remove(sessionId)
        highestSeqBySession.remove(sessionId)
        seenEventKeysBySession.remove(sessionId)
    }

    @Synchronized
    fun clearAll() {
        itemsBySession.clear()
        highestSeqBySession.clear()
        seenEventKeysBySession.clear()
    }

    @Synchronized
    fun toggleThinkingExpanded(sessionId: String, stableId: String) {
        val list = itemsBySession[sessionId] ?: return
        val idx = list.indexOfFirst { it.stableId == stableId }
        if (idx >= 0) {
            val item = list[idx] as? AssistantTurnItem ?: return
            list[idx] = item.copy(isThinkingExpanded = !item.isThinkingExpanded)
        }
    }

    @Synchronized
    fun toggleToolExpanded(sessionId: String, stableId: String) {
        val list = itemsBySession[sessionId] ?: return
        val idx = list.indexOfFirst { it.stableId == stableId }
        if (idx >= 0) {
            val item = list[idx] as? ToolExecutionItem ?: return
            list[idx] = item.copy(isExpanded = !item.isExpanded)
        }
    }

    @Synchronized
    fun itemsForSession(sessionId: String): List<ChatTimelineItem> =
        itemsBySession[sessionId]?.toList() ?: emptyList()

    @Synchronized
    fun streamSummaryText(sessionId: String): String {
        val items = itemsBySession[sessionId] ?: return ""
        val parts = ArrayList<String>()
        for (item in items) {
            when (item) {
                is AssistantTurnItem -> {
                    if (item.markdownText.isNotBlank()) {
                        parts.add(item.markdownText.trim())
                    }
                }
                is SystemNoticeItem -> {
                    if (item.isError && item.text.isNotBlank()) {
                        parts.add(item.text.trim())
                    }
                }
                else -> {}
            }
        }
        return parts.joinToString("\n\n")
    }

    @Synchronized
    fun exportAsMarkdown(sessionId: String, sessionTitle: String? = null): String {
        val items = itemsBySession[sessionId] ?: return ""
        val sb = StringBuilder()
        val heading = sessionTitle?.takeIf { it.isNotBlank() } ?: sessionId
        sb.append("# DSH Session: ").append(DisplayTextSanitizer.sanitizeSingleLine(heading)).append("\n\n")
        for (item in items) {
            when (item) {
                is UserMessageItem -> {
                    sb.append("## User\n\n")
                    if (item.attachmentLabels.isNotEmpty()) {
                        for (label in item.attachmentLabels) {
                            sb.append("- _Image attachment_: `").append(label).append("`\n")
                        }
                        if (item.text.isNotBlank()) sb.append('\n')
                    }
                    if (item.text.isNotBlank()) {
                        sb.append(item.text).append("\n\n")
                    } else {
                        sb.append('\n')
                    }
                }
                is AssistantTurnItem -> {
                    sb.append("## Assistant\n\n")
                    if (item.thinkingText.isNotBlank()) {
                        sb.append("<details>\n<summary>Thinking</summary>\n\n")
                            .append(item.thinkingText)
                            .append("\n\n</details>\n\n")
                    }
                    if (item.markdownText.isNotBlank()) {
                        sb.append(item.markdownText).append("\n\n")
                    }
                    if (item.interrupted) {
                        sb.append("_Interrupted_\n\n")
                    }
                }
                is ToolExecutionItem -> {
                    sb.append("### Tool `").append(item.toolName).append("` (")
                        .append(item.status.name.lowercase()).append(")\n\n")
                    if (item.argumentsText.isNotBlank()) {
                        sb.append("```json\n").append(item.argumentsText).append("\n```\n\n")
                    }
                    if (item.outputText.isNotBlank()) {
                        sb.append("```\n").append(item.outputText).append("\n```\n\n")
                    }
                }
                is SystemNoticeItem -> {
                    sb.append("> ").append(item.text).append("\n\n")
                }
            }
        }
        return sb.toString().trim()
    }

    private fun finalizeOpenAssistantAtTail(list: MutableList<ChatTimelineItem>) {
        val lastIdx = list.lastIndex
        if (lastIdx >= 0) {
            val tail = list[lastIdx]
            if (tail is AssistantTurnItem && !tail.isFinalized) {
                list[lastIdx] = tail.copy(isFinalized = true)
            }
        }
    }

    private fun finalizeAllOpenAssistants(list: MutableList<ChatTimelineItem>) {
        for (i in list.indices) {
            val item = list[i]
            if (item is AssistantTurnItem && !item.isFinalized) {
                list[i] = item.copy(isFinalized = true)
            }
        }
    }

    private fun findLastOpenAssistantIndex(list: List<ChatTimelineItem>): Int {
        for (i in list.lastIndex downTo 0) {
            val item = list[i]
            if (item is UserMessageItem) return -1
            if (item is AssistantTurnItem && !item.isFinalized) return i
        }
        return -1
    }

    private fun extractUserContent(dataObj: JsonObject?): Pair<String, List<String>>? {
        if (dataObj == null) return null
        val contentVal = dataObj.obj("message")?.fields?.get("content") ?: dataObj.fields["content"]
        val imageNames = ArrayList<String>()
        if (contentVal is JsonArray) {
            for (part in contentVal.items) {
                val partObj = part as? JsonObject ?: continue
                if (partObj.str("type") == "image") {
                    val attObj = partObj.obj("attachment")
                    val name = attObj?.str("name")
                        ?: partObj.str("name")
                        ?: attObj?.str("mediaType")
                        ?: partObj.str("mediaType")
                        ?: "image"
                    imageNames.add(DisplayTextSanitizer.sanitizeSingleLine(name).ifBlank { "image" })
                }
            }
        }
        val directAtts = dataObj.arr("attachments")
        if (directAtts != null) {
            for (att in directAtts.items) {
                val attObj = att as? JsonObject ?: continue
                val name = attObj.str("name") ?: attObj.str("mediaType") ?: "image"
                imageNames.add(DisplayTextSanitizer.sanitizeSingleLine(name).ifBlank { "image" })
            }
        }
        val direct = dataObj.str("text") ?: dataObj.str("prompt")
        val text = if (!direct.isNullOrBlank()) {
            sanitizeMultiline(direct, MAX_MESSAGE_CHARS).trim()
        } else {
            extractTextFromContentValue(contentVal)?.let { sanitizeMultiline(it, MAX_MESSAGE_CHARS).trim() }.orEmpty()
        }
        if (text.isEmpty() && imageNames.isEmpty()) return null
        return text to imageNames.take(4)
    }

    private fun extractUserText(dataObj: JsonObject?): String? =
        extractUserContent(dataObj)?.first?.takeIf { it.isNotBlank() }

    private fun extractChunkDelta(evtType: String, dataObj: JsonObject): Pair<Boolean, String> {
        val chunkObj = dataObj.obj("frame")?.obj("chunk") ?: dataObj.obj("chunk") ?: dataObj
        val typeHint = (chunkObj.str("type") ?: dataObj.str("kind") ?: "").lowercase()
        val isThinking = evtType == "reasoning-delta" || typeHint.contains("think") || typeHint.contains("reason")
        val rawDelta = chunkObj.str("delta")
            ?: chunkObj.str("text")
            ?: chunkObj.str("thinking")
            ?: chunkObj.str("reasoning")
            ?: dataObj.str("delta")
            ?: dataObj.str("text")
            ?: ""
        if (rawDelta.isEmpty()) return isThinking to ""
        return isThinking to sanitizeChunk(rawDelta)
    }

    private fun extractFinalAssistantMessage(dataObj: JsonObject?): Pair<String, String> {
        if (dataObj == null) return "" to ""
        val msgObj = dataObj.obj("message") ?: dataObj
        val thinkingParts = ArrayList<String>()
        val textParts = ArrayList<String>()

        dataObj.str("thinking")?.takeIf { it.isNotBlank() }?.let { thinkingParts.add(it) }
        msgObj.str("thinking")?.takeIf { it.isNotBlank() }?.let { thinkingParts.add(it) }
        dataObj.str("reasoning")?.takeIf { it.isNotBlank() }?.let { thinkingParts.add(it) }

        val contentVal = msgObj.fields["content"] ?: dataObj.fields["content"]
        when (contentVal) {
            is JsonString -> {
                if (contentVal.value.isNotEmpty()) textParts.add(contentVal.value)
            }
            is JsonArray -> {
                for (block in contentVal.items) {
                    val bObj = block as? JsonObject ?: continue
                    val bType = (bObj.str("type") ?: "").lowercase()
                    if (bType == "thinking" || bType == "reasoning") {
                        val t = bObj.str("thinking") ?: bObj.str("reasoning") ?: bObj.str("text")
                        if (!t.isNullOrBlank()) thinkingParts.add(t)
                    } else if (bType.isEmpty() || bType == "text" || bType == "output_text") {
                        val t = bObj.str("text")
                        if (!t.isNullOrEmpty()) textParts.add(t)
                    }
                }
            }
            else -> {}
        }

        if (textParts.isEmpty()) {
            val fallback = msgObj.str("text") ?: dataObj.str("text")
            if (!fallback.isNullOrBlank()) textParts.add(fallback)
        }

        val cleanThinking = sanitizeMultiline(thinkingParts.joinToString("\n\n"), MAX_MESSAGE_CHARS).trim()
        val cleanText = sanitizeMultiline(textParts.joinToString("\n"), MAX_MESSAGE_CHARS).trim()
        return cleanThinking to cleanText
    }

    private fun extractTextFromContentValue(value: JsonValue?): String? = when (value) {
        is JsonString -> value.value
        is JsonArray -> {
            val parts = ArrayList<String>()
            for (item in value.items) {
                when (item) {
                    is JsonString -> parts.add(item.value)
                    is JsonObject -> {
                        val t = item.str("text") ?: item.str("thinking")
                        if (!t.isNullOrEmpty()) parts.add(t)
                    }
                    else -> {}
                }
            }
            if (parts.isEmpty()) null else parts.joinToString("\n")
        }
        else -> null
    }

    private fun formatValueForDisplay(value: JsonValue?, maxChars: Int = MAX_TOOL_CHARS): String {
        if (value == null) return ""
        val raw = when (value) {
            is JsonString -> value.value
            else -> value.stringify()
        }
        return sanitizeMultiline(raw, maxChars)
    }

    companion object {
        private const val MAX_MESSAGE_CHARS = 24_000
        private const val MAX_TOOL_CHARS = 6_000

        fun sanitizeMultiline(raw: String, maxChars: Int = MAX_MESSAGE_CHARS): String {
            val withoutAnsi = raw.replace(Regex("\u001B\\[[0-?]*[ -/]*[@-~]"), "")
            val normalized = withoutAnsi.replace("\r\n", "\n").replace('\r', '\n')
            val out = StringBuilder(minOf(normalized.length, maxChars))
            for (ch in normalized) {
                if (ch == '\n' || ch == '\t' || (ch.code >= 0x20 && ch.code != 0x7F)) {
                    out.append(ch)
                    if (out.length >= maxChars) break
                }
            }
            return out.toString()
        }

        private fun sanitizeChunk(raw: String): String {
            val withoutAnsi = raw.replace(Regex("\u001B\\[[0-?]*[ -/]*[@-~]"), "")
            val normalized = withoutAnsi.replace("\r\n", "\n").replace('\r', '\n')
            val out = StringBuilder(normalized.length)
            for (ch in normalized) {
                if (ch == '\n' || ch == '\t' || (ch.code >= 0x20 && ch.code != 0x7F)) {
                    out.append(ch)
                }
            }
            return out.toString()
        }

        private fun clampText(text: String, maxChars: Int): String =
            if (text.length <= maxChars) text else text.take(maxChars) + "\n…(truncated)"
    }
}
