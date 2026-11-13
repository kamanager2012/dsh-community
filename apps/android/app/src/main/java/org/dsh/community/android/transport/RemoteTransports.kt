package org.dsh.community.android.transport

import org.dsh.community.android.protocol.JsonCodec
import org.dsh.community.android.protocol.JsonNumber
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.JsonString
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

enum class TransportKind(val wireName: String) {
    LAN("lan"),
    WEBRTC("webrtc"),
    RELAY("relay"),
}

interface RemoteTransportCallbacks {
    fun onBinaryFrame(frame: ByteArray)
    fun onClosed(reason: String)
    fun onError(error: Throwable)
}

interface RemoteClientTransport {
    val kind: TransportKind
    fun connect(callbacks: RemoteTransportCallbacks)
    fun sendBinary(payload: ByteArray)
    fun isOpen(): Boolean
    fun close(reason: String = "client close")
}

class TransportUnavailableException(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : IOException("$code: $message", cause)

/**
 * Direct binary WebSocket carrier over local LAN (`ws://` or `wss://`) matching `HostLanCarrier`.
 */
class LanWebSocketTransport(
    private val endpointUrl: String,
    private val connectTimeoutMs: Int = 3_000,
    private val maxFrameBytes: Int = 65_536,
) : RemoteClientTransport {
    override val kind: TransportKind = TransportKind.LAN

    @Volatile
    private var ws: BinaryWebSocketClient? = null

    override fun connect(callbacks: RemoteTransportCallbacks) {
        val client = BinaryWebSocketClient(
            url = endpointUrl,
            connectTimeoutMs = connectTimeoutMs,
            maxFrameBytes = maxFrameBytes,
            binaryOnly = true,
        )
        ws = client
        client.connectBlocking(
            object : BinaryWebSocketClient.Listener {
                override fun onOpen() = Unit
                override fun onBinaryMessage(payload: ByteArray) = callbacks.onBinaryFrame(payload)
                override fun onClose(code: Int, reason: String) =
                    callbacks.onClosed("LAN closed ($code: $reason)")
                override fun onError(error: Throwable) = callbacks.onError(error)
            },
        )
    }

    override fun sendBinary(payload: ByteArray) {
        val client = ws ?: throw IOException("LAN transport not connected")
        client.sendBinary(payload)
    }

    override fun isOpen(): Boolean = ws?.isOpen() == true

    override fun close(reason: String) {
        ws?.close(1000, reason)
        ws = null
    }
}

/**
 * Community-owned Blind WebSocket Relay carrier matching `RelayClientCarrier` & `BlindRelayServer`.
 * Performs JSON binary control handshake (`relay.client.join` -> `relay.client.joined`), then
 * transparently carries opaque Noise IK binary ciphertext frames without exposing plaintext.
 */
class RelayWebSocketTransport(
    private val relayUrl: String,
    private val roomId: String,
    private val clientToken: String? = null,
    private val connectTimeoutMs: Int = 5_000,
    private val maxFrameBytes: Int = 65_536,
) : RemoteClientTransport {
    override val kind: TransportKind = TransportKind.RELAY

    @Volatile
    private var ws: BinaryWebSocketClient? = null

    @Volatile
    private var joined = false

    @Volatile
    var connIdHex: String? = null
        private set

    override fun connect(callbacks: RemoteTransportCallbacks) {
        val joinLatch = CountDownLatch(1)
        val earlyError = AtomicReference<Throwable?>(null)
        val isJoined = AtomicBoolean(false)

        val client = BinaryWebSocketClient(
            url = relayUrl,
            connectTimeoutMs = connectTimeoutMs,
            maxFrameBytes = maxFrameBytes,
            binaryOnly = true,
        )
        ws = client

        client.connectBlocking(
            object : BinaryWebSocketClient.Listener {
                override fun onOpen() {
                    try {
                        val joinJson = JsonObject.of(
                            "v" to JsonNumber(1),
                            "type" to JsonString("relay.client.join"),
                            "roomId" to JsonString(roomId),
                            "clientToken" to clientToken?.let { JsonString(it) },
                        ).stringify()
                        client.sendBinary(joinJson.toByteArray(StandardCharsets.UTF_8))
                    } catch (t: Throwable) {
                        earlyError.compareAndSet(null, t)
                        joinLatch.countDown()
                    }
                }

                override fun onBinaryMessage(payload: ByteArray) {
                    if (!isJoined.get()) {
                        try {
                            val msg = JsonCodec.parseObject(String(payload, StandardCharsets.UTF_8))
                            val type = msg.str("type")
                            if (type == "error") {
                                earlyError.compareAndSet(
                                    null,
                                    TransportUnavailableException(
                                        msg.str("code") ?: "RELAY_ERROR",
                                        msg.str("message") ?: "blind relay rejected join",
                                    ),
                                )
                                joinLatch.countDown()
                                return
                            }
                            if (type == "relay.client.joined" && msg.str("roomId") == roomId) {
                                connIdHex = msg.str("connIdHex")
                                isJoined.set(true)
                                joined = true
                                joinLatch.countDown()
                                return
                            }
                            earlyError.compareAndSet(
                                null,
                                TransportUnavailableException(
                                    "RELAY_PROTOCOL_ERROR",
                                    "unexpected relay frame during join: $type",
                                ),
                            )
                            joinLatch.countDown()
                        } catch (t: Throwable) {
                            earlyError.compareAndSet(null, t)
                            joinLatch.countDown()
                        }
                        return
                    }

                    callbacks.onBinaryFrame(payload)
                }

                override fun onClose(code: Int, reason: String) {
                    joined = false
                    if (!isJoined.get()) {
                        earlyError.compareAndSet(
                            null,
                            TransportUnavailableException("RELAY_CLOSED", "closed during join ($code: $reason)"),
                        )
                        joinLatch.countDown()
                    } else {
                        callbacks.onClosed("Relay closed ($code: $reason)")
                    }
                }

                override fun onError(error: Throwable) {
                    if (!isJoined.get()) {
                        earlyError.compareAndSet(null, error)
                        joinLatch.countDown()
                    } else {
                        callbacks.onError(error)
                    }
                }
            },
        )

        if (!joinLatch.await(connectTimeoutMs.toLong(), TimeUnit.MILLISECONDS)) {
            client.close(1000, "relay join timeout")
            throw TransportUnavailableException("RELAY_JOIN_TIMEOUT", "blind relay join timed out")
        }
        earlyError.get()?.let { err ->
            client.close(1000, "relay join failed")
            throw err
        }
    }

    override fun sendBinary(payload: ByteArray) {
        val client = ws ?: throw IOException("Relay transport not connected")
        if (!joined) throw IOException("Relay room join not completed")
        client.sendBinary(payload)
    }

    override fun isOpen(): Boolean = joined && ws?.isOpen() == true

    override fun close(reason: String) {
        joined = false
        ws?.close(1000, reason)
        ws = null
    }
}

/**
 * Exact wire-compatible DataChannel chunking codec matching `webrtc-transport.ts`
 * (`[0x00 single | 0x01 more | 0x02 final]`, 16 KiB chunks, 64 KiB max assembled frame).
 */
object DataChannelChunkCodec {
    const val CHUNK_SINGLE: Byte = 0x00
    const val CHUNK_MORE: Byte = 0x01
    const val CHUNK_FINAL: Byte = 0x02
    const val DEFAULT_CHUNK_BYTES = 16_384

    fun encode(payload: ByteArray, chunkSize: Int = DEFAULT_CHUNK_BYTES): List<ByteArray> {
        require(chunkSize > 1) { "chunkSize must exceed 1-byte header" }
        val dataPerChunk = chunkSize - 1
        if (payload.size <= dataPerChunk) {
            val single = ByteArray(1 + payload.size)
            single[0] = CHUNK_SINGLE
            System.arraycopy(payload, 0, single, 1, payload.size)
            return listOf(single)
        }
        val chunks = ArrayList<ByteArray>()
        var offset = 0
        while (offset < payload.size) {
            val remaining = payload.size - offset
            val take = minOf(dataPerChunk, remaining)
            val isLast = offset + take >= payload.size
            val chunk = ByteArray(1 + take)
            chunk[0] = if (isLast) CHUNK_FINAL else CHUNK_MORE
            System.arraycopy(payload, offset, chunk, 1, take)
            chunks.add(chunk)
            offset += take
        }
        return chunks
    }

    class Reassembler(private val maxFrameBytes: Int = 65_536) {
        private val buffer = java.io.ByteArrayOutputStream()
        private var inProgress = false

        fun push(chunk: ByteArray): ByteArray? {
            if (chunk.isEmpty()) throw IOException("empty DataChannel chunk")
            val marker = chunk[0]
            val bodyLen = chunk.size - 1
            return when (marker) {
                CHUNK_SINGLE -> {
                    if (inProgress) throw IOException("unexpected SINGLE chunk while reassembling frame")
                    if (bodyLen > maxFrameBytes) throw IOException("DataChannel frame exceeds $maxFrameBytes bytes")
                    chunk.copyOfRange(1, chunk.size)
                }
                CHUNK_MORE -> {
                    if (!inProgress) {
                        inProgress = true
                        buffer.reset()
                    }
                    if (buffer.size() + bodyLen > maxFrameBytes) {
                        buffer.reset()
                        inProgress = false
                        throw IOException("chunked DataChannel frame exceeds $maxFrameBytes bytes")
                    }
                    buffer.write(chunk, 1, bodyLen)
                    null
                }
                CHUNK_FINAL -> {
                    if (!inProgress) throw IOException("unexpected FINAL chunk without prior MORE chunk")
                    if (buffer.size() + bodyLen > maxFrameBytes) {
                        buffer.reset()
                        inProgress = false
                        throw IOException("chunked DataChannel frame exceeds $maxFrameBytes bytes")
                    }
                    buffer.write(chunk, 1, bodyLen)
                    val assembled = buffer.toByteArray()
                    buffer.reset()
                    inProgress = false
                    assembled
                }
                else -> throw IOException("unknown DataChannel chunk marker: $marker")
            }
        }
    }
}

/**
 * Pluggable WebRTC peer engine seam so R5 Android keeps the full signaling + DataChannel failover
 * contract and tests without shipping heavy unverified native `.so` runtime blobs before R6.
 */
interface WebRtcPeerEngine {
    fun openDataChannel(
        signalingUrl: String,
        roomId: String,
        stunUrls: List<String>,
        callbacks: RemoteTransportCallbacks,
    ): WebRtcPeerHandle
}

interface WebRtcPeerHandle {
    fun sendBinary(payload: ByteArray)
    fun isOpen(): Boolean
    fun close(reason: String)
}

object UnattachedWebRtcPeerEngine : WebRtcPeerEngine {
    override fun openDataChannel(
        signalingUrl: String,
        roomId: String,
        stunUrls: List<String>,
        callbacks: RemoteTransportCallbacks,
    ): WebRtcPeerHandle {
        throw TransportUnavailableException(
            "WEBRTC_UNAVAILABLE",
            "native Android WebRTC DataChannel peer engine not attached in thin R5 build; falling back to blind relay",
        )
    }
}

class WebRtcDataChannelTransport(
    private val signalingUrl: String,
    private val roomId: String,
    private val stunUrls: List<String>,
    private val peerEngine: WebRtcPeerEngine = UnattachedWebRtcPeerEngine,
) : RemoteClientTransport {
    override val kind: TransportKind = TransportKind.WEBRTC

    @Volatile
    private var handle: WebRtcPeerHandle? = null

    override fun connect(callbacks: RemoteTransportCallbacks) {
        if (signalingUrl.isBlank()) {
            throw TransportUnavailableException("WEBRTC_UNCONFIGURED", "signalingUrl is empty")
        }
        handle = peerEngine.openDataChannel(signalingUrl, roomId, stunUrls, callbacks)
    }

    override fun sendBinary(payload: ByteArray) {
        val h = handle ?: throw IOException("WebRTC DataChannel is not connected")
        h.sendBinary(payload)
    }

    override fun isOpen(): Boolean = handle?.isOpen() == true

    override fun close(reason: String) {
        handle?.close(reason)
        handle = null
    }
}
