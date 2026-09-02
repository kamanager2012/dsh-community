import { describe, expect, it } from 'vitest'
// @ts-ignore - noise-handshake/dh.js
import dh from 'noise-handshake/dh.js'
import {
  ConnectionEpochAllocator,
  InMemoryDeviceTrustStore,
  InMemoryHostIdentityStore,
  NoiseInitiatorSession,
  NoiseResponderSession,
  PairingTokenRegistry,
  RemoteAdapterCore,
  RemoteCryptoError,
  RemoteProtocolError,
  computeFingerprint,
  type AuthenticatedPeer,
  type Capability,
  type HostKeyPair,
  type OfficialRemoteSeams,
  type RemoteRequest,
} from '../src/index.ts'

interface DhModule {
  generateKeyPair(): {
    publicKey: Buffer
    secretKey: Buffer
  }
}

const dhHelper: DhModule =
  (dh as unknown as { default?: DhModule }).default ?? (dh as unknown as DhModule)

function generateClientKeyPair() {
  const raw = dhHelper.generateKeyPair()
  return {
    publicKey: new Uint8Array(raw.publicKey),
    secretKey: new Uint8Array(raw.secretKey),
  }
}

function fakeSeams() {
  const calls = {
    followup: 0,
    approval: 0,
    question: 0,
  }
  const seams: OfficialRemoteSeams = {
    async listSessions() {
      return [{ id: 's1', title: 'Session One' }]
    },
    async assertSession(sessionId) {
      if (sessionId !== 's1') throw new Error('missing session')
    },
    async followup(sessionId, prompt) {
      calls.followup += 1
      return { sessionId, prompt, turnId: `t${calls.followup}` }
    },
    async respondApproval(callId, decision) {
      calls.approval += 1
      return { callId, decision }
    },
    async respondQuestion(questionId, answer) {
      calls.question += 1
      return { questionId, answer }
    },
  }
  return { seams, calls }
}

