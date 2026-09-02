import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-ignore - noise-handshake/dh.js
import dh from 'noise-handshake/dh.js'
import {
  ChannelSecurityGate,
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

describe('R2A-R1 Noise Identity and Crypto Core Adversarial Tests', () => {
  it('1. exact crypto dependency version guard', () => {
    const pkgJsonPath = join(__dirname, '../package.json')
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(pkg.dependencies?.['noise-handshake']).toBe('4.2.0')
    expect(pkg.devDependencies?.['@types/noise-handshake']).toBe('3.0.3')
  })

  it('2. handshake hash equality and availability after completion', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const client = generateClientKeyPair()

    const initiator = new NoiseInitiatorSession(client, host.identity.publicKey)
    const responder = new NoiseResponderSession(host)

    // Handshake hash cannot be queried before handshake finishes
    expect(() => initiator.getHandshakeHash()).toThrow(RemoteCryptoError)
    expect(() => responder.getHandshakeHash()).toThrow(RemoteCryptoError)

    const msg1 = initiator.writeMessage1()
    responder.readMessage1(msg1)
    const msg2 = responder.writeMessage2()
    initiator.readMessage2(msg2)

    expect(initiator.getState()).toBe('AUTHENTICATED')
    expect(responder.getState()).toBe('AUTHENTICATED')

    const initHash = initiator.getHandshakeHash()
    const respHash = responder.getHandshakeHash()

    expect(initHash.length).toBe(64) // BLAKE2b HASHLEN
    expect(respHash.length).toBe(64)
    expect(Buffer.from(initHash).equals(Buffer.from(respHash))).toBe(true)
  })

  it('3. 32-bit transport nonce message ceiling fail closed', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const client = generateClientKeyPair()

    const initiator = new NoiseInitiatorSession(client, host.identity.publicKey)
    const responder = new NoiseResponderSession(host)

    const msg1 = initiator.writeMessage1()
    responder.readMessage1(msg1)
    const msg2 = responder.writeMessage2()
    initiator.readMessage2(msg2)

    // Limit test ceiling to 3 messages
    initiator.setMaxMessagesForTest(3)
    responder.setMaxMessagesForTest(3)

    const p = new TextEncoder().encode('msg')
    // Messages 1, 2, 3
    const ct1 = initiator.encrypt(p)
    responder.decrypt(ct1)
    const ct2 = initiator.encrypt(p)
    responder.decrypt(ct2)
    const ct3 = initiator.encrypt(p)
    responder.decrypt(ct3)

    // 4th message reaches ceiling -> must fail closed
    expect(() => {
      initiator.encrypt(p)
    }).toThrow(RemoteCryptoError)

    try {
      initiator.encrypt(p)
    } catch (err: unknown) {
      expect((err as RemoteCryptoError).code).toBe('NONCE_EXHAUSTED')
    }
  })

  it('4. revoked device cannot be restored by trust()', async () => {
    const trustStore = new InMemoryDeviceTrustStore()
    const clientKey = generateClientKeyPair().publicKey
    const domainId = 'domain-1'

    const record = await trustStore.trust({
      staticPublicKey: clientKey,
      displayName: 'Phone',
      grantedCapabilities: ['observe'],
      trustDomainId: domainId,
    })

    await trustStore.revoke(record.deviceId)
    const revoked = await trustStore.get(record.deviceId)
    expect(revoked?.revokedAt).toBeDefined()

    // Calling trust() again on the revoked device MUST fail closed
    await expect(
      trustStore.trust({
        staticPublicKey: clientKey,
        displayName: 'Phone New Pairing',
        grantedCapabilities: ['observe'],
        trustDomainId: domainId,
      }),
    ).rejects.toThrow(RemoteCryptoError)

    // Only explicit admin re-enrollment can clear revocation
    const reEnrolled = await trustStore.adminReEnroll({
      deviceId: record.deviceId,
      displayName: 'Phone Admin Recovered',
      grantedCapabilities: ['observe', 'prompt'],
      trustDomainId: domainId,
    })
    expect(reEnrolled.revokedAt).toBeUndefined()
    expect(reEnrolled.displayName).toBe('Phone Admin Recovered')
  })

  it('5. Host rotation invalidates trust domain and fails closed', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host1 = await hostStore.loadOrCreate()
    const domain1 = host1.identity.trustDomainId

    const trustStore = new InMemoryDeviceTrustStore()
    const clientKey = generateClientKeyPair().publicKey

    const record = await trustStore.trust({
      staticPublicKey: clientKey,
      displayName: 'Dev Machine',
      grantedCapabilities: ['observe', 'prompt'],
      trustDomainId: domain1,
    })

    // Before rotation: authorized
    await expect(trustStore.assertAuthorized(record.deviceId, domain1)).resolves.toBeDefined()

    // Host rotates identity -> domain 2
    const host2 = await hostStore.rotate()
    const domain2 = host2.identity.trustDomainId
    expect(domain2).not.toBe(domain1)

    // Old device in domain 1 is immediately rejected by Host with TRUST_DOMAIN_STALE
    await expect(trustStore.assertAuthorized(record.deviceId, domain2)).rejects.toThrow(
      RemoteCryptoError,
    )
  })

  it('6. unpaired authenticated channel cannot call application RPC', async () => {
    const trustStore = new InMemoryDeviceTrustStore()
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()

    const gate = new ChannelSecurityGate('dev-unpaired', host.identity.trustDomainId, trustStore)

    // Channel just authenticated with Noise IK, but device is not in trustStore
    const state = await gate.evaluate()
    expect(state).toBe('PAIRING_PENDING')

    // Calling application RPC while in PAIRING_PENDING must be blocked
    expect(() => {
      gate.assertCanDispatchRpc('session.list')
    }).toThrow(RemoteCryptoError)

    try {
      gate.assertCanDispatchRpc('prompt.submit')
    } catch (err: unknown) {
      expect((err as RemoteCryptoError).code).toBe('UNAUTHORIZED_CHANNEL')
    }
  })

  it('7. HostKeyPair prevents secret leak via JSON.stringify, spread, inspect, String', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const rawSecretHex = Buffer.from(host.secretKey).toString('hex')

    // 1. JSON.stringify
    const json = JSON.stringify(host)
    expect(json).not.toContain(rawSecretHex)
    const parsed = JSON.parse(json) as { identity: { fingerprint: string; trustDomainId: string } }; expect(parsed.identity.fingerprint).toBe(host.identity.fingerprint); expect(parsed.identity.trustDomainId).toBe(host.identity.trustDomainId)

    // 2. Object spread
    const spread = { ...host }
    expect(Object.keys(spread)).toEqual(['identity'])
    expect((spread as Record<string, unknown>).secretKey).toBeUndefined()

    // 3. util.inspect
    expect(String(host)).toContain('[REDACTED]')
    expect(String(host)).not.toContain(rawSecretHex)

    // 4. Secret key still accessible to legitimate internal callers
    expect(host.secretKey.byteLength).toBe(32)
  })

  it('8. raw token absent from registry state and PairingToken leak proof', () => {
    const registry = new PairingTokenRegistry()
    const token = registry.createToken({ trustDomainId: 'dom-1' })
    const rawToken = token.token

    // Raw token must NOT exist as a key in registry map
    expect((registry as unknown as { tokens: Map<string, unknown> }).tokens.has(rawToken)).toBe(false)
    expect(
      (registry as unknown as { tokens: Map<string, unknown> }).tokens.has(token.tokenHash),
    ).toBe(true)

    // PairingToken spread leak test
    const spread = { ...token }
    expect((spread as Record<string, unknown>).rawToken).toBeUndefined()

    // PairingToken JSON leak test
    const json = JSON.stringify(token)
    expect(json).not.toContain(rawToken)

    // String / inspect redaction
    expect(String(token)).toContain('[REDACTED]')
    expect(String(token)).not.toContain(rawToken)
  })

  it('9. uniform external token failure (no status leakage)', () => {
    let now = 1000
    const registry = new PairingTokenRegistry(16, 5000, { clock: () => now })
    const token = registry.createToken({ trustDomainId: 'dom-1' })

    // Non-existent token
    const res1 = registry.verifyCandidate({
      rawToken: 'nonexistent-token',
      clientDeviceId: 'dev-1',
      clientDisplayName: 'Client 1',
      currentTrustDomainId: 'dom-1',
    })
    expect(res1.ok).toBe(false)
    if (!res1.ok) expect(res1.error.code).toBe('PAIRING_FAILED')

    // Expired token
    now += 10000
    const res2 = registry.verifyCandidate({
      rawToken: token.token,
      clientDeviceId: 'dev-1',
      clientDisplayName: 'Client 1',
      currentTrustDomainId: 'dom-1',
    })
    expect(res2.ok).toBe(false)
    if (!res2.ok) expect(res2.error.code).toBe('PAIRING_FAILED')

    // Error messages are identical
    if (!res1.ok && !res2.ok) {
      expect(res1.error.message).toBe(res2.error.message)
    }
  })

  it('10. pairing requires explicit Host confirmation and least-privilege default', async () => {
    const registry = new PairingTokenRegistry()
    // Default capabilities must be least-privilege 'observe'
    const token = registry.createToken({ trustDomainId: 'dom-1' })
    expect(token.allowedCapabilities).toEqual(['observe'])

    const candidateRes = registry.verifyCandidate({
      rawToken: token.token,
      clientDeviceId: 'dev-1',
      clientDisplayName: 'New Device',
      currentTrustDomainId: 'dom-1',
    })
    expect(candidateRes.ok).toBe(true)
    if (!candidateRes.ok) return

    const candidate = candidateRes.candidate

    // Attempting to grant capability exceeding token permission fails
    const escalateRes = registry.confirmCandidate({
      candidateId: candidate.candidateId,
      confirmedCapabilities: ['observe', 'approve'],
    })
    expect(escalateRes.ok).toBe(false)

    // Legitimate confirmation within allowed bounds succeeds
    const confirmRes = registry.confirmCandidate({
      candidateId: candidate.candidateId,
      confirmedCapabilities: ['observe'],
    })
    expect(confirmRes.ok).toBe(true)
    if (confirmRes.ok) {
      expect(confirmRes.grantedCapabilities).toEqual(['observe'])
    }
  })

  it('11. ConnectionEpochAllocator fails closed on exhaustion', () => {
    const allocator = new ConnectionEpochAllocator(Number.MAX_SAFE_INTEGER - 1)
    expect(allocator.allocateNext()).toBe(Number.MAX_SAFE_INTEGER)

    // Reaching capacity boundary must fail closed, NO WRAP TO 1
    expect(() => {
      allocator.allocateNext()
    }).toThrow(RemoteCryptoError)

    try {
      allocator.allocateNext()
    } catch (err: unknown) {
      expect((err as RemoteCryptoError).code).toBe('STATE_CAPACITY_EXCEEDED')
    }
  })

  it('12. wrong Host static key fails closed', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const hostKeyPair = await hostStore.loadOrCreate()

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

  it('13. handshake transcript tamper fails', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const hostKeyPair = await hostStore.loadOrCreate()
    const clientKeyPair = generateClientKeyPair()

    const initiator = new NoiseInitiatorSession(clientKeyPair, hostKeyPair.identity.publicKey)
    const responder = new NoiseResponderSession(hostKeyPair)

    const msg1 = initiator.writeMessage1()
    msg1[12] = (msg1[12] ?? 0) ^ 0xff

    expect(() => {
      responder.readMessage1(msg1)
    }).toThrow(RemoteCryptoError)
  })

  it('14. ciphertext bit flip fails', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const hostKeyPair = await hostStore.loadOrCreate()
    const clientKeyPair = generateClientKeyPair()

    const initiator = new NoiseInitiatorSession(clientKeyPair, hostKeyPair.identity.publicKey)
    const responder = new NoiseResponderSession(hostKeyPair)

    const msg1 = initiator.writeMessage1()
    responder.readMessage1(msg1)
    const msg2 = responder.writeMessage2()
    initiator.readMessage2(msg2)

    const ciphertext = initiator.encrypt(new TextEncoder().encode('payload'))
    ciphertext[2] = (ciphertext[2] ?? 0) ^ 0x01

    expect(() => {
      responder.decrypt(ciphertext)
    }).toThrow(RemoteCryptoError)
  })

  it('15. pre-auth application payload is blocked', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const hostKeyPair = await hostStore.loadOrCreate()
    const clientKeyPair = generateClientKeyPair()

    const initiator = new NoiseInitiatorSession(clientKeyPair, hostKeyPair.identity.publicKey)
    expect(() => {
      initiator.encrypt(new TextEncoder().encode('blocked'))
    }).toThrow(RemoteCryptoError)
  })

  it('16. duplicate handshake message throws HANDSHAKE_STATE_INVALID', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const hostKeyPair = await hostStore.loadOrCreate()
    const clientKeyPair = generateClientKeyPair()

    const initiator = new NoiseInitiatorSession(clientKeyPair, hostKeyPair.identity.publicKey)
    initiator.writeMessage1()
    expect(() => {
      initiator.writeMessage1()
    }).toThrow(RemoteCryptoError)
  })

  it('17. invalid handshake state transition throws', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const hostKeyPair = await hostStore.loadOrCreate()
    const responder = new NoiseResponderSession(hostKeyPair)
    expect(() => {
      responder.writeMessage2()
    }).toThrow(RemoteCryptoError)
  })

  it('18. capability escalation denied at policy engine', async () => {
    const { seams } = fakeSeams()
    const core = new RemoteAdapterCore(seams)

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

  it('19. bounded device and token registries fail closed', async () => {
    const trustStore = new InMemoryDeviceTrustStore(1)
    await trustStore.trust({
      staticPublicKey: generateClientKeyPair().publicKey,
      displayName: 'Dev 1',
      grantedCapabilities: ['observe'],
      trustDomainId: 'dom-1',
    })
    await expect(
      trustStore.trust({
        staticPublicKey: generateClientKeyPair().publicKey,
        displayName: 'Dev 2',
        grantedCapabilities: ['observe'],
        trustDomainId: 'dom-1',
      }),
    ).rejects.toThrow(RemoteCryptoError)

    const tokenRegistry = new PairingTokenRegistry(1)
    tokenRegistry.createToken({ trustDomainId: 'dom-1' })
    expect(() => {
      tokenRegistry.createToken({ trustDomainId: 'dom-1' })
    }).toThrow(RemoteCryptoError)
  })

  it('20. same R1 idempotency key survives transport reconnect with fresh epoch', async () => {
    const { seams, calls } = fakeSeams()
    const core = new RemoteAdapterCore(seams)

    core.devices.trust('dev-client', ['observe', 'prompt'])

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

    const peerEpoch2: AuthenticatedPeer = {
      deviceId: 'dev-client',
      connectionEpoch: 2,
    }

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
    expect(calls.followup).toBe(1)
    expect(res2).toEqual({ sessionId: 's1', prompt: 'hello reconnect', turnId: 't1' })
  })
})
