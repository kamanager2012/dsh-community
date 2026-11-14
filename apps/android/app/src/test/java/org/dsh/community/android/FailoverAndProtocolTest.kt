package org.dsh.community.android

import org.dsh.community.android.protocol.InboundHostFrame
import org.dsh.community.android.protocol.JsonArray
import org.dsh.community.android.protocol.JsonBool
import org.dsh.community.android.protocol.JsonNumber
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.JsonString
import org.dsh.community.android.protocol.RemoteFrameCodec
import org.dsh.community.android.protocol.RemoteProtocol
import org.dsh.community.android.service.BackoffPolicy
import org.dsh.community.android.service.RemoteSessionService
import org.dsh.community.android.transport.AndroidWebRtcPeerEngine
import org.dsh.community.android.transport.DataChannelChunkCodec
import org.dsh.community.android.transport.PeerRevokedException
import org.dsh.community.android.transport.TransportUnavailableException
import org.dsh.community.android.transport.WebRtcCandidateFilter
import org.dsh.community.android.transport.WebRtcIceTransportPolicy
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class FailoverAndProtocolTest {
    @Test
    fun dataChannelChunkerRoundTripsLargeFramesAndEnforcesSizeLimit() {
        val small = byteArrayOf(1, 2, 3, 4)
        val encodedSmall = DataChannelChunkCodec.encode(small, chunkSize = 1024)
        assertEquals(1, encodedSmall.size)
        assertEquals(DataChannelChunkCodec.CHUNK_SINGLE, encodedSmall[0][0])

        val reassembler = DataChannelChunkCodec.Reassembler(maxFrameBytes = 65_536)
        assertArrayEquals(small, reassembler.push(encodedSmall[0]))

        val multi = ByteArray(40_000) { idx -> (idx % 251).toByte() }
        val chunks = DataChannelChunkCodec.encode(multi, chunkSize = 16_384)
        assertEquals(3, chunks.size)
        assertEquals(DataChannelChunkCodec.CHUNK_MORE, chunks[0][0])
        assertEquals(DataChannelChunkCodec.CHUNK_MORE, chunks[1][0])
        assertEquals(DataChannelChunkCodec.CHUNK_FINAL, chunks[2][0])

        assertNull(reassembler.push(chunks[0]))
        assertNull(reassembler.push(chunks[1]))
        assertArrayEquals(multi, reassembler.push(chunks[2]))

        // Exceeding maxFrameBytes must fail closed
        val bounded = DataChannelChunkCodec.Reassembler(maxFrameBytes = 1024)
        assertThrows(IOException::class.java) {
            val oversized = DataChannelChunkCodec.encode(ByteArray(2048), chunkSize = 4096)
            bounded.push(oversized[0])
        }
    }

    @Test
    fun batterySafeBackoffBoundsReconnectDelay() {
        assertEquals(1_000L, BackoffPolicy.nextDelayMs(0))
        assertEquals(2_000L, BackoffPolicy.nextDelayMs(1))
        assertEquals(4_000L, BackoffPolicy.nextDelayMs(2))
        assertTrue(BackoffPolicy.nextDelayMs(9) <= 30_000L)
    }

    @Test
    fun multiTierReconnectScheduleContinuesBeyondAttemptFive() {
        assertEquals(1_000L, BackoffPolicy.nextReconnectDelayMs(0))
        assertEquals(1_000L, BackoffPolicy.nextReconnectDelayMs(1))
        assertEquals(2_000L, BackoffPolicy.nextReconnectDelayMs(2))
        assertEquals(4_000L, BackoffPolicy.nextReconnectDelayMs(3))
        assertEquals(8_000L, BackoffPolicy.nextReconnectDelayMs(4))
        assertEquals(16_000L, BackoffPolicy.nextReconnectDelayMs(5))
        assertEquals(30_000L, BackoffPolicy.nextReconnectDelayMs(6))
        assertEquals(30_000L, BackoffPolicy.nextReconnectDelayMs(12))
        assertEquals(60_000L, BackoffPolicy.nextReconnectDelayMs(13))
        assertEquals(60_000L, BackoffPolicy.nextReconnectDelayMs(30))
        assertEquals(120_000L, BackoffPolicy.nextReconnectDelayMs(31))
        assertEquals(120_000L, BackoffPolicy.nextReconnectDelayMs(100))
    }

    @Test
    fun epochRegressionMatcherWalksCauseChainStrictly() {
        val direct = SecurityException("host connectionEpoch regression/replay detected: new=1 prev=4")
        val wrapped = IOException("failover failed", direct)
        val aggregated = IOException(
            "all remote transports failed [lan: connect timed out; relay: host connectionEpoch regression/replay detected: new=1 prev=4]",
        )
        assertTrue(RemoteSessionService.isEpochRegressionError(direct))
        assertTrue(RemoteSessionService.isEpochRegressionError(wrapped))
        assertTrue(RemoteSessionService.isEpochRegressionError(aggregated))

        assertFalse(
            RemoteSessionService.isEpochRegressionError(
                SecurityException("expected handshake.complete after Noise Msg2"),
            ),
        )
        assertFalse(RemoteSessionService.isEpochRegressionError(IOException("all remote transports failed [lan: timeout]")))
        assertFalse(RemoteSessionService.isEpochRegressionError(PeerRevokedException("revoked")))
        assertFalse(RemoteSessionService.isEpochRegressionError(null))

        val cycA = RuntimeException("a")
        val cycB = RuntimeException("b", cycA)
        cycA.initCause(cycB)
        assertFalse(RemoteSessionService.isEpochRegressionError(cycA))
    }

    @Test
    fun decodesPeerRevokedAndStreamResetControlFrames() {
        val reset = RemoteFrameCodec.decodeHostFrame(
            """{"type":"stream.reset","sessionId":"s-1","reason":"history-compacted"}""",
        )
        assertTrue(reset is InboundHostFrame.StreamReset)
        reset as InboundHostFrame.StreamReset
        assertEquals("s-1", reset.sessionId)
        assertEquals("history-compacted", reset.reason)

        val revoked = RemoteFrameCodec.decodeHostFrame(
            """{"type":"peer.revoked","reason":"admin revoked tablet"}""",
        )
        assertTrue(revoked is InboundHostFrame.PeerRevoked)
        revoked as InboundHostFrame.PeerRevoked
        assertEquals("admin revoked tablet", revoked.reason)

        val ex = PeerRevokedException(revoked.reason)
        assertTrue(ex.message!!.contains("admin revoked tablet"))
    }

    @Test
    fun androidWebRtcConfigValidatorsFailClosedWithoutThirdPartyFallbacks() {
        assertEquals(emptyList<String>(), AndroidWebRtcPeerEngine.validateSelfOwnedStunUrls(emptyList()))
        assertEquals(
            listOf("stun:10.0.2.2:3478"),
            AndroidWebRtcPeerEngine.validateSelfOwnedStunUrls(listOf(" stun:10.0.2.2:3478 ")),
        )
        assertThrows(TransportUnavailableException::class.java) {
            AndroidWebRtcPeerEngine.validateSelfOwnedStunUrls(listOf("turn:turn.example.org:3478"))
        }
        assertThrows(TransportUnavailableException::class.java) {
            AndroidWebRtcPeerEngine.validateSignalingUrl("http://127.0.0.1:8788")
        }
        assertThrows(TransportUnavailableException::class.java) {
            AndroidWebRtcPeerEngine.validateRoomId("   ")
        }
    }

    @Test
    fun webRtcCandidateFilterEnforcesDirectOnlyRelayBlocking() {
        val relayCand = "candidate:1 1 UDP 123 192.0.2.1 40000 typ relay raddr 0.0.0.0 rport 0"
        val hostCand = "candidate:2 1 UDP 456 192.168.1.5 50000 typ host"
        val srflxCand = "candidate:3 1 UDP 789 203.0.113.9 50001 typ srflx raddr 192.168.1.5 rport 50001"

        assertTrue(WebRtcCandidateFilter.isRelayCandidate(relayCand))
        assertFalse(WebRtcCandidateFilter.isRelayCandidate(hostCand))
        assertFalse(WebRtcCandidateFilter.isRelayCandidate(srflxCand))

        assertTrue(WebRtcCandidateFilter.shouldAllowCandidate(relayCand, WebRtcIceTransportPolicy.ALL))
        assertFalse(WebRtcCandidateFilter.shouldAllowCandidate(relayCand, WebRtcIceTransportPolicy.DIRECT_ONLY))
        assertTrue(WebRtcCandidateFilter.shouldAllowCandidate(hostCand, WebRtcIceTransportPolicy.DIRECT_ONLY))
        assertTrue(WebRtcCandidateFilter.shouldAllowCandidate(srflxCand, WebRtcIceTransportPolicy.DIRECT_ONLY))
    }

    @Test
    fun decodesPriority2RpcResultsAndUploadResponses() {
        val history = RemoteFrameCodec.parseSessionHistoryResult(
            JsonObject.of(
                "sessionId" to JsonString("s-hist"),
                "hasMore" to JsonBool(true),
                "oldestSeq" to JsonNumber(11),
                "latestSeq" to JsonNumber(25),
                "source" to JsonString("disk"),
                "events" to JsonArray(
                    listOf(
                        JsonObject.of(
                            "seq" to JsonNumber(11),
                            "type" to JsonString("user/message"),
                            "data" to JsonObject.of("text" to JsonString("hello")),
                        ),
                    ),
                ),
            ),
        )
        assertEquals("s-hist", history.sessionId)
        assertTrue(history.hasMore)
        assertEquals(11L, history.oldestSeq)
        assertEquals(25L, history.latestSeq)
        assertEquals("disk", history.source)
        assertEquals(1, history.events.size)

        val search = RemoteFrameCodec.parseSessionSearchResult(
            JsonObject.of(
                "query" to JsonString("oauth"),
                "hasMore" to JsonBool(false),
                "hits" to JsonArray(
                    listOf(
                        JsonObject.of(
                            "sessionId" to JsonString("s-1"),
                            "title" to JsonString("Auth Fixes"),
                            "seq" to JsonNumber(7),
                            "type" to JsonString("assistant/message"),
                            "snippet" to JsonString("rotated oauth token"),
                            "updatedAt" to JsonString("2026-11-14T00:00:00Z"),
                        ),
                    ),
                ),
            ),
        )
        assertEquals("oauth", search.query)
        assertEquals(1, search.hits.size)
        assertEquals("Auth Fixes", search.hits[0].title)
        assertEquals(7L, search.hits[0].seq)

        val commands = RemoteFrameCodec.parseCommandList(
            JsonObject.of(
                "commands" to JsonArray(
                    listOf(
                        JsonObject.of(
                            "name" to JsonString("/review"),
                            "description" to JsonString("Review diff"),
                            "inputHint" to JsonString("[scope]"),
                            "acceptsAttachments" to JsonBool(true),
                        ),
                    ),
                ),
            ),
        )
        assertEquals(1, commands.size)
        assertEquals("/review", commands[0].name)
        assertTrue(commands[0].acceptsAttachments)

        val cmdExec = RemoteFrameCodec.parseCommandExecuteResult(
            JsonObject.of(
                "ok" to JsonBool(true),
                "commandId" to JsonString("cmd-1"),
                "output" to JsonString("dispatched"),
            ),
        )
        assertTrue(cmdExec.ok)
        assertEquals("cmd-1", cmdExec.commandId)
        assertEquals("dispatched", cmdExec.output)

        val skills = RemoteFrameCodec.parseSkillList(
            JsonObject.of(
                "skills" to JsonArray(
                    listOf(
                        JsonObject.of(
                            "name" to JsonString("refactor"),
                            "description" to JsonString("Clean helper"),
                            "source" to JsonString("repo"),
                        ),
                    ),
                ),
            ),
        )
        assertEquals(1, skills.size)
        assertEquals("refactor", skills[0].name)

        val uplOpen = RemoteFrameCodec.parseWorkspaceUploadOpenResult(
            JsonObject.of(
                "uploadId" to JsonString("upl-1"),
                "sessionId" to JsonString("s-1"),
                "chunkBytes" to JsonNumber(32768),
                "maxBytes" to JsonNumber(1048576),
                "relativePath" to JsonString(".dsh-uploads/spec.md"),
            ),
        )
        assertEquals("upl-1", uplOpen.uploadId)
        assertEquals(32768, uplOpen.chunkBytes)

        val uplChunk = RemoteFrameCodec.parseWorkspaceUploadChunkResult(
            JsonObject.of(
                "uploadId" to JsonString("upl-1"),
                "receivedBytes" to JsonNumber(32768),
                "nextOffset" to JsonNumber(32768),
            ),
        )
        assertEquals(32768, uplChunk.receivedBytes)

        val uplCommit = RemoteFrameCodec.parseWorkspaceUploadCommitResult(
            JsonObject.of(
                "uploadId" to JsonString("upl-1"),
                "sessionId" to JsonString("s-1"),
                "relativePath" to JsonString(".dsh-uploads/spec.md"),
                "bytesWritten" to JsonNumber(40000),
                "sha256" to JsonString("a".repeat(64)),
            ),
        )
        assertEquals(40000, uplCommit.bytesWritten)

        val uplAbort = RemoteFrameCodec.parseWorkspaceUploadAbortResult(
            JsonObject.of(
                "uploadId" to JsonString("upl-1"),
                "aborted" to JsonBool(true),
            ),
        )
        assertTrue(uplAbort.aborted)
        assertEquals("session.history", RemoteProtocol.METHOD_SESSION_HISTORY)
        assertEquals("workspace.upload.commit", RemoteProtocol.METHOD_WORKSPACE_UPLOAD_COMMIT)
    }
}
