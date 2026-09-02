// @ts-ignore - noise-handshake
import NoiseModule from 'noise-handshake'
// @ts-ignore - noise-handshake/cipher.js
import CipherModule from 'noise-handshake/cipher.js'
import { RemoteCryptoError } from './errors.js'
import { computeFingerprint, type HostKeyPair } from './host-identity.js'

export type NoiseSessionState = 'NEW' | 'HANDSHAKING' | 'AUTHENTICATED' | 'CLOSED'

interface NoiseInstance {
  s: { publicKey: Buffer; secretKey: Buffer }
  rs: Buffer
  re: Buffer
  rx: Buffer
  tx: Buffer
  digest: Buffer
  complete: boolean
  initialise(prologue: Buffer, remoteStatic?: Buffer): void
  send(payload?: Buffer): Buffer
  recv(message: Buffer): Buffer
}

interface CipherInstance {
  encrypt(plaintext: Buffer, ad?: Buffer): Buffer
  decrypt(ciphertext: Buffer, ad?: Buffer): Buffer
}

type NoiseConstructor = new (
  pattern: string,
  initiator: boolean,
  staticKeypair?: { publicKey: Buffer; secretKey: Buffer },
  opts?: object,
) => NoiseInstance

type CipherConstructor = new (key?: Buffer) => CipherInstance

const Noise: NoiseConstructor =
  (NoiseModule as unknown as { default?: NoiseConstructor }).default ??
  (NoiseModule as unknown as NoiseConstructor)

const Cipher: CipherConstructor =
  (CipherModule as unknown as { default?: CipherConstructor }).default ??
  (CipherModule as unknown as CipherConstructor)

export class NoiseInitiatorSession {
  private state: NoiseSessionState = 'NEW'
  private readonly noise: NoiseInstance
  private sendCipher: CipherInstance | undefined = undefined
  private recvCipher: CipherInstance | undefined = undefined
  private readonly remoteHostPublicKey: Uint8Array

  constructor(
    localStaticKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array },
    remoteHostPublicKey: Uint8Array,
    prologue: Uint8Array = new Uint8Array(0),
  ) {
    if (localStaticKeyPair.publicKey.byteLength !== 32 || localStaticKeyPair.secretKey.byteLength !== 32) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'initiator static keypair must be 32-byte keys')
    }
    if (remoteHostPublicKey.byteLength !== 32) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'remote host public key must be 32 bytes')
    }
    this.remoteHostPublicKey = new Uint8Array(remoteHostPublicKey)
    this.noise = new Noise('IK', true, {
      publicKey: Buffer.from(localStaticKeyPair.publicKey),
      secretKey: Buffer.from(localStaticKeyPair.secretKey),
    })
    this.noise.initialise(
      Buffer.from(prologue),
      Buffer.from(this.remoteHostPublicKey),
    )
  }

  getState(): NoiseSessionState {
    return this.state
  }

  getHandshakeHash(): Uint8Array {
    return new Uint8Array(this.noise.digest)
  }

  writeMessage1(): Uint8Array {
    if (this.state !== 'NEW') {
      throw new RemoteCryptoError(
        'HANDSHAKE_STATE_INVALID',
        `cannot write message 1 in state ${this.state}`,
      )
    }
    try {
      const msg1 = this.noise.send()
      this.state = 'HANDSHAKING'
      return new Uint8Array(msg1)
    } catch (err) {
      this.state = 'CLOSED'
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'failed to write handshake message 1')
    }
  }

  readMessage2(message2: Uint8Array): void {
    if (this.state !== 'HANDSHAKING') {
      throw new RemoteCryptoError(
        'HANDSHAKE_STATE_INVALID',
        `cannot read message 2 in state ${this.state}`,
      )
    }
    try {
      this.noise.recv(Buffer.from(message2))
      if (!this.noise.complete) {
        throw new Error('handshake did not complete after message 2')
      }
      this.sendCipher = new Cipher(this.noise.tx)
      this.recvCipher = new Cipher(this.noise.rx)
      this.state = 'AUTHENTICATED'
    } catch (err) {
      this.state = 'CLOSED'
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'handshake message 2 verification failed',
      )
    }
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    if (this.state !== 'AUTHENTICATED' || !this.sendCipher) {
      throw new RemoteCryptoError(
        'HANDSHAKE_STATE_INVALID',
        `cannot encrypt in state ${this.state}`,
      )
    }
    const ct = this.sendCipher.encrypt(Buffer.from(plaintext))
    return new Uint8Array(ct)
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    if (this.state !== 'AUTHENTICATED' || !this.recvCipher) {
      throw new RemoteCryptoError(
        'HANDSHAKE_STATE_INVALID',
        `cannot decrypt in state ${this.state}`,
      )
    }
    try {
      const pt = this.recvCipher.decrypt(Buffer.from(ciphertext))
      return new Uint8Array(pt)
    } catch (err) {
      throw new RemoteCryptoError(
        'CIPHERTEXT_INVALID',
        'could not verify or decrypt ciphertext',
      )
    }
  }

  close(): void {
    this.state = 'CLOSED'
    this.sendCipher = undefined
    this.recvCipher = undefined
  }
}

