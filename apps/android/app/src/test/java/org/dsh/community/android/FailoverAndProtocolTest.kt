package org.dsh.community.android

import org.dsh.community.android.protocol.InboundHostFrame
import org.dsh.community.android.protocol.RemoteFrameCodec
import org.dsh.community.android.service.BackoffPolicy
import org.dsh.community.android.transport.DataChannelChunkCodec
import org.dsh.community.android.transport.PeerRevokedException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
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
}
