package org.dsh.community.android

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import org.dsh.community.android.protocol.JsonArray
import org.dsh.community.android.protocol.JsonBool
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.JsonString
import org.dsh.community.android.protocol.OfficialSessionEvent
import org.dsh.community.android.protocol.RemoteFrameCodec
import org.dsh.community.android.protocol.RemoteProtocol
import org.dsh.community.android.qr.QrImageDecoder
import org.dsh.community.android.ui.AssistantTurnItem
import org.dsh.community.android.ui.ChatMarkdownFormatter
import org.dsh.community.android.ui.ChatTimelineStore
import org.dsh.community.android.ui.MarkdownBlock
import org.dsh.community.android.ui.SystemNoticeItem
import org.dsh.community.android.ui.ToolExecutionItem
import org.dsh.community.android.ui.ToolExecutionStatus
import org.dsh.community.android.ui.UserMessageItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatAndQrUnitTest {
    @Test
    fun parsesExtendedRemoteProtocolPayloads() {
        assertEquals("session.create", RemoteProtocol.METHOD_SESSION_CREATE)
        assertEquals("turn.abort", RemoteProtocol.METHOD_TURN_ABORT)
        assertEquals("model.list", RemoteProtocol.METHOD_MODEL_LIST)
        assertEquals("model.select", RemoteProtocol.METHOD_MODEL_SELECT)

        val sessionObj = JsonObject.of(
            "session" to JsonObject.of(
                "id" to JsonString("sess-new-42"),
                "title" to JsonString("Mobile Chat"),
            ),
        )
        val parsedRef = RemoteFrameCodec.parseSessionRef(sessionObj)
        assertEquals("sess-new-42", parsedRef.id)
        assertEquals("Mobile Chat", parsedRef.title)

        val catalogObj = JsonObject.of(
            "current" to JsonObject.of(
                "provider" to JsonString("deepseek"),
                "model" to JsonString("deepseek-reasoner"),
                "reasoningEffort" to JsonString("high"),
            ),
            "models" to JsonArray(
                listOf(
                    JsonObject.of(
                        "provider" to JsonString("deepseek"),
                        "providerName" to JsonString("DeepSeek"),
                        "model" to JsonString("deepseek-chat"),
                        "name" to JsonString("DeepSeek Chat"),
                    ),
                    JsonObject.of(
                        "provider" to JsonString("deepseek"),
                        "model" to JsonString("deepseek-reasoner"),
                        "name" to JsonString("DeepSeek Reasoner"),
                    ),
                ),
            ),
        )
        val catalog = RemoteFrameCodec.parseModelCatalog(catalogObj)
        assertEquals("deepseek", catalog.currentProvider)
        assertEquals("deepseek-reasoner", catalog.currentModel)
        assertEquals("high", catalog.currentReasoningEffort)
        assertEquals(2, catalog.models.size)
        assertEquals("DeepSeek", catalog.models[0].providerName)

        val qData = JsonObject.of(
            "questionId" to JsonString("q-100"),
            "questions" to JsonArray(
                listOf(
                    JsonObject.of(
                        "header" to JsonString("Mode"),
                        "question" to JsonString("Pick profile"),
                        "multiSelect" to JsonBool(true),
                        "options" to JsonArray(
                            listOf(
                                JsonObject.of("label" to JsonString("fast")),
                                JsonObject.of("label" to JsonString("thorough")),
                            ),
                        ),
                    ),
                ),
            ),
        )
        val specs = RemoteFrameCodec.parseQuestionSpecs(qData)
        assertEquals(1, specs.size)
        assertEquals("q1", specs[0].id)
        assertTrue(specs[0].multiSelect)
        assertEquals(listOf("fast", "thorough"), specs[0].options.map { it.label })
    }

    @Test
    fun timelineStoreDeduplicatesAndReducesTurnLifecycle() {
        val store = ChatTimelineStore()
        val sid = "sess-timeline"

        store.addOptimisticUserPrompt(sid, "Hello DSH")
        store.applyEvent(
            sid,
            OfficialSessionEvent(
                seq = 1,
                type = "user/message",
                data = JsonObject.of("text" to JsonString("Hello DSH")),
            ),
        )
        // Duplicate seq replay should be ignored idempotently.
        store.applyEvent(
            sid,
            OfficialSessionEvent(
                seq = 1,
                type = "user/message",
                data = JsonObject.of("text" to JsonString("Hello DSH")),
            ),
        )

        store.applyEvent(
            sid,
            OfficialSessionEvent(
                seq = 2,
                type = "assistant/chunk",
                data = JsonObject.of(
                    "chunk" to JsonObject.of(
                        "type" to JsonString("reasoning-delta"),
                        "delta" to JsonString("Check code"),
                    ),
                ),
            ),
        )
        store.applyEvent(
            sid,
            OfficialSessionEvent(
                seq = 3,
                type = "assistant/chunk",
                data = JsonObject.of(
                    "chunk" to JsonObject.of(
                        "type" to JsonString("text-delta"),
                        "delta" to JsonString("Half "),
                    ),
                ),
            ),
        )
        store.applyEvent(
            sid,
            OfficialSessionEvent(
                seq = 4,
                type = "assistant/message",
                data = JsonObject.of(
                    "message" to JsonObject.of(
                        "content" to JsonArray(
                            listOf(
                                JsonObject.of("type" to JsonString("thinking"), "thinking" to JsonString("Check code base")),
                                JsonObject.of("type" to JsonString("text"), "text" to JsonString("Done **cleanly**.")),
                            ),
                        ),
                    ),
                ),
            ),
        )
        store.applyEvent(
            sid,
            OfficialSessionEvent(
                seq = 5,
                type = "tool/call",
                data = JsonObject.of(
                    "callId" to JsonString("call-1"),
                    "name" to JsonString("read_file"),
                    "arguments" to JsonObject.of("path" to JsonString("README.md")),
                ),
            ),
        )
        store.applyEvent(
            sid,
            OfficialSessionEvent(
                seq = 6,
                type = "tool/result",
                data = JsonObject.of(
                    "message" to JsonObject.of(
                        "callId" to JsonString("call-1"),
                        "content" to JsonArray(listOf(JsonObject.of("type" to JsonString("text"), "text" to JsonString("OK")))),
                        "isError" to JsonBool(false),
                    ),
                ),
            ),
        )
        store.applyEvent(
            sid,
            OfficialSessionEvent(
                seq = 7,
                type = "turn/end",
                data = JsonObject.of("reason" to JsonObject.of("kind" to JsonString("aborted"))),
            ),
        )

        val items = store.itemsForSession(sid)
        assertEquals(4, items.size)
        val user = items[0] as UserMessageItem
        assertFalse(user.isOptimistic)
        assertEquals(1L, user.seq)

        val assistant = items[1] as AssistantTurnItem
        assertTrue(assistant.isFinalized)
        assertEquals("Check code base", assistant.thinkingText)
        assertEquals("Done **cleanly**.", assistant.markdownText)
        assertFalse(assistant.isThinkingExpanded)
        store.toggleThinkingExpanded(sid, assistant.stableId)
        assertTrue((store.itemsForSession(sid)[1] as AssistantTurnItem).isThinkingExpanded)

        val tool = items[2] as ToolExecutionItem
        assertEquals(ToolExecutionStatus.COMPLETED, tool.status)
        assertEquals("OK", tool.outputText)
        store.toggleToolExpanded(sid, tool.stableId)
        assertTrue((store.itemsForSession(sid)[2] as ToolExecutionItem).isExpanded)

        val notice = items[3] as SystemNoticeItem
        assertTrue(notice.text.contains("stopped", ignoreCase = true))

        assertTrue(store.streamSummaryText(sid).contains("Done **cleanly**."))
        val md = store.exportAsMarkdown(sid, "Unit Session")
        assertTrue(md.contains("# DSH Session: Unit Session"))
        assertTrue(md.contains("<summary>Thinking</summary>"))
        assertTrue(md.contains("### Tool `read_file`"))

        store.clearSession(sid)
        assertTrue(store.itemsForSession(sid).isEmpty())
        assertEquals("", store.streamSummaryText(sid))
    }

    @Test
    fun parsesMarkdownBlocksAndUnclosedStreamingFence() {
        val md = "Intro line\n```kotlin\nval x = 1\n```\nTail"
        val blocks = ChatMarkdownFormatter.parseBlocks(md)
        assertEquals(3, blocks.size)
        assertTrue(blocks[0] is MarkdownBlock.ParagraphLines)
        val code = blocks[1] as MarkdownBlock.CodeFence
        assertEquals("kotlin", code.language)
        assertEquals("val x = 1", code.code)

        val streamingMd = "```json\n{\"partial\": true"
        val streamingBlocks = ChatMarkdownFormatter.parseBlocks(streamingMd)
        assertEquals(1, streamingBlocks.size)
        val unclosed = streamingBlocks[0] as MarkdownBlock.CodeFence
        assertEquals("json", unclosed.language)
        assertEquals("{\"partial\": true", unclosed.code)
    }

    @Test
    fun qrImageDecoderDecodesNormalInvertedAndPaddedYPlanes() {
        val payload = """{"version":1,"hostPublicKey":"abc","lanUrl":"http://127.0.0.1:9999"}"""
        val size = 256
        val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, size, size)

        val tightLightBg = ByteArray(size * size)
        val rowStride = size + 32
        val paddedDarkMode = ByteArray(rowStride * size) { 0x18.toByte() }
        for (y in 0 until size) {
            for (x in 0 until size) {
                val darkModule = matrix.get(x, y)
                tightLightBg[y * size + x] = if (darkModule) 0x10.toByte() else 0xF0.toByte()
                // Simulate white modules on dark background with Qualcomm stride padding.
                paddedDarkMode[y * rowStride + x] = if (darkModule) 0xF0.toByte() else 0x10.toByte()
            }
        }

        assertEquals(payload, QrImageDecoder.decodeYPlane(tightLightBg, size, size))
        val decodedInverted = QrImageDecoder.decodeYPlane(
            yBytes = paddedDarkMode,
            width = size,
            height = size,
            rowStride = rowStride,
            pixelStride = 1,
        )
        assertNotNull(decodedInverted)
        assertEquals(payload, decodedInverted)
    }
}
