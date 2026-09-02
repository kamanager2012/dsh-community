import { describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-ignore - noise-handshake/dh.js
import dh from 'noise-handshake/dh.js'
import * as remoteAdapter from '../src/index.ts'
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

describe('R2A-R4 Final Transaction & Concurrency Closure Adversarial Tests', () => {
  it('1. exact crypto dependency version guard', () => {
    const pkgJsonPath = join(__dirname, '../package.json')
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(pkg.dependencies?.['noise-handshake']).toBe('4.2.0')
    expect(pkg.devDependencies?.['@types/noise-handshake']).toBe('3.0.3')
  })

  it('2. P0-1: public API does not expose getInternalCandidate or StoredPairingCandidate escape', () => {
    const registry = new PairingTokenRegistry()
    expect((registry as any).getInternalCandidate).toBeUndefined()
    expect((PairingTokenRegistry.prototype as any).getInternalCandidate).toBeUndefined()
    expect((remoteAdapter as any).StoredPairingCandidate).toBeUndefined()
  })

  it('3. P0-1: external candidate snapshot mutation cannot affect registry or confirmation', async () => {
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
    initA.readMessage2(respA.writeMessage2())

    const candidateA = await coordinator.initiatePairing(respA, { token: tokenA.token })
    try {
      ;(candidateA.maxAllowedCapabilities as string[]).push('approve')
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
      ;(candidateB as any).trustDomainId = 'tampered'
      ;(candidateB as any).hostGeneration = 999
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
      ;(candidateC as any).expiresAt = now + 1000000
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

  it('4. P0-2: confirm/confirm race is strictly single-winner', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const tokenRegistry = new PairingTokenRegistry()
    const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry)

    const token = tokenRegistry.createToken({
      trustDomainId: host.identity.trustDomainId,
      hostGeneration: host.identity.generation,
      allowedCapabilities: ['observe'],
    })

    const client = generateClientKeyPair()
    const init = new NoiseInitiatorSession(client, host.identity.publicKey)
    const resp = new NoiseResponderSession(host)
    resp.readMessage1(init.writeMessage1())
    init.readMessage2(resp.writeMessage2())

    const candidate = await coordinator.initiatePairing(resp, { token: token.token })

    // Concurrent execution of two confirmPairing calls
    const [res1, res2] = await Promise.allSettled([
      coordinator.confirmPairing({
        candidateId: candidate.candidateId,
        grantedCapabilities: ['observe'],
      }),
      coordinator.confirmPairing({
        candidateId: candidate.candidateId,
        grantedCapabilities: ['observe'],
      }),
    ])

    const fulfilled = [res1, res2].filter((r) => r.status === 'fulfilled')
    const rejected = [res1, res2].filter((r) => r.status === 'rejected')

    // Exactly one winner, exactly one failure
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)

    // Store committed exactly one record
    expect(await trustStore.size()).toBe(1)
  })

  it('5. P0-2: confirm/reject race is strictly single-winner and losing op has no side effects', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const tokenRegistry = new PairingTokenRegistry()
    const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry)

    // Scenario A: reject claims first
    const tokenA = tokenRegistry.createToken({
      trustDomainId: host.identity.trustDomainId,
      hostGeneration: host.identity.generation,
    })
    const clientA = generateClientKeyPair()
    const initA = new NoiseInitiatorSession(clientA, host.identity.publicKey)
    const respA = new NoiseResponderSession(host)
    respA.readMessage1(initA.writeMessage1())
    initA.readMessage2(respA.writeMessage2())

    const candA = await coordinator.initiatePairing(respA, { token: tokenA.token })
    // Reject wins
    const rejectWon = await coordinator.rejectPairing(candA.candidateId)
    expect(rejectWon).toBe(true)

    // Subsequent or racing confirm must fail closed
    await expect(
      coordinator.confirmPairing({
        candidateId: candA.candidateId,
        grantedCapabilities: ['observe'],
      }),
    ).rejects.toThrow(RemoteCryptoError)
    expect(await trustStore.size()).toBe(0)

    // Scenario B: confirm claims first
    const tokenB = tokenRegistry.createToken({
      trustDomainId: host.identity.trustDomainId,
      hostGeneration: host.identity.generation,
    })
    const clientB = generateClientKeyPair()
    const initB = new NoiseInitiatorSession(clientB, host.identity.publicKey)
    const respB = new NoiseResponderSession(host)
    respB.readMessage1(initB.writeMessage1())
    initB.readMessage2(respB.writeMessage2())

    const candB = await coordinator.initiatePairing(respB, { token: tokenB.token })
    const confirmPromise = coordinator.confirmPairing({
      candidateId: candB.candidateId,
      grantedCapabilities: ['observe'],
    })
    // Racing reject
    const rejectAfterClaim = await coordinator.rejectPairing(candB.candidateId)
    expect(rejectAfterClaim).toBe(false) // cannot reverse confirmation claim!

    const confirmRes = await confirmPromise
    expect(confirmRes.channelState).toBe('DEVICE_AUTHORIZED')
    expect(await trustStore.size()).toBe(1)
  })

  it('6. P0-3 & P0-4: FileDeviceTrustStore durable transactions, fault injection, and lastSeenAt parity', async () => {
    const testDir = join(tmpdir(), `dsh-tx-test-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })
    const filePath = join(testDir, 'devices.json')

    try {
      let injectFault = false
      const store = new FileDeviceTrustStore(filePath, {
        faultInjector: (stage) => {
          if (injectFault && stage === 'before-rename') {
            throw new Error('injected persistence fault')
          }
        },
      })

      const client1 = generateClientKeyPair()
      const client2 = generateClientKeyPair()
      const dev1Id = computeFingerprint(client1.publicKey)
      const dev2Id = computeFingerprint(client2.publicKey)

      // Test 1: Fault during trust -> no ghost device in memory or disk
      injectFault = true
      expect(() => {
        store.trustSync({
          staticPublicKey: client1.publicKey,
          displayName: 'Ghost Client',
          grantedCapabilities: ['observe'],
          trustDomainId: 'dom-1',
        })
      }).toThrow('injected persistence fault')

      expect(store.getSync(dev1Id)).toBeUndefined()
      const diskCheck1 = new FileDeviceTrustStore(filePath)
      expect(diskCheck1.getSync(dev1Id)).toBeUndefined()

      // Successful trust
      injectFault = false
      store.trustSync({
        staticPublicKey: client1.publicKey,
        displayName: 'Client 1',
        grantedCapabilities: ['observe'],
        trustDomainId: 'dom-1',
      })
      store.trustSync({
        staticPublicKey: client2.publicKey,
        displayName: 'Client 2',
        grantedCapabilities: ['observe', 'prompt'],
        trustDomainId: 'dom-1',
      })

      // Test 2: Fault during revoke -> no false revocation event, no dirty memory
      let revocationCount = 0
      store.subscribeRevocations(() => {
        revocationCount++
      })

      injectFault = true
      expect(() => {
        store.revokeSync(dev1Id)
      }).toThrow('injected persistence fault')

      expect(revocationCount).toBe(0) // No false event emitted
      expect(store.getSync(dev1Id)?.revokedAt).toBeUndefined() // Memory not revoked

      const diskCheck2 = new FileDeviceTrustStore(filePath)
      expect(diskCheck2.getSync(dev1Id)?.revokedAt).toBeUndefined() // Disk not revoked

      // Test 3: Fault during adminReEnroll -> previous state preserved
      injectFault = false
      store.revokeSync(dev1Id)
      expect(revocationCount).toBe(1)
      expect(store.getSync(dev1Id)?.revokedAt).toBeDefined()

      injectFault = true
      await expect(
        store.adminReEnroll({
          deviceId: dev1Id,
          grantedCapabilities: ['observe', 'prompt'],
          trustDomainId: 'dom-1',
        }),
      ).rejects.toThrow('injected persistence fault')

      expect(store.getSync(dev1Id)?.revokedAt).toBeDefined() // Still revoked
      const diskCheck3 = new FileDeviceTrustStore(filePath)
      expect(diskCheck3.getSync(dev1Id)?.revokedAt).toBeDefined()

      // Test 4: Fault during remove -> device remains consistently present
      await expect(store.remove(dev2Id)).rejects.toThrow('injected persistence fault')
      expect(store.getSync(dev2Id)).toBeDefined()
      const diskCheck4 = new FileDeviceTrustStore(filePath)
      expect(diskCheck4.getSync(dev2Id)).toBeDefined()

      // Test 5: P0-4: recordSeen durable contract & restart parity
      injectFault = false
      const seenTs = (store.getSync(dev2Id)?.pairedAt ?? 1000) + 10000
      store.recordSeenSync(dev2Id, seenTs)
      expect(store.getSync(dev2Id)?.lastSeenAt).toBe(seenTs)
      const diskCheck5 = new FileDeviceTrustStore(filePath)
      expect(diskCheck5.getSync(dev2Id)?.lastSeenAt).toBe(seenTs)
    } finally {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    }
  })

  it('7. P1: FileDeviceTrustStore path, symlink, POSIX permissions, and schema gate', () => {
    const testDir = join(tmpdir(), `dsh-integrity-test-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })

    try {
      // 1. Relative path rejected
      expect(() => new FileDeviceTrustStore('./relative-path.json')).toThrow(RemoteCryptoError)

      // 2. Symlink rejected where supported
      const targetFile = join(testDir, 'target.json')
      const symlinkFile = join(testDir, 'symlink.json')
      writeFileSync(targetFile, JSON.stringify({ schemaVersion: 1, devices: [] }), { mode: 0o600 })
      try {
        symlinkSync(targetFile, symlinkFile)
        expect(() => new FileDeviceTrustStore(symlinkFile)).toThrow(RemoteCryptoError)
      } catch (err: any) {
        if (err.code !== 'EPERM') throw err
      }

      // 3. Insecure POSIX permissions rejected where supported
      if (process.platform !== 'win32') {
        const insecureFile = join(testDir, 'insecure.json')
        writeFileSync(insecureFile, JSON.stringify({ schemaVersion: 1, devices: [] }), {
          mode: 0o666,
        })
        chmodSync(insecureFile, 0o666)
        expect(() => new FileDeviceTrustStore(insecureFile)).toThrow(RemoteCryptoError)
      }

      // 4. Duplicate device record rejected
      const dupFile = join(testDir, 'dup.json')
      const client = generateClientKeyPair()
      const devId = computeFingerprint(client.publicKey)
      const validDev = {
        deviceId: devId,
        fingerprint: devId,
        staticPublicKeyHex: Buffer.from(client.publicKey).toString('hex'),
        trustDomainId: 'dom-1',
        displayName: 'Dev',
        grantedCapabilities: ['observe'],
        pairedAt: 1000,
        lastSeenAt: 1000,
        keyVersion: 1,
      }
      writeFileSync(
        dupFile,
        JSON.stringify({ schemaVersion: 1, devices: [validDev, validDev] }),
        { mode: 0o600 },
      )
      expect(() => new FileDeviceTrustStore(dupFile)).toThrow(RemoteCryptoError)

      // 5. Malformed fingerprint rejected
      const badFpFile = join(testDir, 'bad-fp.json')
      writeFileSync(
        badFpFile,
        JSON.stringify({
          schemaVersion: 1,
          devices: [{ ...validDev, fingerprint: 'wrong-fingerprint' }],
        }),
        { mode: 0o600 },
      )
      expect(() => new FileDeviceTrustStore(badFpFile)).toThrow(RemoteCryptoError)

      // 6. Malformed capability rejected
      const badCapFile = join(testDir, 'bad-cap.json')
      writeFileSync(
        badCapFile,
        JSON.stringify({
          schemaVersion: 1,
          devices: [{ ...validDev, grantedCapabilities: ['observe', 'superuser'] }],
        }),
        { mode: 0o600 },
      )
      expect(() => new FileDeviceTrustStore(badCapFile)).toThrow(RemoteCryptoError)

      // 7. Malformed timestamps / keyVersion rejected
      const badTimeFile = join(testDir, 'bad-time.json')
      writeFileSync(
        badTimeFile,
        JSON.stringify({
          schemaVersion: 1,
          devices: [{ ...validDev, pairedAt: -50 }],
        }),
        { mode: 0o600 },
      )
      expect(() => new FileDeviceTrustStore(badTimeFile)).toThrow(RemoteCryptoError)
    } finally {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    }
  })

  it('8. P0-2: DeviceTrustStore defensive snapshots prevent state corruption', async () => {
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

    try {
      ;(record.grantedCapabilities as Set<Capability>).add('prompt')
      record.staticPublicKey.fill(0xee)
      ;(record as any).revokedAt = Date.now()
    } catch {}

    const recordFromGet = await trustStore.get(deviceId)
    expect(recordFromGet?.grantedCapabilities.has('prompt')).toBe(false)
    expect(recordFromGet?.staticPublicKey).toEqual(client.publicKey)
    expect(recordFromGet?.revokedAt).toBeUndefined()

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

  it('9. P0-3: DeviceTrustStore rejects arbitrary deviceId bypass and enforces 32-byte key', async () => {
    const trustStore = new InMemoryDeviceTrustStore()

    await expect(
      trustStore.trust({
        staticPublicKey: new Uint8Array(16),
        displayName: 'Invalid Key Device',
        grantedCapabilities: ['observe'],
        trustDomainId: 'dom-1',
      }),
    ).rejects.toThrow(RemoteCryptoError)

    const key = generateClientKeyPair().publicKey
    const record = await trustStore.trust({
      staticPublicKey: key,
      displayName: 'Legit Device',
      grantedCapabilities: ['observe'],
      trustDomainId: 'dom-1',
    })

    expect(record.deviceId).toBe(computeFingerprint(key))
  })

  it('10. P0-4: Host rotation automatically invalidates Core authorization truth without manual sync', async () => {
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

    const res1 = await core.handle(peer, req1)
    expect(calls.followup).toBe(1)
    expect(res1).toEqual({ sessionId: 's1', prompt: 'hello gen1', turnId: 't1' })

    const hostGen2 = await hostStore.rotate()
    expect(hostGen2.identity.trustDomainId).not.toBe(hostGen1.identity.trustDomainId)

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

    await expect(core.handle(peer, req2)).rejects.toThrow(RemoteProtocolError)
    expect(calls.followup).toBe(1)
  })

  it('11. P1: Pairing TTL hard ceiling strictly validates constructor and custom TTL', () => {
    expect(() => new PairingTokenRegistry(16, 5000, Infinity)).toThrow(RemoteCryptoError)
    expect(() => new PairingTokenRegistry(16, 5000, NaN)).toThrow(RemoteCryptoError)
    expect(() => new PairingTokenRegistry(16, 5000, 300001)).toThrow(RemoteCryptoError)
    expect(() => new PairingTokenRegistry(16, 5000, 300000)).not.toThrow()

    const registry = new PairingTokenRegistry()
    expect(() => registry.createToken({ trustDomainId: 'dom-1', hostGeneration: 1, ttlMs: 0 })).toThrow(RemoteCryptoError)
    expect(() => registry.createToken({ trustDomainId: 'dom-1', hostGeneration: 1, ttlMs: -1 })).toThrow(RemoteCryptoError)
    expect(() => registry.createToken({ trustDomainId: 'dom-1', hostGeneration: 1, ttlMs: 1.5 })).toThrow(RemoteCryptoError)
    expect(() => registry.createToken({ trustDomainId: 'dom-1', hostGeneration: 1, ttlMs: MAX_PAIRING_TTL_MS + 1 })).toThrow(RemoteCryptoError)
    expect(() => registry.createToken({ trustDomainId: 'dom-1', hostGeneration: 1, ttlMs: MAX_PAIRING_TTL_MS })).not.toThrow()
  })

  it('12. nonce ceiling cannot be raised above audited max and public API cannot disable it', async () => {
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

  it('13. 32-bit transport nonce message ceiling fail closed', async () => {
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

  it('14. ciphertext auth failure closes session and post-failure crypto is denied', async () => {
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

  it('15. lockfile reviewed closure guard', () => {
    const lockfilePath = join(__dirname, '../../../pnpm-lock.yaml')
    const content = readFileSync(lockfilePath, 'utf8')

    expect(content).not.toContain('glob@7.2.0')
    expect(content).not.toContain('negotiator@1.1.0')
    expect(content).not.toContain('plist@3.1.1')
    expect(content).not.toContain('@xmldom/xmldom@0.9.12')

    expect(content).toContain('noise-handshake@4.2.0')
    expect(content).toContain('@types/noise-handshake@3.0.3')
  })

  it('16. HostKeyPair prevents secret leak via JSON.stringify, spread, inspect, String', async () => {
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

  it('17. raw token absent from registry state and PairingToken leak proof', () => {
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

  it('18. ConnectionEpochAllocator fails closed on exhaustion', () => {
    const allocator = new ConnectionEpochAllocator(Number.MAX_SAFE_INTEGER - 1)
    expect(allocator.allocateNext()).toBe(Number.MAX_SAFE_INTEGER)

    expect(() => {
      allocator.allocateNext()
    }).toThrow(RemoteCryptoError)
  })

  it('19. same R1 idempotency key survives transport reconnect with fresh epoch', async () => {
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

  it('20. handshake hash equality and availability after completion', async () => {
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

  it('21. candidate expires between verify and confirm', async () => {
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

  it('22. Host rotates between verify and confirm', async () => {
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

  it('23. deviceId substitution attempt is prevented', async () => {
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

  it('24. failed trust commit has deterministic token/candidate rollback semantics', async () => {
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

  it('25. revoked device cannot be restored by standard pairing', async () => {
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
