package org.dsh.community.android.transport

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/**
 * Lightweight RFC 6455 WebSocket client (`ws://` and `wss://`) built strictly on JDK sockets.
 * Zero external HTTP/WebSocket third-party dependencies.
 */
class BinaryWebSocketClient(
    private val url: String,
    private val connectTimeoutMs: Int = 5_000,
    private val maxFrameBytes: Int = 65_536,
    private val binaryOnly: Boolean = true,
) {
    interface Listener {
        fun onOpen()
        fun onBinaryMessage(payload: ByteArray)
        fun onClose(code: Int, reason: String)
        fun onError(error: Throwable)
    }

    companion object {
        private const val WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        private const val OPCODE_CONTINUATION = 0x0
        private const val OPCODE_TEXT = 0x1
        private const val OPCODE_BINARY = 0x2
        private const val OPCODE_CLOSE = 0x8
        private const val OPCODE_PING = 0x9
        private const val OPCODE_PONG = 0xA
    }

    private val random = SecureRandom()
    private val writeLock = Any()
    private val closed = AtomicBoolean(false)
    private val openFlag = AtomicBoolean(false)

    @Volatile
    private var socket: Socket? = null

    @Volatile
    private var output: OutputStream? = null

    @Volatile
    private var readerThread: Thread? = null

    fun isOpen(): Boolean = openFlag.get() && !closed.get()

    fun connectBlocking(listener: Listener) {
        val uri = URI(url)
        val scheme = uri.scheme?.lowercase()
            ?: throw IllegalArgumentException("WebSocket URL missing scheme: $url")
        if (scheme != "ws" && scheme != "wss") {
            throw IllegalArgumentException("unsupported WebSocket scheme '$scheme'")
        }
        val host = uri.host ?: throw IllegalArgumentException("WebSocket URL missing host: $url")
        val port = if (uri.port > 0) uri.port else if (scheme == "wss") 443 else 80
        val path = buildString {
            append(if (uri.rawPath.isNullOrEmpty()) "/" else uri.rawPath)
            if (!uri.rawQuery.isNullOrEmpty()) {
                append('?')
                append(uri.rawQuery)
            }
        }

        val rawSocket = Socket()
        rawSocket.connect(InetSocketAddress(host, port), connectTimeoutMs)
        rawSocket.tcpNoDelay = true

        val activeSocket: Socket = if (scheme == "wss") {
            val ssl = (SSLSocketFactory.getDefault() as SSLSocketFactory)
                .createSocket(rawSocket, host, port, true) as SSLSocket
            ssl.startHandshake()
            ssl
        } else {
            rawSocket
        }

        val input = BufferedInputStream(activeSocket.getInputStream(), 16_384)
        val out = activeSocket.getOutputStream()

        val keyBytes = ByteArray(16)
        random.nextBytes(keyBytes)
        val wsKey = Base64.getEncoder().encodeToString(keyBytes)
        val expectedAccept = computeAcceptKey(wsKey)

        val hostHeader = if ((scheme == "ws" && port == 80) || (scheme == "wss" && port == 443)) {
            host
        } else {
            "$host:$port"
        }

        val upgradeReq = buildString {
            append("GET ").append(path).append(" HTTP/1.1\r\n")
            append("Host: ").append(hostHeader).append("\r\n")
            append("Upgrade: websocket\r\n")
            append("Connection: Upgrade\r\n")
            append("Sec-WebSocket-Key: ").append(wsKey).append("\r\n")
            append("Sec-WebSocket-Version: 13\r\n")
            append("\r\n")
        }.toByteArray(StandardCharsets.US_ASCII)

        out.write(upgradeReq)
        out.flush()

        val headerText = readHttpUpgradeHeaders(input)
        val lines = headerText.split("\r\n")
        if (lines.isEmpty() || !lines[0].startsWith("HTTP/1.1 101")) {
            activeSocket.close()
            throw IOException("WebSocket upgrade failed: ${lines.firstOrNull() ?: "empty response"}")
        }
        var acceptHeader: String? = null
        for (i in 1 until lines.size) {
            val line = lines[i]
            val colon = line.indexOf(':')
            if (colon > 0) {
                val name = line.substring(0, colon).trim()
                if (name.equals("Sec-WebSocket-Accept", ignoreCase = true)) {
                    acceptHeader = line.substring(colon + 1).trim()
                    break
                }
            }
        }
        if (acceptHeader != expectedAccept) {
            activeSocket.close()
            throw IOException("WebSocket Sec-WebSocket-Accept mismatch")
        }

        socket = activeSocket
        output = out
        openFlag.set(true)
        listener.onOpen()

        val thread = Thread(
            { readLoop(input, listener) },
            "dsh-ws-reader-${host}:$port",
        ).apply {
            isDaemon = true
        }
        readerThread = thread
        thread.start()
    }

    fun sendBinary(payload: ByteArray) {
        if (!isOpen()) throw IOException("WebSocket is not open")
        if (payload.size > maxFrameBytes) {
            throw IOException("outbound frame (${payload.size}) exceeds maxFrameBytes ($maxFrameBytes)")
        }
        sendFrame(OPCODE_BINARY, payload)
    }

    fun close(code: Int = 1000, reason: String = "normal") {
        if (closed.getAndSet(true)) return
        openFlag.set(false)
        try {
            val reasonBytes = reason.toByteArray(StandardCharsets.UTF_8)
            val truncatedReason = if (reasonBytes.size > 120) reasonBytes.copyOf(120) else reasonBytes
            val payload = ByteArray(2 + truncatedReason.size)
            payload[0] = ((code ushr 8) and 0xFF).toByte()
            payload[1] = (code and 0xFF).toByte()
            System.arraycopy(truncatedReason, 0, payload, 2, truncatedReason.size)
            sendFrame(OPCODE_CLOSE, payload)
        } catch (_: Throwable) {
            // Best effort close frame
        } finally {
            try {
                socket?.close()
            } catch (_: Throwable) {
            }
        }
    }

    private fun readLoop(input: BufferedInputStream, listener: Listener) {
        var closeCode = 1006
        var closeReason = "connection dropped"
        var fragOpcode = -1
        val fragBuffer = ByteArrayOutputStream()

        try {
            while (!closed.get()) {
                val b0 = input.read()
                if (b0 == -1) {
                    closeCode = 1006
                    closeReason = "EOF"
                    break
                }
                val b1 = readUnsignedByte(input)
                val fin = (b0 and 0x80) != 0
                val rsv = (b0 and 0x70) ushr 4
                val opcode = b0 and 0x0F
                val masked = (b1 and 0x80) != 0
                if (rsv != 0 || masked) {
                    close(1002, "invalid RSV or masked server frame")
                    closeCode = 1002
                    closeReason = "protocol violation"
                    break
                }

                var len = (b1 and 0x7F).toLong()
                if (len == 126L) {
                    val hi = readUnsignedByte(input)
                    val lo = readUnsignedByte(input)
                    len = ((hi shl 8) or lo).toLong()
                } else if (len == 127L) {
                    var full = 0L
                    for (i in 0 until 8) {
                        full = (full shl 8) or readUnsignedByte(input).toLong()
                    }
                    if (full < 0L) throw IOException("negative 64-bit WebSocket frame length")
                    len = full
                }

                if (len > maxFrameBytes.toLong()) {
                    close(1009, "inbound frame exceeds maxFrameBytes")
                    listener.onError(IOException("inbound frame ($len) exceeds limit ($maxFrameBytes)"))
                    closeCode = 1009
                    closeReason = "frame too large"
                    break
                }

                val payload = readExact(input, len.toInt())

                if (opcode >= 0x8) {
                    if (!fin || payload.size > 125) {
                        close(1002, "invalid control frame")
                        closeCode = 1002
                        closeReason = "invalid control frame"
                        break
                    }
                    when (opcode) {
                        OPCODE_PING -> sendFrame(OPCODE_PONG, payload)
                        OPCODE_PONG -> Unit
                        OPCODE_CLOSE -> {
                            if (payload.size >= 2) {
                                closeCode = ((payload[0].toInt() and 0xFF) shl 8) or (payload[1].toInt() and 0xFF)
                                closeReason = if (payload.size > 2) {
                                    String(payload, 2, payload.size - 2, StandardCharsets.UTF_8)
                                } else {
                                    "closed"
                                }
                            } else {
                                closeCode = 1000
                                closeReason = "closed"
                            }
                            close(closeCode, closeReason)
                            break
                        }
                        else -> {
                            close(1002, "unknown control opcode")
                            closeCode = 1002
                            closeReason = "unknown control opcode"
                            break
                        }
                    }
                    continue
                }

                if (opcode == OPCODE_TEXT && binaryOnly) {
                    close(1003, "binary frames only")
                    listener.onError(SecurityException("unexpected text WebSocket frame rejected in binary-only mode"))
                    closeCode = 1003
                    closeReason = "binary frames only"
                    break
                }

                if (opcode == OPCODE_CONTINUATION) {
                    if (fragOpcode == -1) {
                        close(1002, "unexpected continuation frame")
                        closeCode = 1002
                        closeReason = "unexpected continuation frame"
                        break
                    }
                    if (fragBuffer.size() + payload.size > maxFrameBytes) {
                        close(1009, "fragmented message exceeds limit")
                        closeCode = 1009
                        closeReason = "fragmented message too large"
                        break
                    }
                    fragBuffer.write(payload)
                    if (fin) {
                        val assembled = fragBuffer.toByteArray()
                        fragBuffer.reset()
                        val completedOpcode = fragOpcode
                        fragOpcode = -1
                        if (completedOpcode == OPCODE_BINARY) {
                            listener.onBinaryMessage(assembled)
                        }
                    }
                } else {
                    if (fragOpcode != -1) {
                        close(1002, "interleaved fragmented frame")
                        closeCode = 1002
                        closeReason = "interleaved fragmented frame"
                        break
                    }
                    if (fin) {
                        if (opcode == OPCODE_BINARY) {
                            listener.onBinaryMessage(payload)
                        }
                    } else {
                        fragOpcode = opcode
                        fragBuffer.reset()
                        fragBuffer.write(payload)
                    }
                }
            }
        } catch (t: Throwable) {
            if (!closed.get()) {
                listener.onError(t)
                closeCode = 1006
                closeReason = t.message ?: "I/O error"
            }
        } finally {
            val wasOpen = openFlag.getAndSet(false)
            closed.set(true)
            try {
                socket?.close()
            } catch (_: Throwable) {
            }
            if (wasOpen) {
                listener.onClose(closeCode, closeReason)
            }
        }
    }

    private fun sendFrame(opcode: Int, payload: ByteArray) {
        val out = output ?: throw IOException("missing output stream")
        val mask = ByteArray(4)
        random.nextBytes(mask)

        val header = ByteArrayOutputStream(14)
        header.write(0x80 or (opcode and 0x0F))
        val len = payload.size
        when {
            len <= 125 -> header.write(0x80 or len)
            len <= 65_535 -> {
                header.write(0x80 or 126)
                header.write((len ushr 8) and 0xFF)
                header.write(len and 0xFF)
            }
            else -> {
                header.write(0x80 or 127)
                val l = len.toLong()
                for (shift in 56 downTo 0 step 8) {
                    header.write(((l ushr shift) and 0xFFL).toInt())
                }
            }
        }
        header.write(mask)

        val maskedPayload = ByteArray(len)
        for (i in 0 until len) {
            maskedPayload[i] = ((payload[i].toInt() xor mask[i and 3].toInt()) and 0xFF).toByte()
        }

        val packet = ByteArray(header.size() + maskedPayload.size)
        val hdrBytes = header.toByteArray()
        System.arraycopy(hdrBytes, 0, packet, 0, hdrBytes.size)
        System.arraycopy(maskedPayload, 0, packet, hdrBytes.size, maskedPayload.size)

        synchronized(writeLock) {
            out.write(packet)
            out.flush()
        }
    }

    private fun readHttpUpgradeHeaders(input: InputStream): String {
        val buf = ByteArrayOutputStream()
        var matched = 0
        while (buf.size() < 16_384) {
            val b = input.read()
            if (b == -1) throw EOFException("EOF while reading WebSocket upgrade headers")
            buf.write(b)
            matched = when {
                matched == 0 && b == '\r'.code -> 1
                matched == 1 && b == '\n'.code -> 2
                matched == 2 && b == '\r'.code -> 3
                matched == 3 && b == '\n'.code -> 4
                b == '\r'.code -> 1
                else -> 0
            }
            if (matched == 4) {
                return buf.toString(StandardCharsets.ISO_8859_1.name())
            }
        }
        throw IOException("HTTP upgrade headers exceeded 16 KiB")
    }

    private fun readUnsignedByte(input: InputStream): Int {
        val b = input.read()
        if (b == -1) throw EOFException("unexpected EOF reading WebSocket frame")
        return b
    }

    private fun readExact(input: InputStream, count: Int): ByteArray {
        val buf = ByteArray(count)
        var off = 0
        while (off < count) {
            val n = input.read(buf, off, count - off)
            if (n == -1) throw EOFException("unexpected EOF reading WebSocket payload ($off/$count)")
            off += n
        }
        return buf
    }

    private fun computeAcceptKey(wsKey: String): String {
        val sha1 = MessageDigest.getInstance("SHA-1")
        val digest = sha1.digest((wsKey + WS_GUID).toByteArray(StandardCharsets.US_ASCII))
        return Base64.getEncoder().encodeToString(digest)
    }
}
