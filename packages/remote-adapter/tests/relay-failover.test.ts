import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-ignore - noise-handshake/dh.js
import dh from 'noise-handshake/dh.js'
import {
  BlindRelayServer,
  createPairingBootstrapDescriptor,
  FailoverRemoteClient,
  FileHostIdentityStore,
  HostRelayCarrier,
  InMemoryDeviceTrustStore,
  PairingCoordinator,
  PairingTokenRegistry,
  parsePairingBootstrapDescriptor,
  RelayClientCarrier,
  RemoteHostRuntime,
  SelfHostedSignalingServer,
  SelfHostedStunServer,
  type BlindRelayFrameObservation,
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
      return [{ id: 's-r4', title: 'R4 Failover Session' }]
    },
    async assertSession(sessionId) {
      if (sessionId !== 's-r4') throw new Error('missing session')
    },
    async followup(sessionId, prompt) {
      calls.followup += 1
      return { sessionId, prompt, turnId: `t-r4-${calls.followup}` }
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

async function allocateClosedPort(): Promise<number> {
  const srv = createServer()
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()))
  const addr = srv.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  await new Promise<void>((resolve) => srv.close(() => resolve()))
  return port
}

function sendBinaryJsonAndWaitClose(
  url: string,
  payload: unknown,
  sendAsText = false,
): Promise<{
  firstMessage?: Record<string, unknown>
  closeCode: number
  closeReason: string
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    let firstMessage: Record<string, unknown> | undefined
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {}
      reject(new Error(`timeout waiting close from ${url}`))
    }, 3_000)

    ws.onopen = () => {
      if (sendAsText) {
        ws.send(JSON.stringify(payload))
      } else {
        ws.send(new TextEncoder().encode(JSON.stringify(payload)))
      }
    }

    ws.onmessage = (evt) => {
      if (firstMessage !== undefined) return
      try {
        const text =
          typeof evt.data === 'string'
            ? evt.data
            : new TextDecoder().decode(new Uint8Array(evt.data as ArrayBuffer))
        firstMessage = JSON.parse(text) as Record<string, unknown>
      } catch {}
    }

    ws.onclose = (evt) => {
      clearTimeout(timer)
      resolve({
        firstMessage,
        closeCode: evt.code,
        closeReason: evt.reason,
      })
    }

    ws.onerror = () => {}
  })
}