describe('R2A Noise Identity and Crypto Core Adversarial Tests', () => {
  it('1. valid first pairing', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const hostKeyPair = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const tokenRegistry = new PairingTokenRegistry()

    const token = tokenRegistry.createToken({
      allowedCapabilities: ['observe', 'prompt'],
    })

    const clientKeyPair = generateClientKeyPair()
    const initiator = new NoiseInitiatorSession(clientKeyPair, hostKeyPair.identity.publicKey)
    const responder = new NoiseResponderSession(hostKeyPair)

    const msg1 = initiator.writeMessage1()
    const peerMeta = responder.readMessage1(msg1)
    expect(peerMeta.deviceId).toBe(computeFingerprint(clientKeyPair.publicKey))

    const msg2 = responder.writeMessage2()
    initiator.readMessage2(msg2)

    expect(initiator.getState()).toBe('AUTHENTICATED')
    expect(responder.getState()).toBe('AUTHENTICATED')

    // Client sends encrypted pairing request
    const pairingPayload = JSON.stringify({
      token: token.token,
      displayName: 'Pixel 9 Pro',
    })
    const encryptedPairing = initiator.encrypt(new TextEncoder().encode(pairingPayload))

    // Host receives, decrypts, and consumes token
    const decryptedPayload = responder.decrypt(encryptedPairing)
    const pairingData = JSON.parse(new TextDecoder().decode(decryptedPayload)) as {
      token: string
      displayName: string
    }

    const consumption = tokenRegistry.consume(pairingData.token)
    expect(consumption.ok).toBe(true)
    if (consumption.ok) {
      const record = await trustStore.trust({
        staticPublicKey: peerMeta.staticPublicKey,
        displayName: pairingData.displayName,
        grantedCapabilities: consumption.capabilities,
      })
      expect(record.deviceId).toBe(peerMeta.deviceId)
      expect(Array.from(record.grantedCapabilities)).toEqual(['observe', 'prompt'])
    }
  })

  it('2. wrong Host static key fails closed', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const hostKeyPair = await hostStore.loadOrCreate()

    // Client uses an incorrect Host static key
    const wrongHostKey = new Uint8Array(32)
    wrongHostKey.fill(0xee)

    const clientKeyPair = generateClientKeyPair()
    const initiator = new NoiseInitiatorSession(clientKeyPair, wrongHostKey)
    const responder = new NoiseResponderSession(hostKeyPair)

    const msg1 = initiator.writeMessage1()

    expect(() => {
      responder.readMessage1(msg1)
    }).toThrow(RemoteCryptoError)
  })

  it('3. expired pairing token', () => {
    let now = 1000
    const registry = new PairingTokenRegistry(16, 5000, { clock: () => now })
    const token = registry.createToken({ ttlMs: 3000 })

    now += 4000 // Advance past expiry
    const result = registry.consume(token.token)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('PAIRING_TOKEN_EXPIRED')
    }
  })

  it('4. reused pairing token', () => {
    const registry = new PairingTokenRegistry()
    const token = registry.createToken()

    const first = registry.consume(token.token)
    expect(first.ok).toBe(true)

    const second = registry.consume(token.token)
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.code).toBe('PAIRING_TOKEN_INVALID')
    }
  })

  it('5. concurrent pairing-token consume', async () => {
    const registry = new PairingTokenRegistry()
    const token = registry.createToken()

    // Run parallel consumption promises
    const [res1, res2] = await Promise.all([
      Promise.resolve().then(() => registry.consume(token.token)),
      Promise.resolve().then(() => registry.consume(token.token)),
    ])

    const successCount = [res1, res2].filter((r) => r.ok).length
    const failCount = [res1, res2].filter((r) => !r.ok).length

    expect(successCount).toBe(1)
    expect(failCount).toBe(1)
  })

  it('6. unknown device is rejected', async () => {
    const trustStore = new InMemoryDeviceTrustStore()
    const clientKey = generateClientKeyPair().publicKey
    const device = await trustStore.findByPublicKey(clientKey)
    expect(device).toBeUndefined()
  })

  it('7. revoked device fails closed', async () => {
    const trustStore = new InMemoryDeviceTrustStore()
    const clientKey = generateClientKeyPair().publicKey
    const record = await trustStore.trust({
      staticPublicKey: clientKey,
      displayName: 'Test Client',
      grantedCapabilities: ['observe'],
    })

    expect(record.revokedAt).toBeUndefined()
    const revoked = await trustStore.revoke(record.deviceId)
    expect(revoked).toBe(true)

    const updated = await trustStore.get(record.deviceId)
    expect(updated?.revokedAt).toBeDefined()

    // Reconnecting does not restore revoked status
    await trustStore.recordSeen(record.deviceId)
    const rechecked = await trustStore.get(record.deviceId)
    expect(rechecked?.revokedAt).toBeDefined()
  })

  it('8. handshake transcript tamper fails', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const hostKeyPair = await hostStore.loadOrCreate()
    const clientKeyPair = generateClientKeyPair()

    const initiator = new NoiseInitiatorSession(clientKeyPair, hostKeyPair.identity.publicKey)
    const responder = new NoiseResponderSession(hostKeyPair)

    const msg1 = initiator.writeMessage1()
    msg1[12] = (msg1[12] ?? 0) ^ 0xff // Bit flip in handshake message

    expect(() => {
      responder.readMessage1(msg1)
    }).toThrow(RemoteCryptoError)
  })

  it('9. ciphertext bit flip fails', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const hostKeyPair = await hostStore.loadOrCreate()
    const clientKeyPair = generateClientKeyPair()

    const initiator = new NoiseInitiatorSession(clientKeyPair, hostKeyPair.identity.publicKey)
    const responder = new NoiseResponderSession(hostKeyPair)

    const msg1 = initiator.writeMessage1()
    responder.readMessage1(msg1)
    const msg2 = responder.writeMessage2()
    initiator.readMessage2(msg2)

    const ciphertext = initiator.encrypt(new TextEncoder().encode('secure payload'))
    ciphertext[2] = (ciphertext[2] ?? 0) ^ 0x01 // Bit flip

    expect(() => {
      responder.decrypt(ciphertext)
    }).toThrow(RemoteCryptoError)
  })

  it('10. pre-auth application payload is blocked', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const hostKeyPair = await hostStore.loadOrCreate()
    const clientKeyPair = generateClientKeyPair()

    const initiator = new NoiseInitiatorSession(clientKeyPair, hostKeyPair.identity.publicKey)

    // Attempting to encrypt in NEW state throws
    expect(() => {
      initiator.encrypt(new TextEncoder().encode('pre-auth payload'))
    }).toThrow(RemoteCryptoError)
  })

  it('11. duplicate handshake message throws HANDSHAKE_STATE_INVALID', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const hostKeyPair = await hostStore.loadOrCreate()
    const clientKeyPair = generateClientKeyPair()

    const initiator = new NoiseInitiatorSession(clientKeyPair, hostKeyPair.identity.publicKey)
    initiator.writeMessage1()

    // Attempting to write Message 1 again in HANDSHAKING state throws
    expect(() => {
      initiator.writeMessage1()
    }).toThrow(RemoteCryptoError)
  })

  it('12. invalid handshake state transition throws', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const hostKeyPair = await hostStore.loadOrCreate()

    const responder = new NoiseResponderSession(hostKeyPair)

    // Attempting to write Message 2 before reading Message 1 throws
    expect(() => {
      responder.writeMessage2()
    }).toThrow(RemoteCryptoError)
  })

  it('13. reconnect creates fresh epoch', () => {
    const allocator = new ConnectionEpochAllocator()
    const epoch1 = allocator.allocateNext()
    const epoch2 = allocator.allocateNext()

    expect(epoch1).toBe(1)
    expect(epoch2).toBe(2)
    expect(epoch2).toBeGreaterThan(epoch1)
  })

  it('14. reconnect preserves device identity', async () => {
    const trustStore = new InMemoryDeviceTrustStore()
    const clientKeyPair = generateClientKeyPair()

    const record1 = await trustStore.trust({
      staticPublicKey: clientKeyPair.publicKey,
      displayName: 'Laptop',
      grantedCapabilities: ['observe', 'prompt'],
    })

    const found = await trustStore.findByPublicKey(clientKeyPair.publicKey)
    expect(found?.deviceId).toBe(record1.deviceId)
    expect(found?.displayName).toBe('Laptop')
  })

  it('15. capability escalation denied', async () => {
    const { seams } = fakeSeams()
    const core = new RemoteAdapterCore(seams)

    // Device trusted ONLY with observe capability
    core.devices.trust('dev-observe-only', ['observe'])

    const peer: AuthenticatedPeer = {
      deviceId: 'dev-observe-only',
      connectionEpoch: 1,
    }

    const mutatingRequest: RemoteRequest = {
      jsonrpc: '2.0',
      id: 'req-1',
      protocolVersion: 1,
      connectionEpoch: 1,
      requestSeq: 1,
      method: 'prompt.submit',
      idempotencyKey: 'ik-escalate',
      params: { sessionId: 's1', prompt: 'escalate' },
    }

    await expect(core.handle(peer, mutatingRequest)).rejects.toThrow(RemoteProtocolError)
  })

  it('16. Host key rotation invalidates old Host fingerprint trust', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host1 = await hostStore.loadOrCreate()
    const initialFingerprint = host1.identity.fingerprint

    const clientKeyPair = generateClientKeyPair()
    // Client configured with Host 1 public key
    const initiator = new NoiseInitiatorSession(clientKeyPair, host1.identity.publicKey)

    // Host rotates identity
    const host2 = await hostStore.rotate()
    expect(host2.identity.fingerprint).not.toBe(initialFingerprint)

    const responder = new NoiseResponderSession(host2)
    const msg1 = initiator.writeMessage1()

    // Host 2 cannot decrypt message 1 encrypted to Host 1
    expect(() => {
      responder.readMessage1(msg1)
    }).toThrow(RemoteCryptoError)
  })

  it('17. bounded device registry', async () => {
    const trustStore = new InMemoryDeviceTrustStore(2)

    await trustStore.trust({
      staticPublicKey: generateClientKeyPair().publicKey,
      displayName: 'Dev 1',
      grantedCapabilities: ['observe'],
    })
    await trustStore.trust({
      staticPublicKey: generateClientKeyPair().publicKey,
      displayName: 'Dev 2',
      grantedCapabilities: ['observe'],
    })

    // Third device exceeds capacity
    await expect(
      trustStore.trust({
        staticPublicKey: generateClientKeyPair().publicKey,
        displayName: 'Dev 3',
        grantedCapabilities: ['observe'],
      }),
    ).rejects.toThrow(RemoteCryptoError)
  })

  it('18. bounded token registry', () => {
    const registry = new PairingTokenRegistry(2)

    registry.createToken()
    registry.createToken()

    expect(() => {
      registry.createToken()
    }).toThrow(RemoteCryptoError)
  })

  it('19. secrets/tokens absent from thrown error strings', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const registry = new PairingTokenRegistry()
    const token = registry.createToken()

    // Verify inspect redactions
    expect(String(host)).toContain('[REDACTED]')
    expect(String(host)).not.toContain(Buffer.from(host.secretKey).toString('hex'))

    expect(String(token)).toContain('[REDACTED]')
    expect(String(token)).not.toContain(token.token)

    // Verify error messages do not leak secrets
    try {
      const wrongKey = new Uint8Array(32).fill(0xaa)
      const initiator = new NoiseInitiatorSession(generateClientKeyPair(), wrongKey)
      const responder = new NoiseResponderSession(host)
      responder.readMessage1(initiator.writeMessage1())
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).not.toContain(Buffer.from(host.secretKey).toString('hex'))
      expect(msg).not.toContain(token.token)
    }
  })

  it('20. same R1 idempotency key survives transport reconnect', async () => {
    const { seams, calls } = fakeSeams()
    const core = new RemoteAdapterCore(seams)

    core.devices.trust('dev-client', ['observe', 'prompt'])

    // First connection (epoch 1)
    const peerEpoch1: AuthenticatedPeer = {
      deviceId: 'dev-client',
      connectionEpoch: 1,
    }

    const reqEpoch1: RemoteRequest = {
      jsonrpc: '2.0',
      id: 'req-1',
      protocolVersion: 1,
      connectionEpoch: 1,
      requestSeq: 1,
      method: 'prompt.submit',
      idempotencyKey: 'ik-survive-reconnect',
      params: { sessionId: 's1', prompt: 'hello reconnect' },
    }

    const res1 = await core.handle(peerEpoch1, reqEpoch1)
    expect(calls.followup).toBe(1)
    expect(res1).toEqual({ sessionId: 's1', prompt: 'hello reconnect', turnId: 't1' })

    // Transport reconnects (epoch 2)
    const peerEpoch2: AuthenticatedPeer = {
      deviceId: 'dev-client',
      connectionEpoch: 2,
    }

    // Client resubmits prompt with same idempotency key and payload on epoch 2
    const reqEpoch2: RemoteRequest = {
      jsonrpc: '2.0',
      id: 'req-2',
      protocolVersion: 1,
      connectionEpoch: 2,
      requestSeq: 1,
      method: 'prompt.submit',
      idempotencyKey: 'ik-survive-reconnect',
      params: { sessionId: 's1', prompt: 'hello reconnect' },
    }

    const res2 = await core.handle(peerEpoch2, reqEpoch2)
    // Cached response returned, followup was NOT called again
    expect(calls.followup).toBe(1)
    expect(res2).toEqual({ sessionId: 's1', prompt: 'hello reconnect', turnId: 't1' })
  })
})
