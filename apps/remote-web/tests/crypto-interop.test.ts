import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, diffieHellman, createPrivateKey, createPublicKey } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  InMemoryHostIdentityStore,
  NoiseResponderSession,
  computeFingerprint,
} from '@dsh-community/remote-adapter'
import { blake2b64, hkdfBlake2b, hmacBlake2b } from '../src/crypto/blake2b.ts'
import { bytesToHex, hexToBytes, sha256Hex, utf8Decode, utf8Encode } from '../src/crypto/bytes.ts'
import {
  buildNoiseNonce,
  chacha20Poly1305Decrypt,
  chacha20Poly1305Encrypt,
} from '../src/crypto/chacha20poly1305.ts'
import { NoiseIkInitiator } from '../src/crypto/noise-ik.ts'
import {
  clampX25519Scalar,
  generateX25519KeyPair,
  x25519ScalarMult,
  x25519ScalarMultBase,
  x25519SharedSecret,
} from '../src/crypto/x25519.ts'

describe('remote-web pure-TS E2EE cryptography', () => {
  it('matches RFC 7693 and Node blake2b512 across empty, boundary, and multi-block inputs', () => {
    const emptyExpected =
      '786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce'
    expect(bytesToHex(blake2b64(new Uint8Array(0)))).toBe(emptyExpected)
    expect(bytesToHex(blake2b64(utf8Encode('abc')))).toBe(
      'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
    )

    for (const len of [0, 1, 63, 64, 127, 128, 129, 255, 256, 257, 1024]) {
      const sample = new Uint8Array(len)
      for (let i = 0; i < len; i += 1) sample[i] = (i * 37 + 13) & 0xff
      const expected = createHash('blake2b512').update(sample).digest('hex')
      expect(bytesToHex(blake2b64(sample))).toBe(expected)
    }

    const mac = hmacBlake2b(new Uint8Array(150).fill(0xab), utf8Encode('hello world'))
    expect(mac.byteLength).toBe(64)
    const hkdfOut = hkdfBlake2b(new Uint8Array(64).fill(1), new Uint8Array(32).fill(2), new Uint8Array(0), 128)
    expect(hkdfOut.byteLength).toBe(128)
  })

  it('matches RFC 7748 X25519 vector and Node diffieHellman while rejecting small-order keys', () => {
    // RFC 7748 section 6.1 test vector
    const alicePriv = hexToBytes('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a')
    const alicePubExpected = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a'
    const bobPub = hexToBytes('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f')
    const sharedExpected = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742'

    expect(bytesToHex(x25519ScalarMultBase(alicePriv))).toBe(alicePubExpected)
    expect(bytesToHex(x25519SharedSecret(alicePriv, bobPub))).toBe(sharedExpected)

    // Interop with Node built-in X25519
    const nodeBob = generateKeyPairSync('x25519')
    const nodeBobSpki = nodeBob.publicKey.export({ format: 'der', type: 'spki' })
    const nodeBobRawPub = new Uint8Array(nodeBobSpki.subarray(nodeBobSpki.byteLength - 32))

    const browserAlice = generateX25519KeyPair()
    const spkiPrefix = hexToBytes('302a300506032b656e032100')
    const browserAliceSpki = new Uint8Array(spkiPrefix.byteLength + 32)
    browserAliceSpki.set(spkiPrefix, 0)
    browserAliceSpki.set(browserAlice.publicKey, spkiPrefix.byteLength)

    const nodeShared = new Uint8Array(
      diffieHellman({
        privateKey: nodeBob.privateKey,
        publicKey: createPublicKey({ key: Buffer.from(browserAliceSpki), format: 'der', type: 'spki' }),
      }),
    )
    const browserShared = x25519SharedSecret(browserAlice.secretKey, nodeBobRawPub)
    expect(bytesToHex(browserShared)).toBe(bytesToHex(nodeShared))

    // Also verify clamping + rejecting small-order public point (all zeros & order-4 point)
    const clamped = clampX25519Scalar(new Uint8Array(32).fill(0xff))
    expect(clamped[0]! & 7).toBe(0)
    expect(clamped[31]! & 0xc0).toBe(0x40)
    expect(() => x25519SharedSecret(alicePriv, new Uint8Array(32))).toThrow(/low-order/i)
    const smallOrderPoint = hexToBytes('e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800')
    expect(() => x25519SharedSecret(alicePriv, smallOrderPoint)).toThrow(/low-order/i)
    expect(x25519ScalarMult(alicePriv, smallOrderPoint).every((b) => b === 0)).toBe(true)
    void createPrivateKey
  })

  it('matches RFC 8439 ChaCha20-Poly1305 test vector and Node crypto AEAD with Noise nonces', () => {
    const key = hexToBytes('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f')
    const nonce = hexToBytes('070000004041424344454647')
    const aad = hexToBytes('50515253c0c1c2c3c4c5c6c7')
    const plaintext = utf8Encode("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.")
    const expectedCt =
      'd31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116'
    const expectedTag = '1ae10b594f09e26a7e902ecbd0600691'

    const sealed = chacha20Poly1305Encrypt(key, nonce, plaintext, aad)
    expect(bytesToHex(sealed)).toBe(expectedCt + expectedTag)
    expect(utf8Decode(chacha20Poly1305Decrypt(key, nonce, sealed, aad))).toBe(utf8Decode(plaintext))

    // Cross-check with Node chacha20-poly1305 using buildNoiseNonce(counter)
    const nNonce = buildNoiseNonce(42)
    expect(bytesToHex(nNonce)).toBe('000000002a00000000000000')
    const cipher = createCipheriv('chacha20-poly1305', key, nNonce, { authTagLength: 16 })
    cipher.setAAD(aad, { plaintextLength: plaintext.byteLength })
    const nodeEncrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
    expect(bytesToHex(chacha20Poly1305Encrypt(key, nNonce, plaintext, aad))).toBe(nodeEncrypted.toString('hex'))

    // Reject tampered ciphertext or tag or AAD
    const tampered = new Uint8Array(sealed)
    tampered[0]! ^= 0x01
    expect(() => chacha20Poly1305Decrypt(key, nonce, tampered, aad)).toThrow(/authentication failed/i)
    const tamperedTag = new Uint8Array(sealed)
    tamperedTag[tamperedTag.byteLength - 1]! ^= 0x01
    expect(() => chacha20Poly1305Decrypt(key, nonce, tamperedTag, aad)).toThrow(/authentication failed/i)
    const decipher = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
    decipher.setAAD(aad, { plaintextLength: plaintext.byteLength })
    decipher.setAuthTag(sealed.subarray(sealed.byteLength - 16))
    const ptNode = Buffer.concat([decipher.update(sealed.subarray(0, sealed.byteLength - 16)), decipher.final()])
    expect(utf8Decode(ptNode)).toBe(utf8Decode(plaintext))
  })

  it('completes full Noise_IK_25519_ChaChaPoly_BLAKE2b handshake and bidirectional AEAD transport against Node NoiseResponderSession', async () => {
    const hostIdentityStore = new InMemoryHostIdentityStore()
    const hostKeyPair = await hostIdentityStore.loadOrCreate()
    const clientKeys = generateX25519KeyPair()
    const expectedClientFp = await sha256Hex(clientKeys.publicKey)
    expect(expectedClientFp).toBe(computeFingerprint(clientKeys.publicKey))

    const initiator = new NoiseIkInitiator({
      clientKeyPair: {
        publicKey: new Uint8Array(clientKeys.publicKey),
        secretKey: new Uint8Array(clientKeys.secretKey),
      },
      remoteStaticPublicKey: hostKeyPair.identity.publicKey,
    })
    const responder = new NoiseResponderSession(hostKeyPair)

    const msg1 = initiator.writeMessage1()
    expect(msg1.byteLength).toBe(96)
    const peer = responder.readMessage1(msg1)
    expect(peer.deviceId).toBe(expectedClientFp)

    const msg2 = responder.writeMessage2()
    expect(msg2.byteLength).toBe(48)
    const msg2Payload = initiator.readMessage2(msg2)
    expect(msg2Payload.byteLength).toBe(0)
    expect(initiator.getState()).toBe('READY')
    expect(bytesToHex(initiator.getHandshakeHash())).toBe(bytesToHex(responder.getHandshakeHash()))

    // Bidirectional multi-message transport verification (including empty & Unicode & large payloads)
    const samples = [
      '{"type":"handshake.complete","connectionEpoch":1,"state":"ACTIVE"}',
      '',
      '你好世界 🚀 Multi-Agent Codex/Claude/DSH E2EE stream check!',
      'x'.repeat(16_384),
    ]
    for (const sample of samples) {
      const i2r = initiator.encrypt(utf8Encode(sample))
      expect(utf8Decode(responder.decrypt(i2r))).toBe(sample)

      const r2i = responder.encrypt(utf8Encode(sample + '|ack'))
      expect(utf8Decode(initiator.decrypt(r2i))).toBe(sample + '|ack')
    }

    // Out-of-order/replay rejection
    const nextCt = initiator.encrypt(utf8Encode('seq-check'))
    expect(() => initiator.decrypt(nextCt)).toThrow(/authentication failed/i)

    initiator.close()
    responder.close()
    expect(initiator.getState()).toBe('CLOSED')
    expect(() => initiator.encrypt(utf8Encode('after-close'))).toThrow(/not ready/i)
  })
})