describe('R4 Blind Relay Server, HostRelayCarrier, and Multi-Path Failover', () => {
  it('enforces fail-closed defaults, wildcard guards, and descriptor relay fields', async () => {
    const disabledRelay = new BlindRelayServer({ host: '127.0.0.1', port: 0 })
    await expect(disabledRelay.start()).rejects.toThrow('disabled by default')

    const wildcardRelay = new BlindRelayServer({
      enabled: true,
      host: '0.0.0.0',
      port: 0,
    })
    await expect(wildcardRelay.start()).rejects.toThrow('allowWildcardHost')

    const invalidIpRelay = new BlindRelayServer({
      enabled: true,
      host: 'not-an-ip',
      port: 0,
    })
    await expect(invalidIpRelay.start()).rejects.toThrow('explicit IP address')

    const dir = mkdtempSync(join(tmpdir(), 'dsh-r4-failclosed-'))
    try {
      const hostStore = new FileHostIdentityStore(join(dir, 'host.json'))
      const trustStore = new InMemoryDeviceTrustStore()
      const { seams } = fakeSeams()
      const coreHost = new HostRelayCarrier({
        enabled: false,
        relayUrl: 'ws://127.0.0.1:9999',
        core: new (await import('../src/core.js')).RemoteAdapterCore(seams, {
          trustStore,
          hostIdentityStore: hostStore,
        }),
        trustStore,
        hostIdentityStore: hostStore,
      })
      await expect(coreHost.start()).rejects.toThrow('disabled by default')

      const host = await hostStore.loadOrCreate()
      const validDescriptor = createPairingBootstrapDescriptor({
        protocolVersion: 1,
        hostPublicKey: host.identity.publicKey,
        bootstrapToken: 'pair-token-r4',
        endpointUrl: 'ws://127.0.0.1:7777/ws',
        signalingUrl: 'ws://127.0.0.1:7778',
        signalingRoomId: 'room_signaling_01',
        stunUrls: ['stun:127.0.0.1:3478'],
        relayUrl: 'ws://127.0.0.1:7779',
        relayRoomId: 'room_relay_r4_01',
        expiresAt: Date.now() + 60_000,
      })
      const parsed = parsePairingBootstrapDescriptor(JSON.stringify(validDescriptor))
      expect(parsed.relayUrl).toBe('ws://127.0.0.1:7779')
      expect(parsed.relayRoomId).toBe('room_relay_r4_01')

      expect(() =>
        createPairingBootstrapDescriptor({
          protocolVersion: 1,
          hostPublicKey: host.identity.publicKey,
          bootstrapToken: 'pair-token-r4',
          endpointUrl: 'ws://127.0.0.1:7777/ws',
          relayUrl: 'http://127.0.0.1:7779',
          expiresAt: Date.now() + 60_000,
        }),
      ).toThrow('invalid relayUrl')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enforces relay auth, anti-room-hijack, binary-only framing, rate/size/per-IP caps, and bounded backpressure', async () => {
    const relay = new BlindRelayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      hostAuthSecret: 'relay-host-secret-1',
      maxClientsPerRoom: 1,
      maxConnectionsPerIp: 4,
      maxOpaquePayloadBytes: 256,
      maxFramesPerSecond: 6,
      maxOutboundQueue: 32,
      maxOutboundBytes: 65_536,
    })
    await relay.start()

    const dir = mkdtempSync(join(tmpdir(), 'dsh-r4-relay-security-'))
    const hostStore = new FileHostIdentityStore(join(dir, 'host.json'))
    const trustStore = new InMemoryDeviceTrustStore()
    const { seams } = fakeSeams()
    const runtime = new RemoteHostRuntime({
      seams,
      trustStore,
      hostIdentityStore: hostStore,
      carrier: { enabled: false },
      relay: {
        enabled: true,
        relayUrl: relay.getEndpointUrl()!,
        roomId: 'room-security-r4',
        hostAuthSecret: 'relay-host-secret-1',
        clientToken: 'relay-client-token-1',
      },
    })

    try {
      const url = relay.getEndpointUrl()!

      // 1. Reject TEXT opcode during registration
      const textReject = await sendBinaryJsonAndWaitClose(
        url,
        { v: 1, type: 'relay.client.join', roomId: 'room-security-r4' },
        true,
      )
      expect(textReject.closeCode).toBe(1003)

      // 2. Reject invalid hostAuthSecret
      const wrongSecret = await sendBinaryJsonAndWaitClose(url, {
        v: 1,
        type: 'relay.host.register',
        roomId: 'room-security-r4',
        hostAuthSecret: 'wrong-secret',
      })
      expect(wrongSecret.firstMessage?.code).toBe('AUTH_FAILED')
      expect(wrongSecret.closeCode).toBe(1008)

      // Start legitimate Host room
      await runtime.start()
      expect(runtime.relay?.isListening()).toBe(true)

      // 3. Anti-hijack: even knowing hostAuthSecret cannot take over an occupied room
      const hijackAttempt = await sendBinaryJsonAndWaitClose(url, {
        v: 1,
        type: 'relay.host.register',
        roomId: 'room-security-r4',
        hostAuthSecret: 'relay-host-secret-1',
      })
      expect(hijackAttempt.firstMessage?.code).toBe('ROOM_OCCUPIED')
      expect(hijackAttempt.closeCode).toBe(1008)

      // 4. Client with wrong clientToken is rejected
      const badClientToken = await sendBinaryJsonAndWaitClose(url, {
        v: 1,
        type: 'relay.client.join',
        roomId: 'room-security-r4',
        clientToken: 'wrong-client-token',
      })
      expect(badClientToken.firstMessage?.code).toBe('AUTH_FAILED')
      expect(badClientToken.closeCode).toBe(1008)

      // 5. Unknown room fails closed
      const unknownRoom = await sendBinaryJsonAndWaitClose(url, {
        v: 1,
        type: 'relay.client.join',
        roomId: 'nonexistent-room-99',
      })
      expect(unknownRoom.firstMessage?.code).toBe('ROOM_UNKNOWN')
      expect(unknownRoom.closeCode).toBe(1008)

      // 6. Connect valid client (fills maxClientsPerRoom = 1)
      const ws1 = new WebSocket(url)
      ws1.binaryType = 'arraybuffer'
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws1 join timeout')), 2_000)
        ws1.onopen = () => {
          ws1.send(
            new TextEncoder().encode(
              JSON.stringify({
                v: 1,
                type: 'relay.client.join',
                roomId: 'room-security-r4',
                clientToken: 'relay-client-token-1',
              }),
            ),
          )
        }
        ws1.onmessage = (evt) => {
          const msg = JSON.parse(
            new TextDecoder().decode(new Uint8Array(evt.data as ArrayBuffer)),
          ) as Record<string, unknown>
          if (msg.type === 'relay.client.joined') {
            clearTimeout(timer)
            resolve()
          }
        }
        ws1.onerror = () => reject(new Error('ws1 error'))
      })

      // 7. Second client hits ROOM_FULL
      const roomFull = await sendBinaryJsonAndWaitClose(url, {
        v: 1,
        type: 'relay.client.join',
        roomId: 'room-security-r4',
        clientToken: 'relay-client-token-1',
      })
      expect(roomFull.firstMessage?.code).toBe('ROOM_FULL')

      // 8. Oversized blind payload (> 256 bytes) is dropped with WebSocket 1009
      const oversizedClose = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('oversized close timeout')), 2_000)
        ws1.onclose = (evt) => {
          clearTimeout(timer)
          resolve(evt.code)
        }
        ws1.send(new Uint8Array(400).fill(0xab))
      })
      expect(oversizedClose).toBe(1009)
      expect(relay.getStats().droppedOversized).toBeGreaterThanOrEqual(1)

      // 9. Flood rate limit closes abusive client (maxFramesPerSecond = 6)
      const ws2 = new WebSocket(url)
      ws2.binaryType = 'arraybuffer'
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws2 join timeout')), 2_000)
        ws2.onopen = () => {
          ws2.send(
            new TextEncoder().encode(
              JSON.stringify({
                v: 1,
                type: 'relay.client.join',
                roomId: 'room-security-r4',
                clientToken: 'relay-client-token-1',
              }),
            ),
          )
        }
        ws2.onmessage = (evt) => {
          const msg = JSON.parse(
            new TextDecoder().decode(new Uint8Array(evt.data as ArrayBuffer)),
          ) as Record<string, unknown>
          if (msg.type === 'relay.client.joined') {
            clearTimeout(timer)
            resolve()
          }
        }
      })
      const rateLimitClose = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('rate limit timeout')), 2_000)
        ws2.onclose = (evt) => {
          clearTimeout(timer)
          resolve(evt.code)
        }
        for (let i = 0; i < 12; i += 1) {
          ws2.send(new Uint8Array(32).fill(i))
        }
      })
      expect(rateLimitClose).toBe(1008)
      expect(relay.getStats().droppedRateLimited).toBeGreaterThanOrEqual(1)

      // 10. maxConnectionsPerIp caps flood of idle sockets from single IP
      // Note host takes 1 slot, so opening 5 concurrent raw sockets hits cap 4
      const sockets: WebSocket[] = []
      let rejectedByIpCap = 0
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('per-IP cap check timeout')), 2_000)
        for (let i = 0; i < 5; i += 1) {
          const s = new WebSocket(url)
          let counted = false
          const markRejected = () => {
            if (!counted) {
              counted = true
              rejectedByIpCap += 1
              if (relay.getStats().rejectedPerIpCap >= 1 && rejectedByIpCap >= 1) {
                clearTimeout(timer)
                resolve()
              }
            }
          }
          s.onerror = markRejected
          s.onclose = markRejected
          sockets.push(s)
        }
      })
      expect(relay.getStats().rejectedPerIpCap).toBeGreaterThanOrEqual(1)
      expect(rejectedByIpCap).toBeGreaterThanOrEqual(1)
      for (const s of sockets) {
        try {
          s.close()
        } catch {}
      }

      // 11. Dedicated bounded outbound queue backpressure check
      const tightRelay = new BlindRelayServer({
        enabled: true,
        host: '127.0.0.1',
        port: 0,
        maxOutboundQueue: 2,
        maxOutboundBytes: 256,
      })
      await tightRelay.start()
      try {
        const tightUrl = tightRelay.getEndpointUrl()!
        const bpDir = mkdtempSync(join(tmpdir(), 'dsh-r4-bp-'))
        const bpHostStore = new FileHostIdentityStore(join(bpDir, 'host.json'))
        const bpTrust = new InMemoryDeviceTrustStore()
        const bpRuntime = new RemoteHostRuntime({
          seams,
          trustStore: bpTrust,
          hostIdentityStore: bpHostStore,
          carrier: { enabled: false },
          relay: { enabled: true, relayUrl: tightUrl, roomId: 'room-backpressure-01' },
        })
        await bpRuntime.start()
        try {
          const sender = new WebSocket(tightUrl)
          sender.binaryType = 'arraybuffer'
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('bp join timeout')), 2_000)
            sender.onopen = () => {
              sender.send(
                new TextEncoder().encode(
                  JSON.stringify({ v: 1, type: 'relay.client.join', roomId: 'room-backpressure-01' }),
                ),
              )
            }
            sender.onmessage = (evt) => {
              const msg = JSON.parse(
                new TextDecoder().decode(new Uint8Array(evt.data as ArrayBuffer)),
              ) as Record<string, unknown>
              if (msg.type === 'relay.client.joined') {
                clearTimeout(timer)
                resolve()
              }
            }
          })
          const senderClosed = new Promise<number>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('bp close timeout')), 2_000)
            sender.onclose = (evt) => {
              clearTimeout(timer)
              resolve(evt.code)
            }
            for (let i = 0; i < 6; i += 1) {
              sender.send(new Uint8Array(120).fill(0x55))
            }
          })
          await senderClosed
          expect(tightRelay.getStats().droppedBackpressure).toBeGreaterThanOrEqual(1)
        } finally {
          await bpRuntime.stop()
          rmSync(bpDir, { recursive: true, force: true })
        }
      } finally {
        await tightRelay.stop()
      }
    } finally {
      await runtime.stop()
      await relay.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('proves blind relay sees strictly ciphertext, fails over LAN->WebRTC->Relay preserving epoch/resume/idempotency, and enforces revocation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-r4-failover-'))
    const hostStore = new FileHostIdentityStore(join(dir, 'host.json'))
    const trustStore = new InMemoryDeviceTrustStore()
    const tokenRegistry = new PairingTokenRegistry()
    const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry)
    const { seams, calls } = fakeSeams()

    const stun = new SelfHostedStunServer({ enabled: true, host: '127.0.0.1', port: 0 })
    const sig = new SelfHostedSignalingServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      hostAuthSecret: 'r4-sig-secret',
    })
    const observedRelayFrames: BlindRelayFrameObservation[] = []
    const relay = new BlindRelayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      hostAuthSecret: 'r4-relay-secret',
      onBlindFrame: (obs) => observedRelayFrames.push(obs),
    })

    await stun.start()
    await sig.start()
    await relay.start()

    const runtime = new RemoteHostRuntime({
      seams,
      trustStore,
      hostIdentityStore: hostStore,
      pairingCoordinator: coordinator,
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
      webrtc: {
        enabled: true,
        signalingUrl: sig.getEndpointUrl()!,
        hostAuthSecret: 'r4-sig-secret',
        joinToken: 'r4-webrtc-join',
        ice: {
          stunUrls: [stun.getStunUrl()!],
          iceInterfaceAddresses: { udp4: '127.0.0.1' },
          iceStunGatherTimeoutSec: 1,
        },
      },
      relay: {
        enabled: true,
        relayUrl: relay.getEndpointUrl()!,
        hostAuthSecret: 'r4-relay-secret',
        clientToken: 'r4-relay-client-token',
      },
    })
    await runtime.start()

    try {
      const host = await hostStore.loadOrCreate()
      const tokenRecord = tokenRegistry.createToken({
        trustDomainId: host.identity.trustDomainId,
        hostGeneration: host.identity.generation,
        allowedCapabilities: ['observe', 'prompt', 'approve', 'answer-question'],
        ttlMs: 60_000,
      })

      const deadPort1 = await allocateClosedPort()
      const deadPort2 = await allocateClosedPort()
      const keys = clientKeyPair()

      // A. Ordered fallback LAN (dead) -> WebRTC (dead) -> Relay (healthy) for initial pairing + authorized ops
      const blindClient = new FailoverRemoteClient({
        clientKeyPair: keys,
        hostPublicKey: host.identity.publicKey,
        priorityOrder: ['lan', 'webrtc', 'relay'],
        lan: { endpointUrl: `ws://127.0.0.1:${deadPort1}/ws` },
        webrtc: {
          signalingUrl: `ws://127.0.0.1:${deadPort2}`,
          roomId: host.identity.fingerprint,
          joinToken: 'r4-webrtc-join',
          iceConnectTimeoutMs: 600,
          ice: { stunUrls: [stun.getStunUrl()!], iceInterfaceAddresses: { udp4: '127.0.0.1' } },
        },
        relay: {
          relayUrl: relay.getEndpointUrl()!,
          roomId: runtime.relay!.getRoomId()!,
          clientToken: 'r4-relay-client-token',
        },
      })

      await blindClient.connect()
      expect(blindClient.getActiveTransportKind()).toBe('relay')
      expect(blindClient.getFailoverHistory().map((h) => [h.kind, h.status])).toEqual([
        ['lan', 'failed'],
        ['webrtc', 'failed'],
        ['relay', 'connected'],
      ])

      const sensitivePrompt = 'SECRET_R4_PROMPT_CANNOT_BE_READ_BY_RELAY'
      const sensitiveApprovalCall = 'call_r4_secret_approval_987'
      const candidate = await blindClient.request('pairing.request', {
        token: tokenRecord.token,
        displayName: 'R4 Failover Mobile',
      })
      await coordinator.confirmPairing({
        candidateId: candidate.candidateId,
        grantedCapabilities: ['observe', 'prompt', 'approve', 'answer-question'],
      })
      blindClient.close()

      await blindClient.reconnectWithBackoff({ initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 2 })
      expect(blindClient.getActiveTransportKind()).toBe('relay')
      expect(await blindClient.request('session.list')).toEqual([
        { id: 's-r4', title: 'R4 Failover Session' },
      ])

      const relayPromptRes = await blindClient.request(
        'prompt.submit',
        { sessionId: 's-r4', prompt: sensitivePrompt },
        { idempotencyKey: 'r4-idem-prompt-1' },
      )
      expect(relayPromptRes.turnId).toBe('t-r4-1')
      await blindClient.request(
        'approval.respond',
        { callId: sensitiveApprovalCall, decision: 'approved' },
        { idempotencyKey: 'r4-idem-appr-1' },
      )
      expect(calls.approval).toBe(1)

      // Live stream event arrives over Blind Relay + is acknowledged cleanly
      const liveRelayEvent = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('live relay event timeout')), 2_000)
        const unsub = blindClient.onEvent((evt) => {
          const rec = evt as Record<string, unknown>
          if (rec?.type === 'stream.event' && rec?.sessionId === 's-r4') {
            clearTimeout(timer)
            unsub()
            resolve(rec)
          }
        })
      })
      runtime.ingestSessionEventBatch('s-r4', {
        log: [{ seq: 1, type: 'assistant/chunk', data: { text: 'SECRET_R4_STREAM_TEXT_1' } }],
      })
      const evt1 = await liveRelayEvent
      expect((evt1.event as { seq: number }).seq).toBe(1)
      await blindClient.acknowledgeSessionSeq('s-r4', 1)
      blindClient.close()

      // Prove BlindRelayServer observed >= 8 opaque frames and ZERO plaintext leakage
      expect(observedRelayFrames.length).toBeGreaterThanOrEqual(8)
      const forbiddenPlaintexts = [
        sensitivePrompt,
        sensitiveApprovalCall,
        'SECRET_R4_STREAM_TEXT_1',
        tokenRecord.token,
        's-r4',
        'R4 Failover Session',
        'R4 Failover Mobile',
        'r4-relay-secret',
        'r4-relay-client-token',
        blindClient.deviceId,
      ]
      for (const frame of observedRelayFrames) {
        const rawUtf8 = Buffer.from(frame.payload).toString('utf8')
        const rawHex = Buffer.from(frame.payload).toString('hex')
        for (const secret of forbiddenPlaintexts) {
          expect(rawUtf8).not.toContain(secret)
          expect(rawHex).not.toContain(Buffer.from(secret, 'utf8').toString('hex'))
        }
      }

      // B. Full multi-path client prefers LAN first when LAN is reachable, then degrades LAN -> WebRTC -> Relay!
      const multiClient = new FailoverRemoteClient({
        clientKeyPair: keys,
        hostPublicKey: host.identity.publicKey,
        lan: { endpointUrl: runtime.carrier.getEndpointUrl()! },
        webrtc: {
          signalingUrl: sig.getEndpointUrl()!,
          roomId: runtime.webrtc!.getRoomId()!,
          joinToken: 'r4-webrtc-join',
          iceConnectTimeoutMs: 5_000,
          ice: {
            stunUrls: [stun.getStunUrl()!],
            iceInterfaceAddresses: { udp4: '127.0.0.1' },
            iceStunGatherTimeoutSec: 1,
          },
        },
        relay: {
          relayUrl: relay.getEndpointUrl()!,
          roomId: runtime.relay!.getRoomId()!,
          clientToken: 'r4-relay-client-token',
        },
      })

      await multiClient.connect()
      expect(multiClient.getActiveTransportKind()).toBe('lan')
      const lanEpoch = multiClient.getConnectionEpoch()
      const initialResume = (await multiClient.resumeSession('s-r4')) as {
        kind: string
        events: { seq: number }[]
      }
      expect(initialResume.kind).toBe('events')
      expect(initialResume.events.map((e) => e.seq)).toEqual([1])

      // Emit seq 2 while disconnected -> then kill LAN -> reconnectAndResume degrades to WebRTC P2P!
      multiClient.close()
      runtime.ingestSessionEventBatch('s-r4', {
        log: [{ seq: 2, type: 'assistant/chunk', data: { text: 'missed-during-lan-cutover' } }],
      })
      await runtime.carrier.stop()

      const webrtcResume = await multiClient.reconnectAndResume(['s-r4'], {
        initialDelayMs: 5,
        maxDelayMs: 10,
        maxAttempts: 2,
      })
      expect(multiClient.getActiveTransportKind()).toBe('webrtc')
      const webrtcEpoch = multiClient.getConnectionEpoch()
      expect(webrtcEpoch).toBeGreaterThan(lanEpoch)
      expect(
        (webrtcResume['s-r4'] as { kind: string; events: { seq: number }[] }).events.map(
          (e) => e.seq,
        ),
      ).toEqual([1, 2])
      await multiClient.acknowledgeSessionSeq('s-r4', 2)

      // Same idempotencyKey submitted earlier on Relay is deduplicated over WebRTC (no duplicate followup!)
      const dedupedOnWebrtc = await multiClient.request(
        'prompt.submit',
        { sessionId: 's-r4', prompt: sensitivePrompt },
        { idempotencyKey: 'r4-idem-prompt-1' },
      )
      expect(dedupedOnWebrtc.turnId).toBe('t-r4-1')
      expect(calls.followup).toBe(1)

      // Now cut WebRTC signaling/carrier -> emit seq 3 -> reconnectAndResume degrades to Blind Relay!
      multiClient.close()
      runtime.ingestSessionEventBatch('s-r4', {
        log: [{ seq: 3, type: 'assistant/done', data: { text: 'missed-during-webrtc-cutover' } }],
      })
      await runtime.webrtc!.stop()
      await sig.stop()

      const relayResume = await multiClient.reconnectAndResume(['s-r4'], {
        initialDelayMs: 5,
        maxDelayMs: 10,
        maxAttempts: 2,
      })
      expect(multiClient.getActiveTransportKind()).toBe('relay')
      const relayEpoch = multiClient.getConnectionEpoch()
      expect(relayEpoch).toBeGreaterThan(webrtcEpoch)
      expect(
        (relayResume['s-r4'] as { kind: string; events: { seq: number }[] }).events.map(
          (e) => e.seq,
        ),
      ).toEqual([3])

      // Verify immediate device revocation kicks active Relay client and blocks reconnect
      const waitClosed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('revocation disconnect timeout')), 2_000)
        const poll = setInterval(() => {
          if (!multiClient.isOpen()) {
            clearInterval(poll)
            clearTimeout(timer)
            resolve()
          }
        }, 20)
      })
      await trustStore.revoke(multiClient.deviceId, 'r4-compromised-device')
      await waitClosed
      expect(multiClient.isOpen()).toBe(false)

      const revokedCarrier = new RelayClientCarrier({
        clientKeyPair: keys,
        hostPublicKey: host.identity.publicKey,
        relayUrl: relay.getEndpointUrl()!,
        roomId: runtime.relay!.getRoomId()!,
        clientToken: 'r4-relay-client-token',
      })
      await expect(revokedCarrier.connect()).rejects.toThrow()
      revokedCarrier.close()
      multiClient.close()
    } finally {
      await runtime.stop()
      await relay.stop()
      await sig.stop()
      await stun.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
