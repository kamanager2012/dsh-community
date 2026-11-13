package org.dsh.community.android

import org.dsh.community.android.crypto.Blake2b
import org.dsh.community.android.crypto.ChaCha20Poly1305
import org.dsh.community.android.crypto.CryptoUtils
import org.dsh.community.android.crypto.Curve25519
import org.dsh.community.android.crypto.DeviceIdentity
import org.dsh.community.android.crypto.NoiseIkClient
import org.dsh.community.android.protocol.DisplayTextSanitizer
import org.dsh.community.android.protocol.JsonCodec
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.JsonString
import org.dsh.community.android.service.PendingInteractionQueue
import org.dsh.community.android.transport.FailoverRemoteSession
import org.dsh.community.android.transport.RemoteClientTransport
import org.dsh.community.android.transport.RemoteConnectionPhase
import org.dsh.community.android.transport.RemoteEndpointProfile
import org.dsh.community.android.transport.RemoteTransportCallbacks
import org.dsh.community.android.transport.TransportKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class HardeningAndQueueTest {
    private class TestNoiseIkResponder(
        private val staticKeyPair: Curve25519.KeyPair,
    ) {
        private val digest = ByteArray(Blake2b.HASH_LEN)
        private var chainingKey = ByteArray(Blake2b.HASH_LEN)
        private var cipherKey: ByteArray? = null
        private var handshakeNonce = 0L
        private var initiatorEphemeral: ByteArray? = null
        private var clientStatic: ByteArray? = null
        private var recvKey: ByteArray? = null
        private var sendKey: ByteArray? = null
        private var recvCounter = 0L
        private var sendCounter = 0L

        init {
            val proto = NoiseIkClient.PROTOCOL_NAME.toByteArray(StandardCharsets.US_ASCII)
            System.arraycopy(proto, 0, digest, 0, proto.size)
            chainingKey = digest.copyOf()
            mixHash(ByteArray(0))
            mixHash(staticKeyPair.publicKey)
        }

        fun readMessage1(msg1: ByteArray): ByteArray {
            val ie = msg1.copyOfRange(0, Curve25519.KEY_BYTES)
            initiatorEphemeral = ie
            mixHash(ie)
            mixKey(ie, staticKeyPair.secretKey)

            val encStaticEnd = Curve25519.KEY_BYTES + Curve25519.KEY_BYTES + ChaCha20Poly1305.TAG_BYTES
            val encStatic = msg1.copyOfRange(Curve25519.KEY_BYTES, encStaticEnd)
            val cs = decryptAndHash(encStatic)
            clientStatic = cs
            mixKey(cs, staticKeyPair.secretKey)

            val encPayload = msg1.copyOfRange(encStaticEnd, msg1.size)
            return decryptAndHash(encPayload)
        }

        fun writeMessage2(payload: ByteArray = ByteArray(0)): ByteArray {
            val ie = initiatorEphemeral ?: throw IllegalStateException("missing initiator ephemeral")
            val cs = clientStatic ?: throw IllegalStateException("missing client static")
            val re = Curve25519.generateKeyPair()
            mixHash(re.publicKey)
            mixKey(ie, re.secretKey)
            mixKey(cs, re.secretKey)
            val encPayload = encryptAndHash(payload)

            val splitKeys = Blake2b.hkdf(salt = chainingKey, ikm = ByteArray(0), totalLength = 2 * Blake2b.HASH_LEN)
            recvKey = splitKeys[0].copyOfRange(0, 32)
            sendKey = splitKeys[1].copyOfRange(0, 32)

            return ByteArray(re.publicKey.size + encPayload.size).also { out ->
                System.arraycopy(re.publicKey, 0, out, 0, re.publicKey.size)
                System.arraycopy(encPayload, 0, out, re.publicKey.size, encPayload.size)
            }
        }

        @Synchronized
        fun encrypt(plaintext: ByteArray): ByteArray {
            val key = sendKey ?: throw IllegalStateException("handshake incomplete")
            val ct = ChaCha20Poly1305.encrypt(
                key = key,
                nonce = ChaCha20Poly1305.noiseNonce(sendCounter),
                plaintext = plaintext,
            )
            sendCounter += 1L
            return ct
        }

        @Synchronized
        fun decrypt(ciphertext: ByteArray): ByteArray {
            val key = recvKey ?: throw IllegalStateException("handshake incomplete")
            val pt = ChaCha20Poly1305.decrypt(
                key = key,
                nonce = ChaCha20Poly1305.noiseNonce(recvCounter),
                ciphertextWithTag = ciphertext,
            )
            recvCounter += 1L
            return pt
        }

        private fun mixHash(data: ByteArray) {
            val next = Blake2b.digest(digest, data)
            System.arraycopy(next, 0, digest, 0, Blake2b.HASH_LEN)
        }

        private fun mixKey(remotePub: ByteArray, localSecret: ByteArray) {
            val dh = Curve25519.sharedSecret(localSecret, remotePub)
            val res = Blake2b.hkdf(salt = chainingKey, ikm = dh, totalLength = 2 * Blake2b.HASH_LEN)
            chainingKey = res[0]
            cipherKey = res[1].copyOfRange(0, 32)
            handshakeNonce = 0L
        }

        private fun encryptAndHash(plaintext: ByteArray): ByteArray {
            val k = cipherKey ?: throw IllegalStateException("missing cipherKey")
            val ct = ChaCha20Poly1305.encrypt(
                key = k,
                nonce = ChaCha20Poly1305.noiseNonce(handshakeNonce),
                plaintext = plaintext,
                aad = digest,
            )
            handshakeNonce += 1L
            mixHash(ct)
            return ct
        }

        private fun decryptAndHash(ciphertext: ByteArray): ByteArray {
            val k = cipherKey ?: throw IllegalStateException("missing cipherKey")
            val pt = ChaCha20Poly1305.decrypt(
                key = k,
                nonce = ChaCha20Poly1305.noiseNonce(handshakeNonce),
                ciphertextWithTag = ciphertext,
                aad = digest,
            )
            handshakeNonce += 1L
            mixHash(ciphertext)
            return pt
        }
    }

    private class MockHostTransport(
        override val kind: TransportKind,
        private val hostKeys: Curve25519.KeyPair,
        private val epochToAdvertise: Int = 1,
        private val holdRpcReplies: AtomicBoolean = AtomicBoolean(false),
    ) : RemoteClientTransport {
        private val responder = TestNoiseIkResponder(hostKeys)
        private val wireExecutor = Executors.newSingleThreadExecutor { r ->
            Thread(r, "mock-host-wire").apply { isDaemon = true }
        }
        private val open = AtomicBoolean(false)
        private val handshakeSeen = AtomicBoolean(false)
        val closeCalls = AtomicInteger(0)
        val decryptErrors = AtomicInteger(0)
        val firstRpcReceived = CountDownLatch(1)

        @Volatile
        var callbacks: RemoteTransportCallbacks? = null

        override fun connect(callbacks: RemoteTransportCallbacks) {
            this.callbacks = callbacks
            open.set(true)
        }

        override fun sendBinary(payload: ByteArray) {
            if (!open.get()) throw IOException("transport closed")
            if (handshakeSeen.compareAndSet(false, true)) {
                responder.readMessage1(payload)
                val msg2 = responder.writeMessage2()
                val notice = """{"type":"handshake.complete","connectionEpoch":$epochToAdvertise,"state":"ACTIVE"}"""
                    .toByteArray(StandardCharsets.UTF_8)
                val encNotice = responder.encrypt(notice)
                wireExecutor.execute {
                    callbacks?.onBinaryFrame(msg2)
                    callbacks?.onBinaryFrame(encNotice)
                }
                return
            }

            // Decrypt synchronously in exact wire arrival order to catch any Noise nonce reordering.
            val frameObj = try {
                val pt = responder.decrypt(payload)
                JsonCodec.parseObject(String(pt, StandardCharsets.UTF_8))
            } catch (t: Throwable) {
                decryptErrors.incrementAndGet()
                throw t
            }
            val id = frameObj.str("id") ?: return
            firstRpcReceived.countDown()
            if (holdRpcReplies.get()) {
                return
            }
            val reply = JsonObject.of(
                "jsonrpc" to JsonString("2.0"),
                "id" to JsonString(id),
                "result" to JsonObject.of("ok" to org.dsh.community.android.protocol.JsonBool(true)),
            ).stringify().toByteArray(StandardCharsets.UTF_8)
            wireExecutor.execute {
                if (open.get()) {
                    callbacks?.onBinaryFrame(responder.encrypt(reply))
                }
            }
        }

        override fun isOpen(): Boolean = open.get()

        override fun close(reason: String) {
            closeCalls.incrementAndGet()
            if (open.compareAndSet(true, false)) {
                callbacks?.onClosed(reason)
            }
            wireExecutor.shutdownNow()
        }
    }

    private fun testIdentity(): DeviceIdentity {
        val kp = Curve25519.generateKeyPair()
        val id = CryptoUtils.sha256Hex(kp.publicKey)
        return DeviceIdentity(kp, id, "jvm-test")
    }

    private fun testProfile(hostPub: ByteArray): RemoteEndpointProfile = RemoteEndpointProfile(
        hostPublicKey = hostPub,
        hostFingerprint = CryptoUtils.sha256Hex(hostPub),
        lanUrl = "ws://127.0.0.1:9999",
        bootstrapToken = null,
    )

    @Test
    fun displayTextSanitizerStripsAnsiBidiAndControlsWhilePreservingMultilineText() {
        val dirty = "\u001B[31mALERT\u001B[0m\u001B]0;evil-title\u0007\u202Espoof\u2066bidi\u2069\u200F\u0001\u0008\r\nline2\tcol2\u007F"
        assertEquals("ALERTspoofbidiline2\tcol2", DisplayTextSanitizer.sanitizeMultiline(dirty).replace("\n", ""))
        assertEquals("ALERTspoofbidi\nline2\tcol2", DisplayTextSanitizer.sanitizeMultiline(dirty))
        assertEquals("ALERTspoofbidi line2 col2", DisplayTextSanitizer.sanitizeSingleLine(dirty))
        assertEquals("", DisplayTextSanitizer.sanitizeSingleLine(null))
        assertEquals("", DisplayTextSanitizer.sanitizeMultiline(""))
    }

    @Test
    fun pendingInteractionQueueRetainsConcurrentItemsInFifoOrder() {
        val queue = PendingInteractionQueue()
        assertTrue(queue.enqueueApproval("call-1", "run rm", "sess-1"))
        assertTrue(queue.enqueueApproval("call-2", "edit config", "sess-1"))
        // Updating existing callId updates summary in place without duplicating.
        assertFalse(queue.enqueueApproval("call-1", "run rm updated", "sess-1"))

        assertEquals(2, queue.listApprovals().size)
        assertEquals("call-1", queue.peekApproval()?.callId)
        assertEquals("run rm updated", queue.peekApproval()?.summary)

        assertNotNull(queue.removeApproval("call-1"))
        assertEquals("call-2", queue.peekApproval()?.callId)
        assertNotNull(queue.removeApproval("call-2"))
        assertNull(queue.peekApproval())

        assertTrue(queue.enqueueQuestion("q-1", "Question 1", "sess-1"))
        assertTrue(queue.enqueueQuestion("q-2", "Question 2", "sess-1"))
        assertFalse(queue.enqueueQuestion("q-1", "Question 1 edited", "sess-1"))
        assertEquals("q-1", queue.peekQuestion()?.questionId)
        queue.removeQuestion("q-1")
        assertEquals("q-2", queue.peekQuestion()?.questionId)

        queue.clearAll()
        assertTrue(queue.listApprovals().isEmpty())
        assertTrue(queue.listQuestions().isEmpty())
    }

    @Test
    fun postHandshakeOnErrorClosesTransportFailsPendingRpcAndFiresListenerOnce() {
        val hostKeys = Curve25519.generateKeyPair()
        val holdReplies = AtomicBoolean(true)
        val transport = MockHostTransport(TransportKind.LAN, hostKeys, epochToAdvertise = 1, holdRpcReplies = holdReplies)
        val closedEvents = AtomicInteger(0)
        val closedReason = AtomicReference<String?>(null)

        val session = FailoverRemoteSession(
            identity = testIdentity(),
            profile = testProfile(hostKeys.publicKey),
            lanFactory = { transport },
            requestTimeoutMs = 5_000L,
            handshakeTimeoutMs = 2_000L,
        )
        session.addListener(
            object : FailoverRemoteSession.Listener {
                override fun onTransportClosed(carrier: TransportKind, reason: String) {
                    closedEvents.incrementAndGet()
                    closedReason.set(reason)
                }
            },
        )

        assertEquals(RemoteConnectionPhase.ACTIVE, session.connect(listOf(TransportKind.LAN)))
        assertTrue(session.isTransportOpen())

        val rpcFailureLatch = CountDownLatch(1)
        val rpcError = AtomicReference<Throwable?>(null)
        val caller = Thread {
            try {
                session.ping()
            } catch (t: Throwable) {
                rpcError.set(t)
            } finally {
                rpcFailureLatch.countDown()
            }
        }
        caller.start()
        assertTrue("expected in-flight RPC frame", transport.firstRpcReceived.await(2, TimeUnit.SECONDS))

        // Simulate post-open transport error (e.g. WebRTC ICE disconnect) followed by duplicate onClosed.
        transport.callbacks!!.onError(IOException("webrtc ice dropped"))
        transport.callbacks!!.onClosed("trailing close")

        assertTrue("pending RPC should fail immediately on transport error", rpcFailureLatch.await(2, TimeUnit.SECONDS))
        assertNotNull(rpcError.get())
        assertFalse(transport.isOpen())
        assertFalse(session.isTransportOpen())
        assertEquals(1, transport.closeCalls.get())
        assertEquals(1, closedEvents.get())
        assertEquals("webrtc ice dropped", closedReason.get())
    }

    @Test
    fun initialHighestEpochRejectsHostEpochRegressionAcrossSessions() {
        val hostKeys = Curve25519.generateKeyPair()
        val replayedTransport = MockHostTransport(TransportKind.LAN, hostKeys, epochToAdvertise = 2)
        val blockedSession = FailoverRemoteSession(
            identity = testIdentity(),
            profile = testProfile(hostKeys.publicKey),
            lanFactory = { replayedTransport },
            requestTimeoutMs = 2_000L,
            handshakeTimeoutMs = 2_000L,
            initialHighestEpoch = 3,
        )
        var thrown: Throwable? = null
        try {
            blockedSession.connect(listOf(TransportKind.LAN))
        } catch (t: Throwable) {
            thrown = t
        }
        assertNotNull("epoch <= initialHighestEpoch must fail closed", thrown)
        assertTrue(
            "expected epoch regression diagnostic, got ${thrown!!.message}",
            thrown.message?.contains("regression") == true,
        )

        val freshTransport = MockHostTransport(TransportKind.LAN, hostKeys, epochToAdvertise = 4)
        val acceptedSession = FailoverRemoteSession(
            identity = testIdentity(),
            profile = testProfile(hostKeys.publicKey),
            lanFactory = { freshTransport },
            requestTimeoutMs = 2_000L,
            handshakeTimeoutMs = 2_000L,
            initialHighestEpoch = 3,
        )
        assertEquals(RemoteConnectionPhase.ACTIVE, acceptedSession.connect(listOf(TransportKind.LAN)))
        assertEquals(4, acceptedSession.currentEpoch)
        acceptedSession.close("done")
    }

    @Test
    fun concurrentRpcSendsSerializeNoiseNoncesStrictlyInOrder() {
        val hostKeys = Curve25519.generateKeyPair()
        val transport = MockHostTransport(TransportKind.LAN, hostKeys, epochToAdvertise = 1)
        val session = FailoverRemoteSession(
            identity = testIdentity(),
            profile = testProfile(hostKeys.publicKey),
            lanFactory = { transport },
            requestTimeoutMs = 5_000L,
            handshakeTimeoutMs = 2_000L,
        )
        assertEquals(RemoteConnectionPhase.ACTIVE, session.connect(listOf(TransportKind.LAN)))

        val workers = 8
        val iterationsPerWorker = 10
        val pool = Executors.newFixedThreadPool(workers)
        val done = CountDownLatch(workers)
        val successes = AtomicInteger(0)
        val failures = AtomicInteger(0)

        for (w in 0 until workers) {
            pool.execute {
                try {
                    for (i in 0 until iterationsPerWorker) {
                        if (session.ping()) {
                            successes.incrementAndGet()
                        } else {
                            failures.incrementAndGet()
                        }
                    }
                } catch (_: Throwable) {
                    failures.incrementAndGet()
                } finally {
                    done.countDown()
                }
            }
        }

        assertTrue("concurrent RPC batch timed out", done.await(15, TimeUnit.SECONDS))
        pool.shutdownNow()
        session.close("test done")

        assertEquals(0, transport.decryptErrors.get())
        assertEquals(0, failures.get())
        assertEquals(workers * iterationsPerWorker, successes.get())
    }
}
