package org.dsh.community.android

import org.dsh.community.android.transport.BinaryWebSocketClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import kotlin.concurrent.thread

class BinaryWebSocketClientTlsTest {
    @Test
    fun configureTlsEnablesHttpsHostnameVerification() {
        val client = BinaryWebSocketClient("wss://relay.example.com:443")
        (SSLSocketFactory.getDefault().createSocket() as SSLSocket).use { socket ->
            client.configureTlsParameters(socket)
            assertEquals("HTTPS", socket.sslParameters.endpointIdentificationAlgorithm)
        }
    }

    @Test
    fun connectBlockingClosesCleanlyOnUpgradeFailureAndRejectsClosedClient() {
        val preClosed = BinaryWebSocketClient("ws://127.0.0.1:1")
        preClosed.close()
        assertThrows(IOException::class.java) {
            preClosed.connectBlocking(
                object : BinaryWebSocketClient.Listener {
                    override fun onOpen() = Unit
                    override fun onBinaryMessage(payload: ByteArray) = Unit
                    override fun onClose(code: Int, reason: String) = Unit
                    override fun onError(error: Throwable) = Unit
                },
            )
        }

        ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { server ->
            val accepted = arrayOfNulls<Socket>(1)
            val srvThread = thread(isDaemon = true) {
                val sock = server.accept()
                accepted[0] = sock
                sock.getOutputStream().write("HTTP/1.1 403 Forbidden\r\n\r\n".toByteArray())
                sock.getOutputStream().flush()
                try {
                    while (sock.getInputStream().read() != -1) {
                        // wait for client close
                    }
                } catch (_: IOException) {
                } finally {
                    sock.close()
                }
            }

            val client = BinaryWebSocketClient("ws://127.0.0.1:${server.localPort}", connectTimeoutMs = 2_000)
            val err = assertThrows(IOException::class.java) {
                client.connectBlocking(
                    object : BinaryWebSocketClient.Listener {
                        override fun onOpen() = Unit
                        override fun onBinaryMessage(payload: ByteArray) = Unit
                        override fun onClose(code: Int, reason: String) = Unit
                        override fun onError(error: Throwable) = Unit
                    },
                )
            }
            assertTrue(err.message?.contains("403") == true)
            srvThread.join(2_000)
        }
    }
}
