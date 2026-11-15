import { blake2b64, hkdfBlake2b } from './blake2b.ts'
import { concatBytes, utf8Encode, zeroize } from './bytes.ts'
import {
  buildNoiseNonce,
  chacha20Poly1305Decrypt,
  chacha20Poly1305Encrypt,
} from './chacha20poly1305.ts'
import {
  generateX25519KeyPair,
  x25519SharedSecret,
  type X25519KeyPair,
} from './x25519.ts'

export const NOISE_PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_BLAKE2b'
export const MAX_NOISE_MESSAGE_BYTES = 65_535
export const MAX_TRANSPORT_MESSAGES = 4_294_967_294

const HASHLEN = 64
const DHLEN = 32

export type NoiseSessionState = 'INIT' | 'SENT_MSG1' | 'READY' | 'CLOSED'

export class NoiseIkInitiator {
  private state: NoiseSessionState = 'INIT'
  private digest: Uint8Array
  private chainingKey: Uint8Array
  private cipherKey: Uint8Array | undefined = undefined
  private handshakeNonce = 0
  private ephemeralKeyPair: X25519KeyPair | undefined = undefined

  private sendKey: Uint8Array | undefined = undefined
  private recvKey: Uint8Array | undefined = undefined
  private sendNonce = 0
  private recvNonce = 0
  private handshakeHashBytes: Uint8Array | undefined = undefined

