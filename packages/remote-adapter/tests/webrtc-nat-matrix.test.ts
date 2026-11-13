import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-ignore - noise-handshake/dh.js
import dh from 'noise-handshake/dh.js'
import {
  FileHostIdentityStore,
  InMemoryDeviceTrustStore,
  RemoteHostRuntime,
  SelfHostedSignalingServer,
  SelfHostedStunServer,
  WebRtcClientCarrier,
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

function fakeSeams(): OfficialRemoteSeams {
  return {
    async listSessions() {
      return [{ id: 's-nat', title: 'NAT Matrix Session' }]
    },
    async assertSession() {},
    async followup(sessionId, prompt) {
      return { sessionId, prompt, ok: true }
    },
    async respondApproval(callId, decision) {
      return { callId, decision }
    },
    async respondQuestion(questionId, answer) {
      return { questionId, answer }
    },
  }
}

describe('R3 WebRTC NAT-matrix & signaling-independence acceptance matrix', () => {
  it('connects when direct host<->host ICE pairs are blocked (forces STUN reflexive srflx traversal) and survives signaling server shutdown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-r3-nat-srflx-'))
    const hostStore = new FileHostIdentityStore(join(dir, 'host.json'))
    const trustStore = new InMemoryDeviceTrustStore()

    const stun = new SelfHostedStunServer({ enabled: true, host: '127.0.0.1', port: 0 })
    const sig = new SelfHostedSignalingServer({ enabled: true, host: '127.0.0.1', port: 0 })
    await stun.start()
    await sig.start()

    // Block all host<->host direct pairs so ICE MUST use STUN server-reflexive candidates
    const rejectDirectHostPairs = (pair: {
      localCandidate: { type: string }
      remoteCandidate: { type: string }
    }) => !(pair.localCandidate.type === 'host' && pair.remoteCandidate.type === 'host')

    const runtime = new RemoteHostRuntime({
      seams: fakeSeams(),
      trustStore,
      hostIdentityStore: hostStore,
      carrier: { enabled: false },
      webrtc: {
        enabled: true,
        signalingUrl: sig.getEndpointUrl()!,
        ice: {
          stunUrls: [stun.getStunUrl()!],
          iceInterfaceAddresses: { udp4: '127.0.0.1' },
          iceStunGatherTimeoutSec: 1,
          iceFilterCandidatePair: rejectDirectHostPairs,
        },
      },
    })
    await runtime.start()

    try {
      const host = await hostStore.loadOrCreate()
      const keys = clientKeyPair()
      trustStore.trustSync({
        staticPublicKey: keys.publicKey,
        displayName: 'NAT Matrix Peer',
        grantedCapabilities: ['observe', 'prompt'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client = new WebRtcClientCarrier({
        clientKeyPair: keys,
        hostPublicKey: host.identity.publicKey,
        signalingUrl: sig.getEndpointUrl()!,
        ice: {
          stunUrls: [stun.getStunUrl()!],
          iceInterfaceAddresses: { udp4: '127.0.0.1' },
          iceStunGatherTimeoutSec: 1,
          iceFilterCandidatePair: rejectDirectHostPairs,
        },
      })

      await client.connect()

      // Verify self-owned STUN actually resolved addresses and pair is NOT host<->host
      expect(stun.getStats().responsesSent).toBeGreaterThanOrEqual(2)
      const diag = client.getIceDiagnostics()
      expect(diag?.connectionState).toBe('connected')
      expect(diag?.selectedPair).toBeDefined()
      expect(
        diag!.selectedPair!.localType === 'host' && diag!.selectedPair!.remoteType === 'host',
      ).toBe(false)

      // Shut down the signaling server completely; P2P DataChannel MUST continue uninterrupted
      await sig.stop()
      expect(sig.isListening()).toBe(false)

      const sessions = await client.request('session.list')
      expect(sessions).toEqual([{ id: 's-nat', title: 'NAT Matrix Session' }])

      const live = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout awaiting P2P event after signaling stop')), 2000)
        const unsub = client.onEvent((evt) => {
          clearTimeout(timer)
          unsub()
          resolve(evt as Record<string, unknown>)
        })
      })
      runtime.ingestSessionEventBatch('s-nat', {
        log: [{ seq: 1, type: 'nat/post-signaling', data: { ok: true } }],
      })
      const evt = await live
      expect((evt.event as { type: string }).type).toBe('nat/post-signaling')

      client.close()
    } finally {
      await runtime.stop()
      await sig.stop()
      await stun.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed cleanly under symmetric/UDP-blocked NAT matrix without hanging or falling back to plaintext/3p STUN', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-r3-nat-blocked-'))
    const hostStore = new FileHostIdentityStore(join(dir, 'host.json'))
    const trustStore = new InMemoryDeviceTrustStore()

    const sig = new SelfHostedSignalingServer({ enabled: true, host: '127.0.0.1', port: 0 })
    await sig.start()

    const dropAllUdpPairs = () => false

    const runtime = new RemoteHostRuntime({
      seams: fakeSeams(),
      trustStore,
      hostIdentityStore: hostStore,
      carrier: { enabled: false },
      webrtc: {
        enabled: true,
        signalingUrl: sig.getEndpointUrl()!,
        iceConnectTimeoutMs: 400,
        ice: {
          iceInterfaceAddresses: { udp4: '127.0.0.1' },
          iceFilterCandidatePair: dropAllUdpPairs,
        },
      },
    })
    await runtime.start()

    try {
      const host = await hostStore.loadOrCreate()
      const keys = clientKeyPair()
      trustStore.trustSync({
        staticPublicKey: keys.publicKey,
        displayName: 'Blocked NAT Peer',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client = new WebRtcClientCarrier({
        clientKeyPair: keys,
        hostPublicKey: host.identity.publicKey,
        signalingUrl: sig.getEndpointUrl()!,
        iceConnectTimeoutMs: 400,
        ice: {
          iceInterfaceAddresses: { udp4: '127.0.0.1' },
          iceFilterCandidatePair: dropAllUdpPairs,
        },
      })

      await expect(client.connect()).rejects.toThrow()
      expect(client.isOpen()).toBe(false)

      // Allow host iceConnectTimeoutMs to sweep half-open peer cleanly
      await new Promise((r) => setTimeout(r, 450))
      expect(runtime.webrtc?.getActiveConnectionCount()).toBe(0)
    } finally {
      await runtime.stop()
      await sig.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
