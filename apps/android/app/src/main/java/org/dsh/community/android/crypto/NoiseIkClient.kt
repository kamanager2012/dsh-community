package org.dsh.community.android.crypto

import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.util.Arrays

/**
 * Pure Kotlin Noise_IK_25519_ChaChaPoly_BLAKE2b initiator session wire-compatible with
 * `@dsh-community/remote-adapter`'s `NoiseResponderSession` (`noise-handshake` v4.2.0).
 */
class NoiseIkClient(
    private val localStaticKeyPair: Curve25519.KeyPair,
    remoteHostStaticPublicKey: ByteArray,
    prologue: ByteArray = ByteArray(0),
    private val random: SecureRandom = SecureRandom(),
    private val maxTransportMessages: Long = MAX_TRANSPORT_MESSAGES,
) {
    enum class State {
        NEW,
        HANDSHAKING,
        CHANNEL_AUTHENTICATED,
        CLOSED,
    }

    companion object {
        const val PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_BLAKE2b"
        const val MAX_TRANSPORT_MESSAGES = 4_294_967_294L
        const val MAX_NOISE_MESSAGE_BYTES = 65535
    }

    private val rs: ByteArray = remoteHostStaticPublicKey.copyOf()
    private val digest: ByteArray = ByteArray(Blake2b.HASH_LEN)
    private var chainingKey: ByteArray = ByteArray(Blake2b.HASH_LEN)
    private var cipherKey: ByteArray? = null
    private var handshakeNonce: Long = 0L

    private var ephemeralKeyPair: Curve25519.KeyPair? = null
    private var remoteEphemeral: ByteArray? = null

    private var sendKey: ByteArray? = null
    private var recvKey: ByteArray? = null
    private var sendCounter: Long = 0L
    private var recvCounter: Long = 0L
    private var storedHandshakeHash: ByteArray? = null

    var state: State = State.NEW
        private set

    init {
        require(localStaticKeyPair.publicKey.size == Curve25519.KEY_BYTES) {
            "local static publicKey must be 32 bytes"
        }
        require(localStaticKeyPair.secretKey.size == Curve25519.KEY_BYTES) {
            "local static secretKey must be 32 bytes"
        }
        require(rs.size == Curve25519.KEY_BYTES) {
            "remote host static publicKey must be 32 bytes"
        }
        require(maxTransportMessages in 1L..MAX_TRANSPORT_MESSAGES) {
            "maxTransportMessages must be between 1 and $MAX_TRANSPORT_MESSAGES"
        }

        val protocolBytes = PROTOCOL_NAME.toByteArray(StandardCharsets.US_ASCII)
        if (protocolBytes.size <= Blake2b.HASH_LEN) {
            System.arraycopy(protocolBytes, 0, digest, 0, protocolBytes.size)
        } else {
            val hashed = Blake2b.digest(protocolBytes)
            System.arraycopy(hashed, 0, digest, 0, Blake2b.HASH_LEN)
        }
        chainingKey = digest.copyOf()

        mixHash(prologue)
        // Noise IK pre-message: -> s (initiator knows responder static key rs)
        mixHash(rs)
    }

    fun handshakeHash(): ByteArray {
        val h = storedHandshakeHash
            ?: throw IllegalStateException("handshake has not completed yet")
        return h.copyOf()
    }

    @Synchronized
    fun writeMessage1(payload: ByteArray = ByteArray(0)): ByteArray {
        check(state == State.NEW) { "cannot write message 1 in state $state" }

        // IK Msg 1 tokens: [e, es, s, ss] + encrypted payload
        val e = Curve25519.generateKeyPair(random)
        ephemeralKeyPair = e

        mixHash(e.publicKey)
        mixKey(remotePublicKey = rs, localSecretKey = e.secretKey)

        val encryptedStatic = encryptAndHash(localStaticKeyPair.publicKey)
        mixKey(remotePublicKey = rs, localSecretKey = localStaticKeyPair.secretKey)

        val encryptedPayload = encryptAndHash(payload)

        state = State.HANDSHAKING
        val msg1 = ByteArray(e.publicKey.size + encryptedStatic.size + encryptedPayload.size)
        var off = 0
        System.arraycopy(e.publicKey, 0, msg1, off, e.publicKey.size); off += e.publicKey.size
        System.arraycopy(encryptedStatic, 0, msg1, off, encryptedStatic.size); off += encryptedStatic.size
        System.arraycopy(encryptedPayload, 0, msg1, off, encryptedPayload.size)
        return msg1
    }

    @Synchronized
    fun readMessage2(message2: ByteArray): ByteArray {
        check(state == State.HANDSHAKING) { "cannot read message 2 in state $state" }
        val e = ephemeralKeyPair ?: throw IllegalStateException("missing initiator ephemeral key")
        val minSize = Curve25519.KEY_BYTES + ChaCha20Poly1305.TAG_BYTES
        if (message2.size < minSize) {
            close()
            throw SecurityException("Noise message 2 too short (${message2.size} bytes)")
        }

        return try {
            // IK Msg 2 tokens: [e, ee, se] + encrypted payload
            val re = message2.copyOfRange(0, Curve25519.KEY_BYTES)
            remoteEphemeral = re
            mixHash(re)

            mixKey(remotePublicKey = re, localSecretKey = e.secretKey)
            mixKey(remotePublicKey = re, localSecretKey = localStaticKeyPair.secretKey)

            val encryptedPayload = message2.copyOfRange(Curve25519.KEY_BYTES, message2.size)
            val payload = decryptAndHash(encryptedPayload)

            val splitKeys = Blake2b.hkdf(salt = chainingKey, ikm = ByteArray(0), totalLength = 2 * Blake2b.HASH_LEN)
            sendKey = splitKeys[0].copyOfRange(0, 32)
            recvKey = splitKeys[1].copyOfRange(0, 32)
            CryptoUtils.zeroize(splitKeys[0])
            CryptoUtils.zeroize(splitKeys[1])

            storedHandshakeHash = digest.copyOf()
            sendCounter = 0L
            recvCounter = 0L
            state = State.CHANNEL_AUTHENTICATED

            clearHandshakeSecrets()
            payload
        } catch (t: Throwable) {
            close()
            if (t is SecurityException) throw t
            throw SecurityException("Noise handshake message 2 verification failed", t)
        }
    }

    @Synchronized
    fun encrypt(plaintext: ByteArray): ByteArray {
        check(state == State.CHANNEL_AUTHENTICATED) { "cannot encrypt in state $state" }
        val k = sendKey ?: throw IllegalStateException("missing transport sendKey")
        if (sendCounter >= maxTransportMessages) {
            close()
            throw IllegalStateException("Noise transport send nonce ceiling reached; reconnect required")
        }
        val ciphertext = ChaCha20Poly1305.encrypt(
            key = k,
            nonce = ChaCha20Poly1305.noiseNonce(sendCounter),
            plaintext = plaintext,
        )
        if (ciphertext.size > MAX_NOISE_MESSAGE_BYTES) {
            throw IllegalArgumentException("ciphertext length ${ciphertext.size} exceeds max $MAX_NOISE_MESSAGE_BYTES")
        }
        sendCounter += 1L
        return ciphertext
    }

    @Synchronized
    fun decrypt(ciphertext: ByteArray): ByteArray {
        check(state == State.CHANNEL_AUTHENTICATED) { "cannot decrypt in state $state" }
        val k = recvKey ?: throw IllegalStateException("missing transport recvKey")
        if (recvCounter >= maxTransportMessages) {
            close()
            throw IllegalStateException("Noise transport recv nonce ceiling reached; reconnect required")
        }
        if (ciphertext.size > MAX_NOISE_MESSAGE_BYTES) {
            close()
            throw SecurityException("ciphertext length ${ciphertext.size} exceeds max $MAX_NOISE_MESSAGE_BYTES")
        }
        val plaintext = try {
            ChaCha20Poly1305.decrypt(
                key = k,
                nonce = ChaCha20Poly1305.noiseNonce(recvCounter),
                ciphertextWithTag = ciphertext,
            )
        } catch (e: SecurityException) {
            close()
            throw e
        }
        recvCounter += 1L
        return plaintext
    }

    @Synchronized
    fun close() {
        state = State.CLOSED
        clearHandshakeSecrets()
        CryptoUtils.zeroize(sendKey)
        CryptoUtils.zeroize(recvKey)
        CryptoUtils.zeroize(storedHandshakeHash)
        CryptoUtils.zeroize(rs)
        sendKey = null
        recvKey = null
        storedHandshakeHash = null
    }

    private fun mixHash(data: ByteArray) {
        val next = Blake2b.digest(digest, data)
        System.arraycopy(next, 0, digest, 0, Blake2b.HASH_LEN)
    }

    private fun mixKey(remotePublicKey: ByteArray, localSecretKey: ByteArray) {
        val dh = Curve25519.sharedSecret(localSecretKey, remotePublicKey)
        val res = Blake2b.hkdf(salt = chainingKey, ikm = dh, totalLength = 2 * Blake2b.HASH_LEN)
        CryptoUtils.zeroize(dh)
        CryptoUtils.zeroize(chainingKey)
        chainingKey = res[0]
        CryptoUtils.zeroize(cipherKey)
        cipherKey = res[1].copyOfRange(0, 32)
        CryptoUtils.zeroize(res[1])
        handshakeNonce = 0L
    }

    private fun encryptAndHash(plaintext: ByteArray): ByteArray {
        val k = cipherKey
        val ciphertext = if (k == null) {
            plaintext.copyOf()
        } else {
            val ct = ChaCha20Poly1305.encrypt(
                key = k,
                nonce = ChaCha20Poly1305.noiseNonce(handshakeNonce),
                plaintext = plaintext,
                aad = digest,
            )
            handshakeNonce += 1L
            ct
        }
        mixHash(ciphertext)
        return ciphertext
    }

    private fun decryptAndHash(ciphertext: ByteArray): ByteArray {
        val k = cipherKey
        val plaintext = if (k == null) {
            ciphertext.copyOf()
        } else {
            val pt = ChaCha20Poly1305.decrypt(
                key = k,
                nonce = ChaCha20Poly1305.noiseNonce(handshakeNonce),
                ciphertextWithTag = ciphertext,
                aad = digest,
            )
            handshakeNonce += 1L
            pt
        }
        mixHash(ciphertext)
        return plaintext
    }

    private fun clearHandshakeSecrets() {
        Arrays.fill(digest, 0.toByte())
        CryptoUtils.zeroize(chainingKey)
        CryptoUtils.zeroize(cipherKey)
        cipherKey = null
        ephemeralKeyPair?.zeroize()
        ephemeralKeyPair?.let { CryptoUtils.zeroize(it.publicKey) }
        CryptoUtils.zeroize(remoteEphemeral)
        ephemeralKeyPair = null
        remoteEphemeral = null
    }
}