  private readonly clientKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array }
  private readonly remoteStaticPublicKey: Uint8Array

  constructor(options: {
    readonly clientKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array }
    readonly remoteStaticPublicKey: Uint8Array
    readonly prologue?: Uint8Array | undefined
  }) {
    if (options.clientKeyPair.publicKey.byteLength !== DHLEN || options.clientKeyPair.secretKey.byteLength !== DHLEN) {
      throw new Error('clientKeyPair keys must be 32 bytes')
    }
    if (options.remoteStaticPublicKey.byteLength !== DHLEN) {
      throw new Error('remoteStaticPublicKey must be 32 bytes')
    }

    this.clientKeyPair = {
      publicKey: new Uint8Array(options.clientKeyPair.publicKey),
      secretKey: new Uint8Array(options.clientKeyPair.secretKey),
    }
    this.remoteStaticPublicKey = new Uint8Array(options.remoteStaticPublicKey)

    const protocolBytes = utf8Encode(NOISE_PROTOCOL_NAME)
    this.digest = new Uint8Array(HASHLEN)
    this.digest.set(protocolBytes)
    this.chainingKey = new Uint8Array(this.digest)

    this.mixHash(options.prologue ?? new Uint8Array(0))
    // Noise_IK pre-message: -> s (responder static public key known to initiator)
    this.mixHash(this.remoteStaticPublicKey)
  }

  getState(): NoiseSessionState {
    return this.state
  }

  getHandshakeHash(): Uint8Array {
    if (!this.handshakeHashBytes) {
      throw new Error('Noise handshake hash not available before READY')
    }
    return new Uint8Array(this.handshakeHashBytes)
  }

  private mixHash(data: Uint8Array): void {
    const next = blake2b64(concatBytes(this.digest, data))
    this.digest.fill(0)
    this.digest = next
  }

  private mixKey(dh: Uint8Array): void {
    const derived = hkdfBlake2b(this.chainingKey, dh, new Uint8Array(0), 128)
    this.chainingKey.fill(0)
    this.chainingKey = new Uint8Array(derived.subarray(0, 64))
    if (this.cipherKey) {
      this.cipherKey.fill(0)
    }
    this.cipherKey = new Uint8Array(derived.subarray(64, 96))
    this.handshakeNonce = 0
    derived.fill(0)
  }

  private encryptAndHash(plaintext: Uint8Array): Uint8Array {
    if (!this.cipherKey) {
      throw new Error('Noise cipherKey missing during handshake')
    }
    const nonce = buildNoiseNonce(this.handshakeNonce)
    this.handshakeNonce += 1
    const ct = chacha20Poly1305Encrypt(this.cipherKey, nonce, plaintext, this.digest)
    this.mixHash(ct)
    return ct
  }

  private decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    if (!this.cipherKey) {
      throw new Error('Noise cipherKey missing during handshake')
    }
    const nonce = buildNoiseNonce(this.handshakeNonce)
    this.handshakeNonce += 1
    const pt = chacha20Poly1305Decrypt(this.cipherKey, nonce, ciphertext, this.digest)
    this.mixHash(ciphertext)
    return pt
  }

  /**
   * Message 1 (-> e, es, s, ss):
   * 32B e.pub || 48B AEAD(s.pub) || 16B AEAD("") = 96 bytes
   */
  writeMessage1(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (this.state !== 'INIT') {
      throw new Error(`writeMessage1 invalid in state ${this.state}`)
    }
    try {
      this.ephemeralKeyPair = generateX25519KeyPair()
      this.mixHash(this.ephemeralKeyPair.publicKey)

      const es = x25519SharedSecret(this.ephemeralKeyPair.secretKey, this.remoteStaticPublicKey)
      this.mixKey(es)
      es.fill(0)

      const encStatic = this.encryptAndHash(this.clientKeyPair.publicKey)

      const ss = x25519SharedSecret(this.clientKeyPair.secretKey, this.remoteStaticPublicKey)
      this.mixKey(ss)
      ss.fill(0)

      const encPayload = this.encryptAndHash(payload)
      const msg = concatBytes(this.ephemeralKeyPair.publicKey, encStatic, encPayload)
      if (msg.byteLength > MAX_NOISE_MESSAGE_BYTES) {
        throw new Error('Noise handshake message 1 exceeds max message size')
      }
      this.state = 'SENT_MSG1'
      return msg
    } catch (err) {
      this.close()
      throw err
    }
  }

  /**
   * Message 2 (<- e, ee, se):
   * 32B re.pub || 16B+ AEAD(payload) >= 48 bytes
   */
  readMessage2(message2: Uint8Array): Uint8Array {
    if (this.state !== 'SENT_MSG1' || !this.ephemeralKeyPair) {
      throw new Error(`readMessage2 invalid in state ${this.state}`)
    }
    try {
      if (message2.byteLength < DHLEN + 16 || message2.byteLength > MAX_NOISE_MESSAGE_BYTES) {
        throw new Error(`Invalid Noise message 2 length (${message2.byteLength})`)
      }

      const remoteEphemeral = message2.subarray(0, DHLEN)
      const encPayload = message2.subarray(DHLEN)

      this.mixHash(remoteEphemeral)

      const ee = x25519SharedSecret(this.ephemeralKeyPair.secretKey, remoteEphemeral)
      this.mixKey(ee)
      ee.fill(0)

      const se = x25519SharedSecret(this.clientKeyPair.secretKey, remoteEphemeral)
      this.mixKey(se)
      se.fill(0)

      const payload = this.decryptAndHash(encPayload)

      // Split symmetric state -> (k1 send, k2 recv) for initiator
      const splitKeys = hkdfBlake2b(this.chainingKey, new Uint8Array(0), new Uint8Array(0), 128)
      this.sendKey = new Uint8Array(splitKeys.subarray(0, 32))
      this.recvKey = new Uint8Array(splitKeys.subarray(64, 96))
      splitKeys.fill(0)

      this.sendNonce = 0
      this.recvNonce = 0
      this.handshakeHashBytes = new Uint8Array(this.digest)

      // Scrub handshake-only secrets immediately
      zeroize(
        this.ephemeralKeyPair.secretKey,
        this.ephemeralKeyPair.publicKey,
        this.chainingKey,
        this.cipherKey,
        this.clientKeyPair.secretKey,
      )
      this.ephemeralKeyPair = undefined
      this.cipherKey = undefined
      this.state = 'READY'

      return payload
    } catch (err) {
      this.close()
      throw err
    }
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    if (this.state !== 'READY' || !this.sendKey) {
      throw new Error('Noise session is not ready for encrypt')
    }
    if (this.sendNonce >= MAX_TRANSPORT_MESSAGES) {
      this.close()
      throw new Error('Noise send nonce limit exceeded; reconnect required')
    }
    if (plaintext.byteLength + 16 > MAX_NOISE_MESSAGE_BYTES) {
      throw new Error(`Transport plaintext too large (${plaintext.byteLength} bytes)`)
    }
    const nonce = buildNoiseNonce(this.sendNonce)
    this.sendNonce += 1
    return chacha20Poly1305Encrypt(this.sendKey, nonce, plaintext)
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    if (this.state !== 'READY' || !this.recvKey) {
      throw new Error('Noise session is not ready for decrypt')
    }
    try {
      if (this.recvNonce >= MAX_TRANSPORT_MESSAGES) {
        throw new Error('Noise receive nonce limit exceeded; reconnect required')
      }
      if (ciphertext.byteLength < 16 || ciphertext.byteLength > MAX_NOISE_MESSAGE_BYTES) {
        throw new Error(`Invalid Noise transport ciphertext length (${ciphertext.byteLength})`)
      }
      const nonce = buildNoiseNonce(this.recvNonce)
      this.recvNonce += 1
      return chacha20Poly1305Decrypt(this.recvKey, nonce, ciphertext)
    } catch (err) {
      this.close()
      throw err
    }
  }

  close(): void {
    this.state = 'CLOSED'
    zeroize(
      this.digest,
      this.chainingKey,
      this.cipherKey,
      this.sendKey,
      this.recvKey,
      this.handshakeHashBytes,
      this.ephemeralKeyPair?.secretKey,
      this.ephemeralKeyPair?.publicKey,
      this.clientKeyPair.secretKey,
    )
    this.cipherKey = undefined
    this.sendKey = undefined
    this.recvKey = undefined
    this.ephemeralKeyPair = undefined
    this.handshakeHashBytes = undefined
  }
}