export class NoiseResponderSession {
  private state: NoiseSessionState = 'NEW'
  private readonly noise: NoiseInstance
  private sendCipher: CipherInstance | undefined = undefined
  private recvCipher: CipherInstance | undefined = undefined
  private remoteStaticKey: Uint8Array | undefined = undefined
  private remoteDeviceId: string | undefined = undefined

  constructor(
    hostKeyPair: HostKeyPair,
    prologue: Uint8Array = new Uint8Array(0),
  ) {
    this.noise = new Noise('IK', false, {
      publicKey: Buffer.from(hostKeyPair.identity.publicKey),
      secretKey: Buffer.from(hostKeyPair.secretKey),
    })
    this.noise.initialise(Buffer.from(prologue))
  }

  getState(): NoiseSessionState {
    return this.state
  }

  getHandshakeHash(): Uint8Array {
    return new Uint8Array(this.noise.digest)
  }

  getRemotePeer(): { staticPublicKey: Uint8Array; deviceId: string } {
    if (!this.remoteStaticKey || !this.remoteDeviceId) {
      throw new RemoteCryptoError(
        'HANDSHAKE_STATE_INVALID',
        'remote peer identity not available before message 1 is read',
      )
    }
    return {
      staticPublicKey: this.remoteStaticKey,
      deviceId: this.remoteDeviceId,
    }
  }

  readMessage1(message1: Uint8Array): { staticPublicKey: Uint8Array; deviceId: string } {
    if (this.state !== 'NEW') {
      throw new RemoteCryptoError(
        'HANDSHAKE_STATE_INVALID',
        `cannot read message 1 in state ${this.state}`,
      )
    }
    try {
      this.noise.recv(Buffer.from(message1))
      const rs = new Uint8Array(this.noise.rs)
      if (rs.byteLength !== 32) {
        throw new Error('remote static public key must be 32 bytes')
      }
      this.remoteStaticKey = rs
      this.remoteDeviceId = computeFingerprint(rs)
      this.state = 'HANDSHAKING'
      return {
        staticPublicKey: this.remoteStaticKey,
        deviceId: this.remoteDeviceId,
      }
    } catch (err) {
      this.state = 'CLOSED'
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'handshake message 1 verification failed',
      )
    }
  }

  writeMessage2(): Uint8Array {
    if (this.state !== 'HANDSHAKING') {
      throw new RemoteCryptoError(
        'HANDSHAKE_STATE_INVALID',
        `cannot write message 2 in state ${this.state}`,
      )
    }
    try {
      const msg2 = this.noise.send()
      if (!this.noise.complete) {
        throw new Error('responder handshake did not complete after message 2')
      }
      this.recvCipher = new Cipher(this.noise.rx)
      this.sendCipher = new Cipher(this.noise.tx)
      this.state = 'AUTHENTICATED'
      return new Uint8Array(msg2)
    } catch (err) {
      this.state = 'CLOSED'
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'failed to write handshake message 2',
      )
    }
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    if (this.state !== 'AUTHENTICATED' || !this.sendCipher) {
      throw new RemoteCryptoError(
        'HANDSHAKE_STATE_INVALID',
        `cannot encrypt in state ${this.state}`,
      )
    }
    const ct = this.sendCipher.encrypt(Buffer.from(plaintext))
    return new Uint8Array(ct)
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    if (this.state !== 'AUTHENTICATED' || !this.recvCipher) {
      throw new RemoteCryptoError(
        'HANDSHAKE_STATE_INVALID',
        `cannot decrypt in state ${this.state}`,
      )
    }
    try {
      const pt = this.recvCipher.decrypt(Buffer.from(ciphertext))
      return new Uint8Array(pt)
    } catch (err) {
      throw new RemoteCryptoError(
        'CIPHERTEXT_INVALID',
        'could not verify or decrypt ciphertext',
      )
    }
  }

  close(): void {
    this.state = 'CLOSED'
    this.sendCipher = undefined
    this.recvCipher = undefined
  }
}
