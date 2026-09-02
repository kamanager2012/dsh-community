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
  MAX_PAIRING_TTL_MS,
  MAX_TRANSPORT_MESSAGES,
  NoiseInitiatorSession,
  NoiseResponderSession,
  PairingCoordinator,
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
    listSessions: 0,
    followup: 0,
    approval: 0,
    question: 0,
    assertSession: 0,
  }
  const seams: OfficialRemoteSeams = {
    async listSessions() {
      calls.listSessions += 1
      return [{ id: 's1', title: 'Session One' }]
    },
    async assertSession(sessionId) {
      calls.assertSession += 1
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

describe('R2A-R2 Final Security Closure Adversarial Tests', () => {
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

    expect(() => initiator.getHandshakeHash()).toThrow(RemoteCryptoError)
    expect(() => responder.getHandshakeHash()).toThrow(RemoteCryptoError)

    const msg1 = initiator.writeMessage1()
    responder.readMessage1(msg1)
    const msg2 = responder.writeMessage2()
    initiator.readMessage2(msg2)

    expect(initiator.getState()).toBe('CHANNEL_AUTHENTICATED')
    expect(responder.getState()).toBe('CHANNEL_AUTHENTICATED')

    const initHash = initiator.getHandshakeHash()
    const respHash = responder.getHandshakeHash()

    expect(initHash.length).toBe(64)
    expect(respHash.length).toBe(64)
    expect(Buffer.from(initHash).equals(Buffer.from(respHash))).toBe(true)
  })

  it('3. nonce ceiling cannot be raised above audited max and public API cannot disable it', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const client = generateClientKeyPair()

    // Public API has no mutator to modify ceiling
    const normalSession = new NoiseInitiatorSession(client, host.identity.publicKey)
    expect((normalSession as unknown as { setMaxMessagesForTest?: unknown }).setMaxMessagesForTest).toBeUndefined()

    // Injection above MAX_TRANSPORT_MESSAGES is strictly rejected
    expect(() => {
      new NoiseInitiatorSession(client, host.identity.publicKey, new Uint8Array(0), {
        maxMessages: MAX_TRANSPORT_MESSAGES + 1,
      })
    }).toThrow(RemoteCryptoError)

    expect(() => {
      new NoiseInitiatorSession(client, host.identity.publicKey, new Uint8Array(0), {
        maxMessages: Infinity,
      })
    }).toThrow(RemoteCryptoError)

    expect(() => {
      new NoiseInitiatorSession(client, host.identity.publicKey, new Uint8Array(0), {
        maxMessages: 0,
      })
    }).toThrow(RemoteCryptoError)
  })

  it('4. 32-bit transport nonce message ceiling fail closed', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const client = generateClientKeyPair()

    // Inject low valid limit via constructor options
    const initiator = new NoiseInitiatorSession(client, host.identity.publicKey, new Uint8Array(0), {
      maxMessages: 3,
    })
    const responder = new NoiseResponderSession(host, new Uint8Array(0), {
      maxMessages: 3,
    })

    const msg1 = initiator.writeMessage1()
    responder.readMessage1(msg1)
    const msg2 = responder.writeMessage2()
    initiator.readMessage2(msg2)

    const p = new TextEncoder().encode('msg')
    // Messages 1, 2, 3 succeed
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

    expect(initiator.getState()).toBe('CLOSED')
  })

  it('5. ciphertext auth failure closes session and post-failure crypto is denied', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const client = generateClientKeyPair()

    const initiator = new NoiseInitiatorSession(client, host.identity.publicKey)
    const responder = new NoiseResponderSession(host)

    const msg1 = initiator.writeMessage1()
    responder.readMessage1(msg1)
    const msg2 = responder.writeMessage2()
    initiator.readMessage2(msg2)

    const ciphertext = initiator.encrypt(new TextEncoder().encode('secret message'))
    // Tamper with ciphertext bit
    ciphertext[2] = (ciphertext[2] ?? 0) ^ 0x01

    // Decrypting tampered ciphertext must throw CIPHERTEXT_INVALID
    expect(() => {
      responder.decrypt(ciphertext)
    }).toThrow(RemoteCryptoError)

    // State MUST transition to CLOSED
    expect(responder.getState()).toBe('CLOSED')

    // Subsequent decrypt must be rejected (cannot reuse corrupted session)
    expect(() => {
      responder.decrypt(ciphertext)
    }).toThrow(RemoteCryptoError)

    // Subsequent encrypt on responder must also be rejected
    expect(() => {
      responder.encrypt(new TextEncoder().encode('next'))
    }).toThrow(RemoteCryptoError)
  })

  it('6. real dispatch path blocks revoked device and OfficialRemoteSeams remains untouched', async () => {
    const { seams, calls } = fakeSeams()
    const core = new RemoteAdapterCore(seams, { currentTrustDomainId: 'domain-1' })

    const peer: AuthenticatedPeer = {
      deviceId: 'dev-revoked-test',
      connectionEpoch: 1,
    }

    core.devices.trust(peer.deviceId, ['prompt', 'observe'])
    // Revoke device in the single authoritative trust store
    core.devices.revoke(peer.deviceId)

    const req: RemoteRequest = {
      jsonrpc: '2.0',
      id: 'req-1',
      protocolVersion: 1,
      connectionEpoch: 1,
      requestSeq: 1,
      method: 'prompt.submit',
      idempotencyKey: 'ik-revoked',
      params: { sessionId: 's1', prompt: 'test' },
    }

    await expect(core.handle(peer, req)).rejects.toThrow(RemoteProtocolError)

    // OfficialRemoteSeams call count MUST BE 0!
    expect(calls.followup).toBe(0)
    expect(calls.approval).toBe(0)
    expect(calls.question).toBe(0)
    expect(calls.listSessions).toBe(0)
    expect(calls.assertSession).toBe(0)
  })

  it('7. real dispatch path blocks stale trust domain and OfficialRemoteSeams remains untouched', async () => {
    const { seams, calls } = fakeSeams()
    // Core is in domain-2
    const core = new RemoteAdapterCore(seams, { currentTrustDomainId: 'domain-2' })

    const peer: AuthenticatedPeer = {
      deviceId: 'dev-stale-domain-test',
      connectionEpoch: 1,
    }

    // Device was paired under domain-1
    core.devices.trust(peer.deviceId, ['prompt', 'observe'], { trustDomainId: 'domain-1' })

    const req: RemoteRequest = {
      jsonrpc: '2.0',
      id: 'req-1',
      protocolVersion: 1,
      connectionEpoch: 1,
      requestSeq: 1,
      method: 'prompt.submit',
      idempotencyKey: 'ik-stale',
      params: { sessionId: 's1', prompt: 'test' },
    }

    await expect(core.handle(peer, req)).rejects.toThrow(RemoteProtocolError)

    // OfficialRemoteSeams call count MUST BE 0!
    expect(calls.followup).toBe(0)
    expect(calls.approval).toBe(0)
    expect(calls.question).toBe(0)
    expect(calls.listSessions).toBe(0)
    expect(calls.assertSession).toBe(0)
  })

  it('8. candidate expires between verify and confirm', async () => {
    let now = 1000
    const hostStore = new InMemoryHostIdentityStore({ clock: () => now })
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore(128, { clock: () => now })
    const tokenRegistry = new PairingTokenRegistry(16, 5000, 5000, { clock: () => now })
    const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry, { clock: () => now })

    const token = tokenRegistry.createToken({
      trustDomainId: host.identity.trustDomainId,
      hostGeneration: host.identity.generation,
      ttlMs: 5000,
    })

    const client = generateClientKeyPair()
    const initiator = new NoiseInitiatorSession(client, host.identity.publicKey)
    const responder = new NoiseResponderSession(host)

    const msg1 = initiator.writeMessage1()
    responder.readMessage1(msg1)
    const msg2 = responder.writeMessage2()
    initiator.readMessage2(msg2)

    // Verify candidate before expiry
    const candidate = await coordinator.initiatePairing(responder, { token: token.token })
    expect(candidate.deviceId).toBe(computeFingerprint(client.publicKey))

    // Advance clock past expiry
    now += 10000

    // Confirm after expiry MUST fail and burn candidate/token
    await expect(
      coordinator.confirmPairing({
        candidateId: candidate.candidateId,
        grantedCapabilities: ['observe'],
      }),
    ).rejects.toThrow(RemoteCryptoError)

    // Verify candidate was burned
    expect(tokenRegistry.getCandidate(candidate.candidateId)).toBeUndefined()
  })

  it('9. Host rotates between verify and confirm', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host1 = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const tokenRegistry = new PairingTokenRegistry()
    const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry)

    const token = tokenRegistry.createToken({
      trustDomainId: host1.identity.trustDomainId,
      hostGeneration: host1.identity.generation,
    })

    const client = generateClientKeyPair()
    const initiator = new NoiseInitiatorSession(client, host1.identity.publicKey)
    const responder = new NoiseResponderSession(host1)

    const msg1 = initiator.writeMessage1()
    responder.readMessage1(msg1)
    const msg2 = responder.writeMessage2()
    initiator.readMessage2(msg2)

    const candidate = await coordinator.initiatePairing(responder, { token: token.token })

    // Host rotates identity in the background before confirmation!
    await hostStore.rotate()

    // Confirming old candidate must fail closed with TRUST_DOMAIN_STALE and burn candidate
    await expect(
      coordinator.confirmPairing({
        candidateId: candidate.candidateId,
        grantedCapabilities: ['observe'],
      }),
    ).rejects.toThrow(RemoteCryptoError)

    expect(tokenRegistry.getCandidate(candidate.candidateId)).toBeUndefined()
  })

  it('10. deviceId substitution attempt is prevented', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const tokenRegistry = new PairingTokenRegistry()
    const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry)

    const token = tokenRegistry.createToken({
      trustDomainId: host.identity.trustDomainId,
      hostGeneration: host.identity.generation,
    })

    const client = generateClientKeyPair()
    const initiator = new NoiseInitiatorSession(client, host.identity.publicKey)
    const responder = new NoiseResponderSession(host)

    const msg1 = initiator.writeMessage1()
    responder.readMessage1(msg1)
    const msg2 = responder.writeMessage2()
    initiator.readMessage2(msg2)

    // Attacker attempts to claim victim's deviceId
    const candidate = await coordinator.initiatePairing(responder, {
      token: token.token,
      claimedDeviceId: 'victim-device-id',
    })

    // PairingCandidate identity MUST match Noise rs, NOT claimedDeviceId!
    expect(candidate.deviceId).toBe(computeFingerprint(client.publicKey))
    expect(candidate.deviceId).not.toBe('victim-device-id')
  })

  it('11. pairing identity derived strictly from Noise static key', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const tokenRegistry = new PairingTokenRegistry()
    const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry)

    const token = tokenRegistry.createToken({
      trustDomainId: host.identity.trustDomainId,
      hostGeneration: host.identity.generation,
    })

    const client = generateClientKeyPair()
    const initiator = new NoiseInitiatorSession(client, host.identity.publicKey)
    const responder = new NoiseResponderSession(host)

    const msg1 = initiator.writeMessage1()
    responder.readMessage1(msg1)
    const msg2 = responder.writeMessage2()
    initiator.readMessage2(msg2)

    const candidate = await coordinator.initiatePairing(responder, { token: token.token })
    expect(candidate.remoteStaticPublicKey).toEqual(client.publicKey)
    expect(candidate.deviceId).toBe(computeFingerprint(client.publicKey))
  })

  it('12. Host confirm commits exact authenticated device', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const tokenRegistry = new PairingTokenRegistry()
    const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry)

    const token = tokenRegistry.createToken({
      trustDomainId: host.identity.trustDomainId,
      hostGeneration: host.identity.generation,
      allowedCapabilities: ['observe', 'prompt'],
    })

    const client = generateClientKeyPair()
    const initiator = new NoiseInitiatorSession(client, host.identity.publicKey)
    const responder = new NoiseResponderSession(host)

    const msg1 = initiator.writeMessage1()
    responder.readMessage1(msg1)
    const msg2 = responder.writeMessage2()
    initiator.readMessage2(msg2)

    const candidate = await coordinator.initiatePairing(responder, {
      token: token.token,
      displayName: 'Operator Laptop',
    })

    const result = await coordinator.confirmPairing({
      candidateId: candidate.candidateId,
      grantedCapabilities: ['observe', 'prompt'],
    })

    expect(result.channelState).toBe('DEVICE_AUTHORIZED')
    expect(result.device.deviceId).toBe(computeFingerprint(client.publicKey))
    expect(result.device.displayName).toBe('Operator Laptop')
    expect(result.device.grantedCapabilities.has('prompt')).toBe(true)

    // Stored in single authoritative trustStore
    const committed = await trustStore.get(result.device.deviceId)
    expect(committed).toBeDefined()
    expect(committed?.displayName).toBe('Operator Laptop')
  })

  it('13. failed trust commit has deterministic token/candidate rollback semantics', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    // Capacity of 1 device
    const trustStore = new InMemoryDeviceTrustStore(1)
    // Pre-fill trust store to capacity
    await trustStore.trust({
      staticPublicKey: generateClientKeyPair().publicKey,
      displayName: 'Existing Device',
      grantedCapabilities: ['observe'],
      trustDomainId: host.identity.trustDomainId,
    })

    const tokenRegistry = new PairingTokenRegistry()
    const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry)

    const token = tokenRegistry.createToken({
      trustDomainId: host.identity.trustDomainId,
      hostGeneration: host.identity.generation,
    })

    const client = generateClientKeyPair()
    const initiator = new NoiseInitiatorSession(client, host.identity.publicKey)
    const responder = new NoiseResponderSession(host)

    const msg1 = initiator.writeMessage1()
    responder.readMessage1(msg1)
    const msg2 = responder.writeMessage2()
    initiator.readMessage2(msg2)

    const candidate = await coordinator.initiatePairing(responder, { token: token.token })

    // Confirmation must fail because trust store is at capacity
    await expect(
      coordinator.confirmPairing({
        candidateId: candidate.candidateId,
        grantedCapabilities: ['observe'],
      }),
    ).rejects.toThrow(RemoteCryptoError)

    // Token and candidate MUST be cleanly burned (fail closed, no ghost state)
    expect(tokenRegistry.getCandidate(candidate.candidateId)).toBeUndefined()
    expect(tokenRegistry.size).toBe(0)
  })

  it('14. custom TTL invalid values rejected', async () => {
    const registry = new PairingTokenRegistry()

    expect(() => {
      registry.createToken({ trustDomainId: 'dom-1', hostGeneration: 1, ttlMs: 0 })
    }).toThrow(RemoteCryptoError)

    expect(() => {
      registry.createToken({ trustDomainId: 'dom-1', hostGeneration: 1, ttlMs: -500 })
    }).toThrow(RemoteCryptoError)

    expect(() => {
      registry.createToken({ trustDomainId: 'dom-1', hostGeneration: 1, ttlMs: 1.5 })
    }).toThrow(RemoteCryptoError)

    expect(() => {
      registry.createToken({
        trustDomainId: 'dom-1',
        hostGeneration: 1,
        ttlMs: MAX_PAIRING_TTL_MS + 1,
      })
    }).toThrow(RemoteCryptoError)
  })

  it('15. lockfile reviewed closure guard', () => {
    const lockfilePath = join(__dirname, '../../../pnpm-lock.yaml')
    const content = readFileSync(lockfilePath, 'utf8')

    // Ensure unrelated drift is NOT present
    expect(content).not.toContain('glob@7.2.0')
    expect(content).not.toContain('negotiator@1.1.0')
    expect(content).not.toContain('plist@3.1.1')
    expect(content).not.toContain('@xmldom/xmldom@0.9.12')

    // Ensure exact Noise closure is present
    expect(content).toContain('noise-handshake@4.2.0')
    expect(content).toContain('@types/noise-handshake@3.0.3')
  })

  it('16. revoked device cannot be restored by trust()', async () => {
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

    await expect(
      trustStore.trust({
        staticPublicKey: clientKey,
        displayName: 'Phone New Pairing',
        grantedCapabilities: ['observe'],
        trustDomainId: domainId,
      }),
    ).rejects.toThrow(RemoteCryptoError)

    const reEnrolled = await trustStore.adminReEnroll({
      deviceId: record.deviceId,
      displayName: 'Phone Admin Recovered',
      grantedCapabilities: ['observe', 'prompt'],
      trustDomainId: domainId,
    })
    expect(reEnrolled.revokedAt).toBeUndefined()
  })

  it('17. HostKeyPair prevents secret leak via JSON.stringify, spread, inspect, String', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const rawSecretHex = Buffer.from(host.secretKey).toString('hex')

    const json = JSON.stringify(host)
    expect(json).not.toContain(rawSecretHex)
    const parsed = JSON.parse(json) as { identity: { fingerprint: string; trustDomainId: string } }
    expect(parsed.identity.fingerprint).toBe(host.identity.fingerprint)

    const spread = { ...host }
    expect(Object.keys(spread)).toEqual(['identity'])
    expect((spread as Record<string, unknown>).secretKey).toBeUndefined()

    expect(String(host)).toContain('[REDACTED]')
    expect(String(host)).not.toContain(rawSecretHex)
  })

  it('18. raw token absent from registry state and PairingToken leak proof', () => {
    const registry = new PairingTokenRegistry()
    const token = registry.createToken({ trustDomainId: 'dom-1', hostGeneration: 1 })
    const rawToken = token.token

    expect((registry as unknown as { tokens: Map<string, unknown> }).tokens.has(rawToken)).toBe(false)
    expect(
      (registry as unknown as { tokens: Map<string, unknown> }).tokens.has(token.tokenHash),
    ).toBe(true)

    const spread = { ...token }
    expect((spread as Record<string, unknown>).rawToken).toBeUndefined()

    const json = JSON.stringify(token)
    expect(json).not.toContain(rawToken)

    expect(String(token)).toContain('[REDACTED]')
    expect(String(token)).not.toContain(rawToken)
  })

  it('19. ConnectionEpochAllocator fails closed on exhaustion', () => {
    const allocator = new ConnectionEpochAllocator(Number.MAX_SAFE_INTEGER - 1)
    expect(allocator.allocateNext()).toBe(Number.MAX_SAFE_INTEGER)

    expect(() => {
      allocator.allocateNext()
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
