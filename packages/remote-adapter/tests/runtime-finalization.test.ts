import { describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-ignore - noise-handshake/dh.js
import dh from 'noise-handshake/dh.js'
import {
  FileHostIdentityStore,
  InMemoryDeviceTrustStore,
  computeFingerprint,
  LanClientCarrier,
  RemoteHostRuntime,
  type OfficialRemoteSeams,
} from '../src/index.js'

interface DhModule {
  generateKeyPair(): { publicKey: Buffer; secretKey: Buffer }
}

const dhHelper: DhModule =
  (dh as unknown as { default?: DhModule }).default ?? (dh as unknown as DhModule)

function clientKeyPair() {
  const raw = dhHelper.generateKeyPair()
  return {
    publicKey: new Uint8Array(raw.publicKey),
    secretKey: new Uint8Array(raw.secretKey),
  }
}

function fakeSeams() {
  const calls = { followup: 0, approval: 0, question: 0 }
  const seams: OfficialRemoteSeams = {
    async listSessions() {
      return [{ id: 's1', title: 'one' }]
    },
    async assertSession(sessionId) {
      if (sessionId !== 's1') throw new Error('missing session')
    },
    async followup(sessionId, prompt) {
      calls.followup += 1
      return { sessionId, prompt, turnId: 't' + String(calls.followup) }
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

describe('remote host non-mobile finalization', () => {
  it('persists Host static identity and durable rotation across store recreation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-host-id-'))
    const path = join(dir, 'host-identity.json')
    try {
      const firstStore = new FileHostIdentityStore(path)
      const first = await firstStore.loadOrCreate()
      const reopened = new FileHostIdentityStore(path)
      const same = await reopened.loadOrCreate()
      expect(same.identity.fingerprint).toBe(first.identity.fingerprint)
      expect(same.identity.generation).toBe(1)

      const rotated = await reopened.rotate()
      expect(rotated.identity.generation).toBe(2)
      expect(rotated.identity.fingerprint).not.toBe(first.identity.fingerprint)

      const afterRestart = await new FileHostIdentityStore(path).loadOrCreate()
      expect(afterRestart.identity.fingerprint).toBe(rotated.identity.fingerprint)
      expect(afterRestart.identity.generation).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform !== 'win32')('rejects insecure Host identity file permissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-host-mode-'))
    const path = join(dir, 'host-identity.json')
    try {
      await new FileHostIdentityStore(path).loadOrCreate()
      chmodSync(path, 0o644)
      await expect(new FileHostIdentityStore(path).loadOrCreate()).rejects.toThrow('0600')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed on Host identity corruption instead of silently rotating', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-host-corrupt-'))
    const path = join(dir, 'host-identity.json')
    try {
      await new FileHostIdentityStore(path).loadOrCreate()
      writeFileSync(path, '{"schemaVersion":1,"broken":true}', 'utf8')
      if (process.platform !== 'win32') chmodSync(path, 0o600)
      await expect(new FileHostIdentityStore(path).loadOrCreate()).rejects.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ingests official session/event batches, dedupes by seq, and replays them', async () => {
    const { seams } = fakeSeams()
    const trustStore = new InMemoryDeviceTrustStore()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-host-runtime-'))
    const hostStore = new FileHostIdentityStore(join(dir, 'id.json'))
    try {
      const runtime = new RemoteHostRuntime({
        seams,
        trustStore,
        hostIdentityStore: hostStore,
        carrier: { enabled: false },
      })
      const accepted = runtime.ingestSessionEventBatch('s1', {
        log: [
          { seq: 1, type: 'user/message', data: { marker: 'a' } },
          { seq: 1, type: 'user/message', data: { marker: 'duplicate' } },
          { seq: 2, type: 'assistant/message', data: { marker: 'b' } },
        ],
      })
      expect(accepted).toBe(2)

      const keys = clientKeyPair()
      const host = await hostStore.loadOrCreate()
      trustStore.trustSync({
        staticPublicKey: keys.publicKey,
        displayName: 'observer',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })
      const result = await runtime.core.handle(
        { deviceId: computeFingerprint(keys.publicKey), connectionEpoch: 1 },
        {
          jsonrpc: '2.0',
          id: 'r1',
          method: 'session.attach',
          protocolVersion: 1,
          connectionEpoch: 1,
          requestSeq: 1,
          params: { sessionId: 's1', afterSeq: 0 },
        },
      )
      expect((result as any).events.map((event: any) => event.seq)).toEqual([1, 2])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resumes retained official event suffix after reconnect using last acknowledged seq', async () => {
    const { seams } = fakeSeams()
    const trustStore = new InMemoryDeviceTrustStore()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-reconnect-'))
    const hostStore = new FileHostIdentityStore(join(dir, 'host.json'))
    const runtime = new RemoteHostRuntime({
      seams,
      trustStore,
      hostIdentityStore: hostStore,
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
    })
    await runtime.start()
    try {
      const host = await hostStore.loadOrCreate()
      const keys = clientKeyPair()
      trustStore.trustSync({
        staticPublicKey: keys.publicKey,
        displayName: 'reconnect',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })
      const client = new LanClientCarrier({
        clientKeyPair: keys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: runtime.carrier.getEndpointUrl()!,
      })

      runtime.ingestSessionEventBatch('s1', {
        log: [{ seq: 1, type: 'test/event', data: { value: 1 } }],
      })
      await client.connect()
      const first = await client.resumeSession('s1')
      expect(first.events.map((event: any) => event.seq)).toEqual([1])
      await client.acknowledgeSessionSeq('s1', 1)
      const firstEpoch = client.getConnectionEpoch()
      client.close()

      runtime.ingestSessionEventBatch('s1', {
        log: [
          { seq: 1, type: 'test/event', data: { value: 1 } },
          { seq: 2, type: 'test/event', data: { value: 2 } },
        ],
      })

      const resumed = await client.reconnectAndResume(['s1'], {
        initialDelayMs: 1,
        maxDelayMs: 2,
        maxAttempts: 2,
      })
      expect(client.getConnectionEpoch()).toBeGreaterThan(firstEpoch)
      expect((resumed.s1 as any).events.map((event: any) => event.seq)).toEqual([2])
    } finally {
      await runtime.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('broadcasts accepted official session events live to an active client', async () => {
    const { seams } = fakeSeams()
    const trustStore = new InMemoryDeviceTrustStore()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-live-event-'))
    const hostStore = new FileHostIdentityStore(join(dir, 'host.json'))
    const runtime = new RemoteHostRuntime({
      seams,
      trustStore,
      hostIdentityStore: hostStore,
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
    })
    await runtime.start()
    try {
      const host = await hostStore.loadOrCreate()
      const keys = clientKeyPair()
      trustStore.trustSync({
        staticPublicKey: keys.publicKey,
        displayName: 'live',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })
      const client = new LanClientCarrier({
        clientKeyPair: keys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: runtime.carrier.getEndpointUrl()!,
      })
      await client.connect()

      const live = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('live event timeout')), 1000)
        const unsubscribe = client.onEvent((event) => {
          const value = event as any
          if (value?.type === 'stream.event' && value?.sessionId === 's1') {
            clearTimeout(timer)
            unsubscribe()
            resolve(value)
          }
        })
      })

      runtime.ingestSessionEventBatch('s1', {
        log: [{ seq: 1, type: 'test/live', data: { marker: 'live' } }],
      })
      const received = await live
      expect(received.event.seq).toBe(1)
      expect(received.event.type).toBe('test/live')
      client.close()
    } finally {
      await runtime.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns reset when the acknowledged suffix has been evicted', async () => {
    const { seams } = fakeSeams()
    const trustStore = new InMemoryDeviceTrustStore()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-reset-'))
    const hostStore = new FileHostIdentityStore(join(dir, 'host.json'))
    const runtime = new RemoteHostRuntime({
      seams,
      trustStore,
      hostIdentityStore: hostStore,
      coreOptions: { replayCapacity: 1 },
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
    })
    await runtime.start()
    try {
      const host = await hostStore.loadOrCreate()
      const keys = clientKeyPair()
      trustStore.trustSync({
        staticPublicKey: keys.publicKey,
        displayName: 'reset',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })
      const client = new LanClientCarrier({
        clientKeyPair: keys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: runtime.carrier.getEndpointUrl()!,
      })
      runtime.ingestSessionEventBatch('s1', { log: [{ seq: 1, type: 'test/event' }] })
      await client.connect()
      await client.resumeSession('s1')
      await client.acknowledgeSessionSeq('s1', 1)
      client.close()

      runtime.ingestSessionEventBatch('s1', {
        log: [
          { seq: 1, type: 'test/event' },
          { seq: 2, type: 'test/event' },
          { seq: 3, type: 'test/event' },
        ],
      })
      await client.reconnectWithBackoff({ initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 2 })
      const result = await client.resumeSession('s1')
      expect(result.kind).toBe('reset')
      expect(result.reason).toBe('window-exceeded')
    } finally {
      await runtime.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps mutation idempotency across reconnect and does not duplicate official followup', async () => {
    const { seams, calls } = fakeSeams()
    const trustStore = new InMemoryDeviceTrustStore()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-idem-reconnect-'))
    const hostStore = new FileHostIdentityStore(join(dir, 'host.json'))
    const runtime = new RemoteHostRuntime({
      seams,
      trustStore,
      hostIdentityStore: hostStore,
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
    })
    await runtime.start()
    try {
      const host = await hostStore.loadOrCreate()
      const keys = clientKeyPair()
      trustStore.trustSync({
        staticPublicKey: keys.publicKey,
        displayName: 'idem',
        grantedCapabilities: ['prompt'],
        trustDomainId: host.identity.trustDomainId,
      })
      const client = new LanClientCarrier({
        clientKeyPair: keys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: runtime.carrier.getEndpointUrl()!,
      })
      await client.connect()
      const first = await client.request(
        'prompt.submit',
        { sessionId: 's1', prompt: 'same' },
        { idempotencyKey: 'stable-idem' },
      )
      client.close()
      await client.reconnectWithBackoff({ initialDelayMs: 1, maxDelayMs: 2, maxAttempts: 2 })
      const second = await client.request(
        'prompt.submit',
        { sessionId: 's1', prompt: 'same' },
        { idempotencyKey: 'stable-idem' },
      )
      expect(second).toEqual(first)
      expect(calls.followup).toBe(1)
    } finally {
      await runtime.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('bounds reconnect attempts after revoke and never busy-loops', async () => {
    const { seams } = fakeSeams()
    const trustStore = new InMemoryDeviceTrustStore()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-revoke-reconnect-'))
    const hostStore = new FileHostIdentityStore(join(dir, 'host.json'))
    const runtime = new RemoteHostRuntime({
      seams,
      trustStore,
      hostIdentityStore: hostStore,
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
    })
    await runtime.start()
    try {
      const host = await hostStore.loadOrCreate()
      const keys = clientKeyPair()
      const record = trustStore.trustSync({
        staticPublicKey: keys.publicKey,
        displayName: 'revoked',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })
      const delays: number[] = []
      const client = new LanClientCarrier({
        clientKeyPair: keys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: runtime.carrier.getEndpointUrl()!,
        handshakeTimeoutMs: 250,
        sleep: async (ms) => {
          delays.push(ms)
        },
      })
      await client.connect()
      trustStore.revokeSync(record.deviceId)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(client.isOpen()).toBe(false)

      await expect(
        client.reconnectWithBackoff({
          initialDelayMs: 5,
          maxDelayMs: 10,
          multiplier: 2,
          maxAttempts: 3,
        }),
      ).rejects.toThrow()

      expect(delays).toEqual([5, 10])
      expect(client.isOpen()).toBe(false)
    } finally {
      await runtime.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
