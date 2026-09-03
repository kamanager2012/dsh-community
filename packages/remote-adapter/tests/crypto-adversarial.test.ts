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

describe('R2A-R5 Root Authority & Integrity Closure Adversarial Tests', () => {
  it('1. exact crypto dependency version guard', () => {
    const pkgJsonPath = join(__dirname, '../package.json')
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(pkg.dependencies?.['noise-handshake']).toBe('4.2.0')
    expect(pkg.devDependencies?.['@types/noise-handshake']).toBe('3.0.3')
  })

  it('2. P0-1: HostIdentityStore root authority cannot be mutated via returned objects', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const origDomain = host.identity.trustDomainId
    const origGen = host.identity.generation
    const origPub = Buffer.from(host.identity.publicKey)
    const origSec = Buffer.from(host.secretKey)

    // Attempt to tamper with returned objects
    try {
      ;(host.identity as any).trustDomainId = 'tampered-domain'
      ;(host.identity as any).generation = 9999
    } catch {}
    host.identity.publicKey.fill(0xaa)
    host.secretKey.fill(0xbb)

    // Authoritative state from getPublicIdentity() must be pristine
    const pub = await hostStore.getPublicIdentity()
    expect(pub.trustDomainId).toBe(origDomain)
    expect(pub.generation).toBe(origGen)
    expect(Buffer.from(pub.publicKey).equals(origPub)).toBe(true)

    // Authoritative keyPair from loadOrCreate() must be pristine
    const keyPairAgain = await hostStore.loadOrCreate()
    expect(Buffer.from(keyPairAgain.secretKey).equals(origSec)).toBe(true)
  })

  it('3. P0-2: Capability policy is runtime immutable and protects authorization', async () => {
    const { seams } = fakeSeams()
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const core = new RemoteAdapterCore(seams, { hostIdentityStore: hostStore })

    const client = generateClientKeyPair()
    const devId = computeFingerprint(client.publicKey)
    core.devices.trust(client.publicKey, ['observe'], { trustDomainId: host.identity.trustDomainId })

    // Attempt to mutate exported requiredCapability
    try {
      ;(remoteAdapter.requiredCapability as any)['prompt.submit'] = 'observe'
      ;(remoteAdapter.requiredCapability as any)['approval.respond'] = 'observe'
      delete (remoteAdapter.requiredCapability as any)['question.respond']
    } catch {}

    const peer: AuthenticatedPeer = { deviceId: devId, connectionEpoch: 1 }

    // prompt.submit must still require 'prompt' capability and be denied
    await expect(
      core.handle(peer, {
        jsonrpc: '2.0',
        id: 'r1',
        method: 'prompt.submit',
        protocolVersion: 1,
        connectionEpoch: 1,
        requestSeq: 1,
        idempotencyKey: 'idem-p',
        params: { sessionId: 's1', prompt: 'test' },
      }),
    ).rejects.toThrow(RemoteProtocolError)

    // approval.respond must still require 'approve' capability and be denied
    await expect(
      core.handle(peer, {
        jsonrpc: '2.0',
        id: 'r2',
        method: 'approval.respond',
        protocolVersion: 1,
        connectionEpoch: 1,
        requestSeq: 2,
        idempotencyKey: 'idem-a',
        params: { callId: 'c1', decision: 'approved' },
      }),
    ).rejects.toThrow(RemoteProtocolError)

    // question.respond must still require 'answer-question' and be denied
    await expect(
      core.handle(peer, {
        jsonrpc: '2.0',
        id: 'r3',
        method: 'question.respond',
        protocolVersion: 1,
        connectionEpoch: 1,
        requestSeq: 3,
        idempotencyKey: 'idem-q',
        params: { questionId: 'q1', answer: 'ans' },
      }),
    ).rejects.toThrow(RemoteProtocolError)
  })

  it('4. P0-3: Revocation event is runtime immutable and isolated across listeners', () => {
    const trustStore = new InMemoryDeviceTrustStore()
    const client = generateClientKeyPair()
    const devId = computeFingerprint(client.publicKey)

    trustStore.trustSync({
      staticPublicKey: client.publicKey,
      displayName: 'Dev',
      grantedCapabilities: ['observe'],
      trustDomainId: 'dom-1',
    })

    let listener2ReceivedDevId = ''

    // Listener 1 attempts to tamper with event
    trustStore.subscribeRevocations((event) => {
      try {
        ;(event as any).deviceId = 'tampered-device-id'
      } catch {}
    })

    // Listener 2 inspects event
    trustStore.subscribeRevocations((event) => {
      listener2ReceivedDevId = event.deviceId
    })

    trustStore.revokeSync(devId)
    expect(listener2ReceivedDevId).toBe(devId)
    expect(listener2ReceivedDevId).not.toBe('tampered-device-id')
  })

  it('5. P0-4: Post-rename parent-directory fsync failure triggers fail-closed store poisoning and no ghost resurrection on restart', async () => {
    const testDir = join(tmpdir(), `dsh-dirfsync-test-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })
    const filePath = join(testDir, 'devices.json')

    try {
      let failDirFsync = false
      const store = new FileDeviceTrustStore(filePath, {
        faultInjector: (stage) => {
          if (failDirFsync && stage === 'after-rename-before-dir-fsync') {
            throw new Error('simulated directory fsync failure')
          }
        },
      })

      const client1 = generateClientKeyPair()
      const client2 = generateClientKeyPair()
      const dev1Id = computeFingerprint(client1.publicKey)
      const dev2Id = computeFingerprint(client2.publicKey)

      // Step 1: Client 1 is committed and durably persisted
      store.trustSync({
        staticPublicKey: client1.publicKey,
        displayName: 'Committed Dev 1',
        grantedCapabilities: ['observe'],
        trustDomainId: 'dom-1',
      })
      expect(store.getSync(dev1Id)).toBeDefined()

      // Step 2: Client 2 pairing transaction fails at after-rename-before-dir-fsync
      failDirFsync = true
      expect(() => {
        store.trustSync({
          staticPublicKey: client2.publicKey,
          displayName: 'Uncommitted Dev 2',
          grantedCapabilities: ['observe', 'prompt'],
          trustDomainId: 'dom-1',
        })
      }).toThrow('simulated directory fsync failure')

      // Step 3: Current store instance is poisoned: all operations fail closed
      expect(() => {
        store.assertAuthorizedSync(dev2Id, 'dom-1', 'session.list')
      }).toThrow(RemoteCryptoError)
      expect(() => store.getSync(dev2Id)).toThrow(RemoteCryptoError)
      expect(() => store.revokeSync(dev2Id)).toThrow(RemoteCryptoError)
      await expect(store.list()).rejects.toThrow(RemoteCryptoError)

      // Step 4: Restart new store on the same path -> restores last-known-good committed state
      const restarted = new FileDeviceTrustStore(filePath)
      expect(restarted.getSync(dev1Id)).toBeDefined()
      // FAILED TRANSACTION DOES NOT RESURRECT
      expect(restarted.getSync(dev2Id)).toBeUndefined()
      expect(() => {
        restarted.assertAuthorizedSync(dev2Id, 'dom-1', 'session.list')
      }).toThrow(RemoteProtocolError)
      expect(restarted.assertAuthorizedSync(dev1Id, 'dom-1', 'session.list')).toBeDefined()

      // Step 5: Test explicit recoveryMode: 'fail-closed' when an uncommitted journal is detected
      const journalPath = join(testDir, '.devices.json.journal')
      writeFileSync(journalPath, JSON.stringify({ state: 'COMMITTING', hasPriorCommit: true }), {
        mode: 0o600,
      })
      expect(
        () => new FileDeviceTrustStore(filePath, { recoveryMode: 'fail-closed' }),
      ).toThrow(RemoteCryptoError)

      // Recover journal and verify clean boot
      FileDeviceTrustStore.recover(filePath)
      const recoveredStore = new FileDeviceTrustStore(filePath)
      expect(recoveredStore.getSync(dev1Id)).toBeDefined()
      expect(recoveredStore.getSync(dev2Id)).toBeUndefined()
    } finally {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    }
  })

  it('5b. P0: full 7-stage WAL durability barrier fault matrix guarantees strict commit-point semantics', async () => {
    const stages: Array<{
      stage: FileDeviceTrustFaultStage
      expectedApiOutcome: 'FAIL' | 'SUCCESS'
      expectedRestartDev2: 'unauthorized' | 'authorized'
    }> = [
      { stage: 'after-backup-fsync-before-journal', expectedApiOutcome: 'FAIL', expectedRestartDev2: 'unauthorized' },
      { stage: 'after-journal-fsync-before-prepare-dir-fsync', expectedApiOutcome: 'FAIL', expectedRestartDev2: 'unauthorized' },
      { stage: 'after-prepare-dir-fsync-before-target-rename', expectedApiOutcome: 'FAIL', expectedRestartDev2: 'unauthorized' },
      { stage: 'after-target-rename-before-commit-dir-fsync', expectedApiOutcome: 'FAIL', expectedRestartDev2: 'unauthorized' },
      { stage: 'after-target-commit-dir-fsync-before-committed-marker-fsync', expectedApiOutcome: 'FAIL', expectedRestartDev2: 'unauthorized' },
      { stage: 'after-commit-dir-fsync-before-cleanup', expectedApiOutcome: 'SUCCESS', expectedRestartDev2: 'authorized' },
      { stage: 'after-journal-cleanup-before-cleanup-dir-fsync', expectedApiOutcome: 'SUCCESS', expectedRestartDev2: 'authorized' },
    ]

    for (const { stage, expectedApiOutcome, expectedRestartDev2 } of stages) {
      const testDir = join(tmpdir(), `dsh-wal-matrix-${stage}-${Date.now()}`)
      mkdirSync(testDir, { recursive: true })
      const filePath = join(testDir, 'devices.json')

      try {
        const client1 = generateClientKeyPair()
        const client2 = generateClientKeyPair()
        const dev1Id = computeFingerprint(client1.publicKey)
        const dev2Id = computeFingerprint(client2.publicKey)

        // Baseline: commit device 1
        const initialStore = new FileDeviceTrustStore(filePath)
        initialStore.trustSync({
          staticPublicKey: client1.publicKey,
          displayName: 'Dev 1 Baseline',
          grantedCapabilities: ['observe'],
          trustDomainId: 'dom-1',
        })
        expect(initialStore.getSync(dev1Id)).toBeDefined()

        // Inject fault at current stage during device 2 trust
        let injected = true
        const faultyStore = new FileDeviceTrustStore(filePath, {
          faultInjector: (stg) => {
            if (injected && stg === stage) {
              throw new Error(`simulated failure at stage: ${stage}`)
            }
          },
        })

        let apiError: unknown
        let trustResult: DeviceRecord | undefined
        try {
          trustResult = faultyStore.trustSync({
            staticPublicKey: client2.publicKey,
            displayName: 'Dev 2 Matrix',
            grantedCapabilities: ['observe', 'prompt'],
            trustDomainId: 'dom-1',
          })
        } catch (err) {
          apiError = err
        }

        // Assertion 1: API outcome must strictly match expected
        if (expectedApiOutcome === 'FAIL') {
          expect(apiError).toBeDefined()
          expect(trustResult).toBeUndefined()
        } else {
          expect(apiError).toBeUndefined()
          expect(trustResult).toBeDefined()
          expect(trustResult!.deviceId).toBe(dev2Id)
        }

        injected = false

        // Assertion 2: Restart new FileDeviceTrustStore on the same path
        const restarted = new FileDeviceTrustStore(filePath)

        // Device 1 baseline must be preserved in all 6 stages
        expect(restarted.getSync(dev1Id)).toBeDefined()
        expect(restarted.assertAuthorizedSync(dev1Id, 'dom-1', 'session.list')).toBeDefined()

        // Device 2 restart authorization must strictly match expected
        if (expectedRestartDev2 === 'authorized') {
          expect(restarted.getSync(dev2Id)).toBeDefined()
          expect(restarted.assertAuthorizedSync(dev2Id, 'dom-1', 'session.prompt')).toBeDefined()
        } else {
          expect(restarted.getSync(dev2Id)).toBeUndefined()
          expect(() => {
            restarted.assertAuthorizedSync(dev2Id, 'dom-1', 'session.prompt')
          }).toThrow(RemoteProtocolError)
        }
      } finally {
        if (existsSync(testDir)) {
          rmSync(testDir, { recursive: true, force: true })
        }
      }
    }
  })

  it('5c. P0: first enrollment failure before COMMITTED marker fsync guarantees zero trusted devices on restart without prior backup', async () => {
    const testDir = join(tmpdir(), `dsh-first-commit-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })
    const filePath = join(testDir, 'devices.json')

    try {
      // 1. Brand new empty store with no existing target file and no backup
      expect(existsSync(filePath)).toBe(false)
      expect(existsSync(join(testDir, '.devices.json.committed'))).toBe(false)
      expect(existsSync(join(testDir, '.devices.json.journal'))).toBe(false)

      const clientA = generateClientKeyPair()
      const devAId = computeFingerprint(clientA.publicKey)

      let injected = true
      const store = new FileDeviceTrustStore(filePath, {
        faultInjector: (stage) => {
          if (injected && stage === 'after-target-commit-dir-fsync-before-committed-marker-fsync') {
            throw new Error('simulated marker transition failure on first commit')
          }
        },
      })

      // 2. First enrollment must fail
      expect(() => {
        store.trustSync({
          staticPublicKey: clientA.publicKey,
          displayName: 'Dev A First Commit',
          grantedCapabilities: ['observe'],
          trustDomainId: 'dom-1',
        })
      }).toThrow('simulated marker transition failure on first commit')

      injected = false

      // 3. Current in-memory store is poisoned
      expect(() => store.getSync(devAId)).toThrow(RemoteCryptoError)
      expect(() => store.assertAuthorizedSync(devAId, 'dom-1', 'session.list')).toThrow(RemoteCryptoError)

      // 4. Restart store on same path
      const restarted = new FileDeviceTrustStore(filePath)

      // 5. devA must NOT exist on restart
      expect(restarted.getSync(devAId)).toBeUndefined()
      expect(await restarted.size()).toBe(0)
      expect(() => {
        restarted.assertAuthorizedSync(devAId, 'dom-1', 'session.list')
      }).toThrow(RemoteProtocolError)

      // 6. Verify filesystem clean state
      expect(existsSync(join(testDir, '.devices.json.journal'))).toBe(false)
      expect(existsSync(join(testDir, '.devices.json.committed'))).toBe(false)
    } finally {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    }
  })

  it('6. P1: FileDeviceTrustStore path, symlink, strict 0600 mode, and strict 64-hex key gate', () => {
    const testDir = join(tmpdir(), `dsh-integrity-test-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })

    try {
      // 1. Relative path rejected
      expect(() => new FileDeviceTrustStore('./relative-path.json')).toThrow(RemoteCryptoError)

      // 2. Symlink rejected
      const targetFile = join(testDir, 'target.json')
      const symlinkFile = join(testDir, 'symlink.json')
      writeFileSync(targetFile, JSON.stringify({ schemaVersion: 1, devices: [] }), { mode: 0o600 })
      try {
        symlinkSync(targetFile, symlinkFile)
        expect(() => new FileDeviceTrustStore(symlinkFile)).toThrow(RemoteCryptoError)
      } catch (err: any) {
        if (err.code !== 'EPERM') throw err
      }

      // 3. Strict 0600 POSIX permissions check (0700, 0644, 0666 rejected)
      if (process.platform !== 'win32') {
        const testFile = join(testDir, 'perm-test.json')
        writeFileSync(testFile, JSON.stringify({ schemaVersion: 1, devices: [] }), { mode: 0o600 })

        chmodSync(testFile, 0o666)
        expect(() => new FileDeviceTrustStore(testFile)).toThrow(RemoteCryptoError)

        chmodSync(testFile, 0o644)
        expect(() => new FileDeviceTrustStore(testFile)).toThrow(RemoteCryptoError)

        chmodSync(testFile, 0o700)
        expect(() => new FileDeviceTrustStore(testFile)).toThrow(RemoteCryptoError)

        chmodSync(testFile, 0o600)
        expect(() => new FileDeviceTrustStore(testFile)).not.toThrow()
      }

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

      // 4. Strict 64-hex public key verification
      const badHexFile = join(testDir, 'bad-hex.json')
      writeFileSync(
        badHexFile,
        JSON.stringify({
          schemaVersion: 1,
          devices: [{ ...validDev, staticPublicKeyHex: validDev.staticPublicKeyHex.slice(0, 62) }],
        }),
        { mode: 0o600 },
      )
      expect(() => new FileDeviceTrustStore(badHexFile)).toThrow(RemoteCryptoError)

      // 5. Non-hex characters rejected
      const nonHexFile = join(testDir, 'non-hex.json')
      writeFileSync(
        nonHexFile,
        JSON.stringify({
          schemaVersion: 1,
          devices: [{ ...validDev, staticPublicKeyHex: 'zz'.repeat(32) }],
        }),
        { mode: 0o600 },
      )
      expect(() => new FileDeviceTrustStore(nonHexFile)).toThrow(RemoteCryptoError)

      // 6. Duplicate device record rejected
      const dupFile = join(testDir, 'dup.json')
      writeFileSync(
        dupFile,
        JSON.stringify({ schemaVersion: 1, devices: [validDev, validDev] }),
        { mode: 0o600 },
      )
      expect(() => new FileDeviceTrustStore(dupFile)).toThrow(RemoteCryptoError)

      // 7. P1: VALID_CAPABILITIES is runtime immutable array and not mutable Set
      expect(Array.isArray(remoteAdapter.VALID_CAPABILITIES)).toBe(true)
      expect(Object.isFrozen(remoteAdapter.VALID_CAPABILITIES)).toBe(true)
      expect(() => (remoteAdapter.VALID_CAPABILITIES as any).push('superadmin')).toThrow()

      // 8. P1: rollbackJournal is not exposed as arbitrary-path public API
      expect((FileDeviceTrustStore as any).rollbackJournal).toBeUndefined()
    } finally {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    }
  })

  it('7. P0-1: public API does not expose getInternalCandidate or StoredPairingCandidate escape', () => {
    const registry = new PairingTokenRegistry()
    expect((registry as any).getInternalCandidate).toBeUndefined()
    expect((PairingTokenRegistry.prototype as any).getInternalCandidate).toBeUndefined()
    expect((remoteAdapter as any).StoredPairingCandidate).toBeUndefined()
  })

  it('8. P0-1: external candidate snapshot mutation cannot affect registry or confirmation', async () => {
    let now = 1000
    const hostStore = new InMemoryHostIdentityStore({ clock: () => now })
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore(128, { clock: () => now })
    const tokenRegistry = new PairingTokenRegistry(16, 5000, 5000, { clock: () => now })
    const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry, { clock: () => now })

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
  })

  it('9. P0-2: confirm/confirm race is strictly single-winner', async () => {
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

    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    expect(await trustStore.size()).toBe(1)
  })

  it('10. P0-2: confirm/reject race is strictly single-winner and losing op has no side effects', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const tokenRegistry = new PairingTokenRegistry()
    const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry)

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
    const rejectWon = await coordinator.rejectPairing(candA.candidateId)
    expect(rejectWon).toBe(true)

    await expect(
      coordinator.confirmPairing({
        candidateId: candA.candidateId,
        grantedCapabilities: ['observe'],
      }),
    ).rejects.toThrow(RemoteCryptoError)
    expect(await trustStore.size()).toBe(0)
  })

  it('11. P0-3 & P0-4: FileDeviceTrustStore durable transactions, fault injection, and lastSeenAt parity', async () => {
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

      expect(revocationCount).toBe(0)
      expect(store.getSync(dev1Id)?.revokedAt).toBeUndefined()

      const diskCheck2 = new FileDeviceTrustStore(filePath)
      expect(diskCheck2.getSync(dev1Id)?.revokedAt).toBeUndefined()

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

      expect(store.getSync(dev1Id)?.revokedAt).toBeDefined()
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

  it('12. P0-4: Host rotation automatically invalidates Core authorization truth without manual sync', async () => {
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

  it('13. P1: Pairing TTL hard ceiling strictly validates constructor and custom TTL', () => {
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

  it('14. nonce ceiling cannot be raised above audited max and public API cannot disable it', async () => {
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

  it('15. 32-bit transport nonce message ceiling fail closed', async () => {
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

  it('16. ciphertext auth failure closes session and post-failure crypto is denied', async () => {
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

  it('17. lockfile reviewed closure guard', () => {
    const lockfilePath = join(__dirname, '../../../pnpm-lock.yaml')
    const content = readFileSync(lockfilePath, 'utf8')

    expect(content).not.toContain('glob@7.2.0')
    expect(content).not.toContain('negotiator@1.1.0')
    expect(content).not.toContain('plist@3.1.1')
    expect(content).not.toContain('@xmldom/xmldom@0.9.12')

    expect(content).toContain('noise-handshake@4.2.0')
    expect(content).toContain('@types/noise-handshake@3.0.3')
  })

  it('18. HostKeyPair prevents secret leak via JSON.stringify, spread, inspect, String', async () => {
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

  it('19. raw token absent from registry state and PairingToken leak proof', () => {
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

  it('20. ConnectionEpochAllocator fails closed on exhaustion', () => {
    const allocator = new ConnectionEpochAllocator(Number.MAX_SAFE_INTEGER - 1)
    expect(allocator.allocateNext()).toBe(Number.MAX_SAFE_INTEGER)

    expect(() => {
      allocator.allocateNext()
    }).toThrow(RemoteCryptoError)
  })

  it('21. same R1 idempotency key survives transport reconnect with fresh epoch', async () => {
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

  it('22. handshake hash equality and availability after completion', async () => {
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

  it('23. candidate expires between verify and confirm', async () => {
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

  it('24. Host rotates between verify and confirm', async () => {
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

  it('25. deviceId substitution attempt is prevented', async () => {
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

  it('26. failed trust commit has deterministic token/candidate rollback semantics', async () => {
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

  it('27. revoked device cannot be restored by standard pairing', async () => {
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
})
