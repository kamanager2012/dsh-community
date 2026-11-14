package org.dsh.community.android

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import org.dsh.community.android.protocol.JsonArray
import org.dsh.community.android.protocol.JsonBool
import org.dsh.community.android.protocol.JsonNumber
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.JsonString
import org.dsh.community.android.protocol.OfficialSessionEvent
import org.dsh.community.android.protocol.PromptImageAttachment
import org.dsh.community.android.protocol.RemoteFrameCodec
import org.dsh.community.android.protocol.RemoteProtocol
import org.dsh.community.android.qr.QrImageDecoder
import org.dsh.community.android.ui.AssistantTurnItem
import org.dsh.community.android.ui.ChatMarkdownFormatter
import org.dsh.community.android.ui.ChatTimelineStore
import org.dsh.community.android.ui.InlineSpanToken
import org.dsh.community.android.ui.MarkdownBlock
import org.dsh.community.android.ui.ParsedSlashCommand
import org.dsh.community.android.ui.PromptImageHelper
import org.dsh.community.android.ui.SlashCommandHelper
import org.dsh.community.android.ui.SystemNoticeItem
import org.dsh.community.android.ui.ToolExecutionItem
import org.dsh.community.android.ui.ToolExecutionStatus
import org.dsh.community.android.ui.UserMessageItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatAndQrUnitTest {
    @Test
    fun parsesExtendedRemoteProtocolPayloads() {
        assertEquals("session.create", RemoteProtocol.METHOD_SESSION_CREATE)
        assertEquals("turn.abort", RemoteProtocol.METHOD_TURN_ABORT)
        assertEquals("model.list", RemoteProtocol.METHOD_MODEL_LIST)
        assertEquals("model.select", RemoteProtocol.METHOD_MODEL_SELECT)

        val flatSessionObj = JsonObject.of(
            "id" to JsonString("sess-new-42"),
            "title" to JsonString("Mobile Chat"),
        )
        val parsedRef = RemoteFrameCodec.parseSessionRef(flatSessionObj)
        assertEquals("sess-new-42", parsedRef.id)
        assertEquals("Mobile Chat", parsedRef.title)

        val wrappedSessionObj = JsonObject.of("session" to flatSessionObj)
        assertEquals(parsedRef, RemoteFrameCodec.parseSessionRef(wrappedSessionObj))

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

    @Test
    fun wave2ProtocolQrRgbPixelsSlashMarkdownImagesAndTimelineWork() {
        assertEquals("session.rename", RemoteProtocol.METHOD_SESSION_RENAME)

        val enrichedCatalog = RemoteFrameCodec.parseModelCatalog(
            JsonObject.of(
                "current" to JsonObject.of(
                    "provider" to JsonString("deepseek"),
                    "model" to JsonString("deepseek-reasoner"),
                    "reasoningEffort" to JsonString("high"),
                ),
                "models" to JsonArray(
                    listOf(
                        JsonObject.of(
                            "provider" to JsonString("deepseek"),
                            "model" to JsonString("deepseek-reasoner"),
                            "name" to JsonString("DeepSeek Reasoner"),
                            "supportsImageInput" to JsonBool(true),
                            "defaultReasoningEffort" to JsonString("medium"),
                            "contextWindow" to JsonNumber(131072),
                            "reasoningEfforts" to JsonArray(
                                listOf(
                                    JsonObject.of("value" to JsonString("low"), "label" to JsonString("Low")),
                                    JsonObject.of("value" to JsonString("high"), "label" to JsonString("High")),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        )
        val modelOpt = enrichedCatalog.models.single()
        assertTrue(modelOpt.supportsImageInput)
        assertEquals("medium", modelOpt.defaultReasoningEffort)
        assertEquals(131072, modelOpt.contextWindow)
        assertEquals(listOf("low", "high"), modelOpt.reasoningEfforts.map { it.value })

        val att = PromptImageHelper.buildAttachment("image/jpeg", byteArrayOf(1, 2, 3, 4), "shot.jpg")
        val attJson = att.toJson()
        assertEquals("image", attJson.str("type"))
        assertEquals("image/jpeg", attJson.str("mediaType"))
        assertEquals("AQIDBA==", attJson.str("dataBase64"))
        assertEquals("shot.jpg", attJson.str("name"))

        assertEquals(960 to 480, PromptImageHelper.computeScaledDimensions(1920, 960, 960))
        assertThrows(IllegalArgumentException::class.java) {
            PromptImageHelper.buildAttachment("image/jpeg", ByteArray(PromptImageHelper.MAX_TOTAL_IMAGE_BYTES + 1))
        }

        // Gallery QR RGB pixel decoder (normal + dark-mode inverted)
        val payload = """{"version":1,"hostPublicKey":"rgbkey","lanUrl":"http://127.0.0.1:9191"}"""
        val size = 240
        val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, size, size)
        val normalPixels = IntArray(size * size)
        val invertedPixels = IntArray(size * size)
        for (y in 0 until size) {
            for (x in 0 until size) {
                val dark = matrix.get(x, y)
                normalPixels[y * size + x] = if (dark) 0xFF101010.toInt() else 0xFFF5F5F5.toInt()
                invertedPixels[y * size + x] = if (dark) 0xFFF5F5F5.toInt() else 0xFF101010.toInt()
            }
        }
        assertEquals(payload, QrImageDecoder.decodeRgbPixels(normalPixels, size, size))
        assertEquals(payload, QrImageDecoder.decodeRgbPixels(invertedPixels, size, size))

        // SlashCommandHelper
        assertEquals(ParsedSlashCommand.NewSession("Bug Hunt"), SlashCommandHelper.parse("/new Bug Hunt"))
        assertEquals(ParsedSlashCommand.RenameSession("New Name"), SlashCommandHelper.parse("/rename New Name"))
        assertTrue(SlashCommandHelper.parse("/rename") is ParsedSlashCommand.Error)
        assertEquals(ParsedSlashCommand.StopTurn, SlashCommandHelper.parse("/stop"))
        assertEquals(ParsedSlashCommand.SteerPrompt("focus tests"), SlashCommandHelper.parse("/steer focus tests"))
        assertEquals(ParsedSlashCommand.OpenModels, SlashCommandHelper.parse("/model"))
        assertEquals(ParsedSlashCommand.OpenSessions, SlashCommandHelper.parse("/sessions"))
        assertEquals(ParsedSlashCommand.ExportChat, SlashCommandHelper.parse("/export"))
        assertEquals(ParsedSlashCommand.Help, SlashCommandHelper.parse("/help"))
        assertNull(SlashCommandHelper.parse("/custom-skill arg"))
        assertEquals(listOf("/rename"), SlashCommandHelper.matchSuggestions("/re").map { it.name })
        assertTrue(SlashCommandHelper.formatHelpText().contains("/rename <title>"))

        // Markdown helpers: strike, links (only http/https), ordered lists, HR, code block extract
        val tokens = ChatMarkdownFormatter.tokenizeInline(
            "See **bold** ~~old~~ [DSH](https://deepseek.com) and [xss](javascript:alert(1))",
        )
        assertTrue(tokens.contains(InlineSpanToken.Bold("bold")))
        assertTrue(tokens.contains(InlineSpanToken.Strike("old")))
        assertTrue(tokens.contains(InlineSpanToken.Link("DSH", "https://deepseek.com")))
        assertFalse(tokens.any { it is InlineSpanToken.Link && it.url.startsWith("javascript:") })
        assertTrue(ChatMarkdownFormatter.isHorizontalRule("---"))
        assertFalse(ChatMarkdownFormatter.isHorizontalRule("--"))
        assertEquals("12." to "Run tests", ChatMarkdownFormatter.parseOrderedListPrefix("12. Run tests"))
        assertEquals("val k = 7", ChatMarkdownFormatter.extractFirstCodeBlock("Text\n```kotlin\nval k = 7\n```\nEnd"))

        // ChatTimelineStore: image attachments + interrupted assistant turn
        val store = ChatTimelineStore()
        val sid = "sess-wave2"
        store.addOptimisticUserPrompt(sid, "", attachmentNames = listOf("shot.jpg"))
        store.applyEvent(
            sid,
            OfficialSessionEvent(
                seq = 1,
                type = "user/message",
                data = JsonObject.of(
                    "message" to JsonObject.of(
                        "content" to JsonArray(
                            listOf(
                                JsonObject.of(
                                    "type" to JsonString("image"),
                                    "attachment" to JsonObject.of("name" to JsonString("shot.jpg")),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        )
        store.applyEvent(
            sid,
            OfficialSessionEvent(
                seq = 2,
                type = "assistant/message",
                data = JsonObject.of(
                    "message" to JsonObject.of(
                        "stopReason" to JsonString("aborted"),
                        "content" to JsonArray(
                            listOf(JsonObject.of("type" to JsonString("text"), "text" to JsonString("Partial reply"))),
                        ),
                    ),
                ),
            ),
        )
        val items = store.itemsForSession(sid)
        assertEquals(2, items.size)
        val userMsg = items[0] as UserMessageItem
        assertFalse(userMsg.isOptimistic)
        assertEquals(listOf("shot.jpg"), userMsg.attachmentLabels)
        val assistantMsg = items[1] as AssistantTurnItem
        assertTrue(assistantMsg.interrupted)
        val mdExport = store.exportAsMarkdown(sid, "Wave2")
        assertTrue(mdExport.contains("shot.jpg"))
        assertTrue(mdExport.contains("_Interrupted_"))
    }

    @Test
    fun chatTimelineStoreBoundsTrackedSessionsItemsAndPrependsHistory() {
        val store = ChatTimelineStore()
        for (i in 1..20) {
            val sessionId = "s-${i.toString().padStart(2, '0')}"
            store.applyEvent(
                sessionId,
                OfficialSessionEvent(
                    seq = 1,
                    type = "user/message",
                    data = JsonObject.of("text" to JsonString("msg $sessionId")),
                ),
            )
        }
        assertEquals(ChatTimelineStore.MAX_TRACKED_SESSIONS, store.trackedSessionCount())
        assertTrue(store.itemsForSession("s-01").isEmpty())
        assertEquals(1, store.itemsForSession("s-05").size)

        // Touch s-05 via applyEvent so it becomes most recently used before adding s-21, evicting s-06.
        store.applyEvent(
            "s-05",
            OfficialSessionEvent(
                seq = 2,
                type = "user/message",
                data = JsonObject.of("text" to JsonString("keep s-05")),
            ),
        )
        store.applyEvent(
            "s-21",
            OfficialSessionEvent(
                seq = 1,
                type = "user/message",
                data = JsonObject.of("text" to JsonString("new s-21")),
            ),
        )
        assertEquals(ChatTimelineStore.MAX_TRACKED_SESSIONS, store.trackedSessionCount())
        assertEquals(2, store.itemsForSession("s-05").size)
        assertTrue(store.itemsForSession("s-06").isEmpty())

        // Bounding MAX_ITEMS_PER_SESSION
        val crowded = "s-crowded"
        for (seq in 1..520) {
            store.applyEvent(
                crowded,
                OfficialSessionEvent(
                    seq = seq.toLong(),
                    type = "user/message",
                    data = JsonObject.of("text" to JsonString("line $seq")),
                ),
            )
        }
        assertEquals(ChatTimelineStore.MAX_ITEMS_PER_SESSION, store.itemsForSession(crowded).size)

        // prependHistory ordering + dedupe
        val paged = "s-paged"
        store.applyEvent(
            paged,
            OfficialSessionEvent(
                seq = 3,
                type = "user/message",
                data = JsonObject.of("text" to JsonString("newer prompt")),
            ),
        )
        assertEquals(3L, store.oldestLoadedSeq(paged))
        val addedCount = store.prependHistory(
            paged,
            listOf(
                OfficialSessionEvent(
                    seq = 1,
                    type = "user/message",
                    data = JsonObject.of("text" to JsonString("older prompt")),
                ),
                OfficialSessionEvent(
                    seq = 3,
                    type = "user/message",
                    data = JsonObject.of("text" to JsonString("duplicate seq 3")),
                ),
            ),
        )
        assertEquals(1, addedCount)
        assertEquals(1L, store.oldestLoadedSeq(paged))
        val orderedTexts = store.itemsForSession(paged).map { (it as UserMessageItem).text }
        assertEquals(listOf("older prompt", "newer prompt"), orderedTexts)
    }

    @Test
    fun slashCommandHelperParsesPriority2CommandsAndPassesUnknownToHost() {
        assertEquals(
            ParsedSlashCommand.ForkSession("Feature Branch"),
            SlashCommandHelper.parse("/fork Feature Branch"),
        )
        assertEquals(
            ParsedSlashCommand.ForkSession(null),
            SlashCommandHelper.parse("/fork   "),
        )
        assertEquals(ParsedSlashCommand.LoadHistory, SlashCommandHelper.parse("/history"))
        assertEquals(
            ParsedSlashCommand.SearchSessions("auth token"),
            SlashCommandHelper.parse("/search auth token"),
        )
        assertTrue(SlashCommandHelper.parse("/search   ") is ParsedSlashCommand.Error)
        assertEquals(ParsedSlashCommand.ListCommands, SlashCommandHelper.parse("/commands"))
        assertEquals(ParsedSlashCommand.ListSkills, SlashCommandHelper.parse("/skills"))
        assertNull(SlashCommandHelper.parse("/custom-host-skill arg1"))
    }

    @Test
    fun markOptimisticUserFailedClearsSendingAndRecordsError() {
        val store = ChatTimelineStore()
        val optimisticId = store.addOptimisticUserPrompt("s-fail", "hello host", listOf("shot.jpg"))
        assertTrue(optimisticId.isNotEmpty())
        val pendingItem = store.itemsForSession("s-fail").single() as UserMessageItem
        assertTrue(pendingItem.isOptimistic)
        assertNull(pendingItem.sendError)

        val updated = store.markOptimisticUserFailed("s-fail", optimisticId, "socket timeout\nretry")
        assertTrue(updated)
        val failedItem = store.itemsForSession("s-fail").single() as UserMessageItem
        assertFalse(failedItem.isOptimistic)
        assertEquals("socket timeout retry", failedItem.sendError)
        assertEquals(listOf("shot.jpg"), failedItem.attachmentLabels)
        assertFalse(store.markOptimisticUserFailed("s-fail", optimisticId, "twice"))
    }
}
