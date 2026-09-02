import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-ignore - noise-handshake/dh.js
import dh from 'noise-handshake/dh.js'
import {
  ConnectionEpochAllocator,
  FileDeviceTrustStore,
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

describe('R2A-R3 Final Authority & Persistence Closure Adversarial Tests', () => {
  it('1. exact crypto dependency version guard', () => {
    const pkgJsonPath = join(__dirname, '../package.json')
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(pkg.dependencies?.['noise-handshake']).toBe('4.2.0')
    expect(pkg.devDependencies?.['@types/noise-handshake']).toBe('3.0.3')
  })

  it('2. P0-1: PairingCandidate defensive snapshot prevents authority mutation', async () => {
    let now = 1000
    const hostStore = new InMemoryHostIdentityStore({ clock: () => now })
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore(128, { clock: () => now })
    const tokenRegistry = new PairingTokenRegistry(16, 5000, 5000, { clock: () => now })
    const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry, { clock: () => now })

    // Sub-case A: approve is rejected despite snapshot mutation
    const tokenA = tokenRegistry.createToken({
      trustDomainId: host.identity.trustDomainId,
      hostGeneration: host.identity.generation,
      allowedCapabilities: ['observe'],
    })
    const clientA = generateClientKeyPair()
    const initA = new NoiseInitiatorSession(clientA, host.identity.publicKey)
    const respA = new NoiseResponderSession(host)
    const m1A = initA.writeMessage1()
    respA.readMessage1(m1A)
    const m2A = respA.writeMessage2()
    initA.readMessage2(m2A)
    const candidateA = await coordinator.initiatePairing(respA, { token: tokenA.token })
    try {
      (candidateA.maxAllowedCapabilities as string[]).push('approve')
    } catch {}
    await expect(
      coordinator.confirmPairing({
        candidateId: candidateA.candidateId,
        grantedCapabilities: ['observe', 'approve'],
      }),
    ).rejects.toThrow(RemoteCryptoError)

    // Sub-case B: Host rotation is still recognized despite tampering snapshot
    const tokenB = tokenRegistry.createToken({
      trustDomainId: host.identity.trustDomainId,
      hostGeneration: host.identity.generation,
    })
    const clientB = generateClientKeyPair()
    const initB = new NoiseInitiatorSession(clientB, host.identity.publicKey)
    const respB = new NoiseResponderSession(host)
    const m1B = initB.writeMessage1()
    respB.readMessage1(m1B)
    initB.readMessage2(respB.writeMessage2())
    const candidateB = await coordinator.initiatePairing(respB, { token: tokenB.token })
    try {
      (candidateB as any).trustDomainId = 'tampered'
      (candidateB as any).hostGeneration = 999
    } catch {}
    await hostStore.rotate()
    await expect(
      coordinator.confirmPairing({
        candidateId: candidateB.candidateId,
        grantedCapabilities: ['observe'],
      }),
    ).rejects.toThrow(RemoteCryptoError)

    // Sub-case C: Expiry is enforced according to original time, ignoring snapshot tampering
    const hostGen2 = await hostStore.getPublicIdentity()
    const tokenC = tokenRegistry.createToken({
      trustDomainId: hostGen2.trustDomainId,
      hostGeneration: hostGen2.generation,
      ttlMs: 5000,
    })
    const clientC = generateClientKeyPair()
    const initC = new NoiseInitiatorSession(clientC, hostGen2.publicKey)
    const respC = new NoiseResponderSession(await hostStore.loadOrCreate())
    const m1C = initC.writeMessage1()
    respC.readMessage1(m1C)
    initC.readMessage2(respC.writeMessage2())
    const candidateC = await coordinator.initiatePairing(respC, { token: tokenC.token })
    try {
      (candidateC as any).expiresAt = now + 1000000
    } catch {}
    now += 10000
    await expect(
      coordinator.confirmPairing({
        candidateId: candidateC.candidateId,
        grantedCapabilities: ['observe'],
      }),
    ).rejects.toThrow(RemoteCryptoError)

    // Sub-case D: Trust commit uses original static key despite remoteStaticPublicKey mutation
    const tokenD = tokenRegistry.createToken({
      trustDomainId: hostGen2.trustDomainId,
      hostGeneration: hostGen2.generation,
    })
    const clientD = generateClientKeyPair()
    const initD = new NoiseInitiatorSession(clientD, hostGen2.publicKey)
    const respD = new NoiseResponderSession(await hostStore.loadOrCreate())
    const m1D = initD.writeMessage1()
    respD.readMessage1(m1D)
    initD.readMessage2(respD.writeMessage2())
    const candidateD = await coordinator.initiatePairing(respD, { token: tokenD.token })
    candidateD.remoteStaticPublicKey.fill(0xee) // mutate view
    const resultD = await coordinator.confirmPairing({
      candidateId: candidateD.candidateId,
      grantedCapabilities: ['observe'],
    })
    expect(resultD.device.staticPublicKey).toEqual(clientD.publicKey)
    expect(resultD.device.deviceId).toBe(computeFingerprint(clientD.publicKey))
  })

  it('3. P0-2: DeviceTrustStore defensive snapshots prevent state corruption', async () => {
    const { seams } = fakeSeams()
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(seams, { trustStore, hostIdentityStore: hostStore })

    const client = generateClientKeyPair()
    const deviceId = computeFingerprint(client.publicKey)

    const record = await trustStore.trust({
      staticPublicKey: client.publicKey,
      displayName: 'Phone',
      grantedCapabilities: ['observe'],
      trustDomainId: host.identity.trustDomainId,
    })

    // Mutate returned snapshot
    try {
      ;(record.grantedCapabilities as Set<Capability>).add('prompt')
      record.staticPublicKey.fill(0xee)
      ;(record as any).revokedAt = Date.now()
    } catch {
      // Frozen
    }

    // Store internal state remains unaffected
    const recordFromGet = await trustStore.get(deviceId)
    expect(recordFromGet?.grantedCapabilities.has('prompt')).toBe(false)
    expect(recordFromGet?.staticPublicKey).toEqual(client.publicKey)
    expect(recordFromGet?.revokedAt).toBeUndefined()

    // Dispatching prompt.submit MUST fail because internal record lacks 'prompt'
    const peer: AuthenticatedPeer = { deviceId, connectionEpoch: 1 }
    const promptReq: RemoteRequest = {
      jsonrpc: '2.0',
      id: 'r1',
      method: 'prompt.submit',
      protocolVersion: 1,
      connectionEpoch: 1,
      requestSeq: 1,
      idempotencyKey: 'idem-1',
      params: { sessionId: 's1', prompt: 'test' },
    }

    await expect(core.handle(peer, promptReq)).rejects.toThrow(RemoteProtocolError)
  })

  it('4. P0-3: DeviceTrustStore rejects arbitrary deviceId bypass and enforces 32-byte key', async () => {
    const trustStore = new InMemoryDeviceTrustStore()

    // Rejects non-32 byte key
    await expect(
      trustStore.trust({
        staticPublicKey: new Uint8Array(16),
        displayName: 'Invalid Key Device',
        grantedCapabilities: ['observe'],
        trustDomainId: 'dom-1',
      }),
    ).rejects.toThrow(RemoteCryptoError)

    // Normal enrollment derives deviceId exclusively from fingerprint
    const key = generateClientKeyPair().publicKey
    const record = await trustStore.trust({
      staticPublicKey: key,
      displayName: 'Legit Device',
      grantedCapabilities: ['observe'],
      trustDomainId: 'dom-1',
    })

    expect(record.deviceId).toBe(computeFingerprint(key))
  })

  it('5. P0-4: Host rotation automatically invalidates Core authorization truth without manual sync', async () => {
    const { seams, calls } = fakeSeams()
    const hostStore = new InMemoryHostIdentityStore()
    const hostGen1 = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()

    const core = new RemoteAdapterCore(seams, {
      trustStore,
      hostIdentityStore: hostStore,
    })

    const client = generateClientKeyPair()
    const deviceId = computeFingerprint(client.publicKey)

    // Enroll device under Host generation 1
    core.devices.trust(client.publicKey, ['observe', 'prompt'], {
      trustDomainId: hostGen1.identity.trustDomainId,
    })

    const peer: AuthenticatedPeer = { deviceId, connectionEpoch: 1 }
    const req1: RemoteRequest = {
      jsonrpc: '2.0',
      id: 'req-1',
      protocolVersion: 1,
      connectionEpoch: 1,
      requestSeq: 1,
      method: 'prompt.submit',
      idempotencyKey: 'ik-1',
      params: { sessionId: 's1', prompt: 'hello gen1' },
    }

    // Step 1: Core.handle succeeds under Generation 1
    const res1 = await core.handle(peer, req1)
    expect(calls.followup).toBe(1)
    expect(res1).toEqual({ sessionId: 's1', prompt: 'hello gen1', turnId: 't1' })

    // Step 2: Host rotates identity (generation 1 -> 2)
    const hostGen2 = await hostStore.rotate()
    expect(hostGen2.identity.trustDomainId).not.toBe(hostGen1.identity.trustDomainId)

    // Step 3: Call Core.handle with same device WITHOUT modifying Core or manually syncing strings
    const req2: RemoteRequest = {
      jsonrpc: '2.0',
      id: 'req-2',
      protocolVersion: 1,
      connectionEpoch: 1,
      requestSeq: 2,
      method: 'prompt.submit',
      idempotencyKey: 'ik-2',
      params: { sessionId: 's1', prompt: 'hello gen2 should fail' },
    }

    // Step 4: Core must fail closed with TRUST_DOMAIN_STALE and call count must remain 1
    await expect(core.handle(peer, req2)).rejects.toThrow(RemoteProtocolError)
    expect(calls.followup).toBe(1)
  })

  it('6. P0-5: FileDeviceTrustStore persistence, restart parity, and corruption handling', async () => {
    const testDir = join(tmpdir(), `dsh-test-trust-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })
    const filePath = join(testDir, 'devices.json')

    try {
      const store1 = new FileDeviceTrustStore(filePath)
      const client1 = generateClientKeyPair()
      const client2 = generateClientKeyPair()

      // 1. Write devices
      const rec1 = store1.trustSync({
        staticPublicKey: client1.publicKey,
        displayName: 'Laptop',
        grantedCapabilities: ['observe', 'prompt'],
        trustDomainId: 'dom-1',
      })
      const rec2 = store1.trustSync({
        staticPublicKey: client2.publicKey,
        displayName: 'Phone',
        grantedCapabilities: ['observe'],
        trustDomainId: 'dom-1',
      })

      // Revoke client 2
      store1.revokeSync(rec2.deviceId)

      // 2. Restart simulation: create brand new store instance on same file
      const store2 = new FileDeviceTrustStore(filePath)

      // Parity check
      const read1 = store2.getSync(rec1.deviceId)
      expect(read1).toBeDefined()
      expect(read1?.displayName).toBe('Laptop')
      expect(read1?.grantedCapabilities.has('prompt')).toBe(true)
      expect(read1?.revokedAt).toBeUndefined()

      const read2 = store2.getSync(rec2.deviceId)
      expect(read2).toBeDefined()
      expect(read2?.revokedAt).toBeDefined()

      // 3. Corruption handling: Corrupted JSON must fail closed (throw, not silently erase)
      writeFileSync(filePath, '{ bad json: true', 'utf8')
      expect(() => new FileDeviceTrustStore(filePath)).toThrow(RemoteCryptoError)

      // 4. Schema corruption: Invalid schemaVersion must fail closed
      writeFileSync(filePath, JSON.stringify({ schemaVersion: 99, devices: [] }), 'utf8')
      expect(() => new FileDeviceTrustStore(filePath)).toThrow(RemoteCryptoError)
    } finally {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    }
  })

  it('7. P0-6: Revoke active-channel termination hook emits exact event and isolates listeners', () => {
    const trustStore = new InMemoryDeviceTrustStore()
    const client = generateClientKeyPair()
    const deviceId = computeFingerprint(client.publicKey)

    trustStore.trustSync({
      staticPublicKey: client.publicKey,
      displayName: 'Device 1',
      grantedCapabilities: ['observe'],
      trustDomainId: 'dom-1',
    })

    const events: Array<{ deviceId: string; revokedAt: number; keyVersion: number }> = []
    const unsubscribe = trustStore.subscribeRevocations((event) => {
      events.push(event)
    })

    // Faulty listener that throws
    trustStore.subscribeRevocations(() => {
      throw new Error('listener failure')
    })

    // 1. Revoke trusted device -> exactly one event emitted despite faulty listener
    const res1 = trustStore.revokeSync(deviceId)
    expect(res1).toBe(true)
    expect(events.length).toBe(1)
    expect(events[0]?.deviceId).toBe(deviceId)

    // Device MUST remain revoked despite faulty listener throwing
    expect(trustStore.getSync(deviceId)?.revokedAt).toBeDefined()

    // 2. Duplicate revoke -> returns false, does not emit duplicate event
    const res2 = trustStore.revokeSync(deviceId)
    expect(res2).toBe(false)
    expect(events.length).toBe(1)

    // 3. Unknown device -> returns false, no event emitted
    const res3 = trustStore.revokeSync('unknown-device')
    expect(res3).toBe(false)
    expect(events.length).toBe(1)

    // 4. Unsubscribe works
    unsubscribe()
    const client2 = generateClientKeyPair()
    const rec2 = trustStore.trustSync({
      staticPublicKey: client2.publicKey,
      displayName: 'Device 2',
      grantedCapabilities: ['observe'],
      trustDomainId: 'dom-1',
    })
    trustStore.revokeSync(rec2.deviceId)
    expect(events.length).toBe(1) // Still 1 because unsubscribed
  })

  it('8. P1: Pairing TTL hard ceiling strictly validates constructor and custom TTL', () => {
    // Constructor maxTtlMs boundary tests
    expect(() => new PairingTokenRegistry(16, 5000, Infinity)).toThrow(RemoteCryptoError)
    expect(() => new PairingTokenRegistry(16, 5000, NaN)).toThrow(RemoteCryptoError)
    expect(() => new PairingTokenRegistry(16, 5000, 300001)).toThrow(RemoteCryptoError)
    expect(() => new PairingTokenRegistry(16, 5000, 300000)).not.toThrow()

    const registry = new PairingTokenRegistry()
    // Custom TTL boundary tests
    expect(() => registry.createToken({ trustDomainId: 'dom-1', hostGeneration: 1, ttlMs: 0 })).toThrow(RemoteCryptoError)
    expect(() => registry.createToken({ trustDomainId: 'dom-1', hostGeneration: 1, ttlMs: -1 })).toThrow(RemoteCryptoError)
    expect(() => registry.createToken({ trustDomainId: 'dom-1', hostGeneration: 1, ttlMs: 1.5 })).toThrow(RemoteCryptoError)
    expect(() => registry.createToken({ trustDomainId: 'dom-1', hostGeneration: 1, ttlMs: MAX_PAIRING_TTL_MS + 1 })).toThrow(RemoteCryptoError)
    expect(() => registry.createToken({ trustDomainId: 'dom-1', hostGeneration: 1, ttlMs: MAX_PAIRING_TTL_MS })).not.toThrow()
  })

  it('9. nonce ceiling cannot be raised above audited max and public API cannot disable it', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const client = generateClientKeyPair()

    const normalSession = new NoiseInitiatorSession(client, host.identity.publicKey)
    expect((normalSession as unknown as { setMaxMessagesForTest?: unknown }).setMaxMessagesForTest).toBeUndefined()

    expect(() => {
      new NoiseInitiatorSession(client, host.identity.publicKey, new Uint8Array(0), {
        maxMessages: MAX_TRANSPORT_MESSAGES + 1,
      })
    }).toThrow(RemoteCryptoError)
  })

  it('10. 32-bit transport nonce message ceiling fail closed', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const client = generateClientKeyPair()

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
    responder.decrypt(initiator.encrypt(p))
    responder.decrypt(initiator.encrypt(p))
    responder.decrypt(initiator.encrypt(p))

    expect(() => initiator.encrypt(p)).toThrow(RemoteCryptoError)
    expect(initiator.getState()).toBe('CLOSED')
  })

  it('11. ciphertext auth failure closes session and post-failure crypto is denied', async () => {
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
    ciphertext[2] = (ciphertext[2] ?? 0) ^ 0x01

    expect(() => responder.decrypt(ciphertext)).toThrow(RemoteCryptoError)
    expect(responder.getState()).toBe('CLOSED')
    expect(() => responder.decrypt(ciphertext)).toThrow(RemoteCryptoError)
    expect(() => responder.encrypt(new TextEncoder().encode('next'))).toThrow(RemoteCryptoError)
  })

  it('12. candidate expires between verify and confirm', async () => {
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

    const candidate = await coordinator.initiatePairing(responder, { token: token.token })
    now += 10000

    await expect(
      coordinator.confirmPairing({
        candidateId: candidate.candidateId,
        grantedCapabilities: ['observe'],
      }),
    ).rejects.toThrow(RemoteCryptoError)

    expect(tokenRegistry.getCandidate(candidate.candidateId)).toBeUndefined()
  })

  it('13. Host rotates between verify and confirm', async () => {
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
    await hostStore.rotate()

    await expect(
      coordinator.confirmPairing({
        candidateId: candidate.candidateId,
        grantedCapabilities: ['observe'],
      }),
    ).rejects.toThrow(RemoteCryptoError)

    expect(tokenRegistry.getCandidate(candidate.candidateId)).toBeUndefined()
  })

  it('14. deviceId substitution attempt is prevented', async () => {
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

    const candidate = await coordinator.initiatePairing(responder, {
      token: token.token,
      claimedDeviceId: 'victim-device-id',
    })

    expect(candidate.deviceId).toBe(computeFingerprint(client.publicKey))
    expect(candidate.deviceId).not.toBe('victim-device-id')
  })

  it('15. failed trust commit has deterministic token/candidate rollback semantics', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore(1)
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

    await expect(
      coordinator.confirmPairing({
        candidateId: candidate.candidateId,
        grantedCapabilities: ['observe'],
      }),
    ).rejects.toThrow(RemoteCryptoError)

    expect(tokenRegistry.getCandidate(candidate.candidateId)).toBeUndefined()
    expect(tokenRegistry.size).toBe(0)
  })

  it('16. lockfile reviewed closure guard', () => {
    const lockfilePath = join(__dirname, '../../../pnpm-lock.yaml')
    const content = readFileSync(lockfilePath, 'utf8')

    expect(content).not.toContain('glob@7.2.0')
    expect(content).not.toContain('negotiator@1.1.0')
    expect(content).not.toContain('plist@3.1.1')
    expect(content).not.toContain('@xmldom/xmldom@0.9.12')

    expect(content).toContain('noise-handshake@4.2.0')
    expect(content).toContain('@types/noise-handshake@3.0.3')
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
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const core = new RemoteAdapterCore(seams, { hostIdentityStore: hostStore })

    const client = generateClientKeyPair()
    const deviceId = computeFingerprint(client.publicKey)

    core.devices.trust(client.publicKey, ['observe', 'prompt'], {
      trustDomainId: host.identity.trustDomainId,
    })

    const peerEpoch1: AuthenticatedPeer = {
      deviceId,
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
      deviceId,
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
