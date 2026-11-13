import { createSocket } from 'node:dgram'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-ignore - noise-handshake/dh.js
import dh from 'noise-handshake/dh.js'
import {
  buildStunBindingRequest,
  buildStunBindingResponse,
  createConfiguredPeerConnection,
  createPairingBootstrapDescriptor,
  DataChannelFrameReassembler,
  encodeDataChannelChunks,
  FileHostIdentityStore,
  HostWebRtcCarrier,
  InMemoryDeviceTrustStore,
  LanClientCarrier,
  PairingCoordinator,
  PairingTokenRegistry,
  parsePairingBootstrapDescriptor,
  parseStunPacket,
  parseStunXorMappedAddress,
  RemoteClientSession,
  RemoteHostRuntime,
  SelfHostedSignalingServer,
  SelfHostedStunServer,
  SignalingClient,
  stunBindingProbe,
  validateSelfOwnedStunUrls,
  verifyStunFingerprint,
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

function fakeSeams() {
  const calls = { followup: 0, approval: 0, question: 0 }
  const seams: OfficialRemoteSeams = {
    async listSessions() {
      return [{ id: 's1', title: 'R3 Session' }]
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

describe('R3 STUN, Signaling, and WebRTC P2P carrier', () => {
  it('enforces fail-closed default and RFC 5389 XOR-MAPPED-ADDRESS + FINGERPRINT on STUN server', async () => {
    const disabled = new SelfHostedStunServer({ host: '127.0.0.1', port: 0 })
    await expect(disabled.start()).rejects.toThrow('disabled by default')

    const stun = new SelfHostedStunServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      maxRequestsPerSecondPerIp: 3,
      maxPacketBytes: 64,
    })
    await stun.start()
    try {
      const addr = stun.getBoundAddress()!
      const mapped = await stunBindingProbe({
        serverHost: addr.host,
        serverPort: addr.port,
      })
      expect(mapped.family).toBe('IPv4')
      expect(mapped.address).toBe('127.0.0.1')
      expect(mapped.port).toBeGreaterThan(0)

      // Send malformed and oversized UDP packets -> must drop without crashing
      const probe = createSocket('udp4')
      try {
        await new Promise<void>((resolve) => probe.bind(0, '127.0.0.1', resolve))
        await new Promise<void>((resolve, reject) =>
          probe.send(Buffer.from('not-stun'), addr.port, addr.host, (e) => (e ? reject(e) : resolve())),
        )
        await new Promise<void>((resolve, reject) =>
          probe.send(Buffer.alloc(128, 0xaa), addr.port, addr.host, (e) => (e ? reject(e) : resolve())),
        )

        // Burst more than maxRequestsPerSecondPerIp (3)
        for (let i = 0; i < 6; i += 1) {
          await new Promise<void>((resolve, reject) =>
            probe.send(buildStunBindingRequest(), addr.port, addr.host, (e) => (e ? reject(e) : resolve())),
          )
        }
        await new Promise((r) => setTimeout(r, 50))
      } finally {
        probe.close()
      }

      const stats = stun.getStats()
      expect(stats.droppedMalformed).toBe(2)
      expect(stats.droppedRateLimited).toBe(4)
      expect(stats.responsesSent).toBe(3)
    } finally {
      await stun.stop()
    }

    // Verify IPv6 XOR-MAPPED-ADDRESS + CRC32 FINGERPRINT encode/decode round-trip
    const txId = Buffer.from('0123456789ab')
    const v6Resp = buildStunBindingResponse({
      transactionId: txId,
      remoteAddress: '2001:db8::42',
      remotePort: 54321,
    })
    const parsedV6 = parseStunPacket(v6Resp)!
    expect(verifyStunFingerprint(parsedV6)).toBe(true)
    expect(parseStunXorMappedAddress(parsedV6)).toEqual({
      family: 'IPv6',
      address: '2001:db8:0:0:0:0:0:42',
      port: 54321,
    })
  })

  it('hardens signaling against host hijack, unauthenticated join, peer spoofing, and forbidden payload smuggling', async () => {
    const disabled = new SelfHostedSignalingServer({ host: '127.0.0.1', port: 0 })
    await expect(disabled.start()).rejects.toThrow('disabled by default')

    const wildcard = new SelfHostedSignalingServer({ enabled: true, host: '0.0.0.0', port: 0 })
    await expect(wildcard.start()).rejects.toThrow('wildcard binding')

    const sig = new SelfHostedSignalingServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      hostAuthSecret: 'sig-host-secret-1',
    })
    await sig.start()
    try {
      const url = sig.getEndpointUrl()!

      // Wrong hostAuthSecret rejected fail-closed
      const badHost = new SignalingClient(url)
      await expect(
        badHost.registerHost({ roomId: 'room-alpha-1', hostAuthSecret: 'wrong' }),
      ).rejects.toThrow()
      badHost.close()

      // Legitimate Host registers with joinToken requirement
      const hostClient = new SignalingClient(url)
      const registered = await hostClient.registerHost({
        roomId: 'room-alpha-1',
        hostAuthSecret: 'sig-host-secret-1',
        joinToken: 'join-tok-123',
      })
      expect(registered.roomId).toBe('room-alpha-1')

      // Hijack attempt for already-occupied room fails
      const hijackHost = new SignalingClient(url)
      await expect(
        hijackHost.registerHost({
          roomId: 'room-alpha-1',
          hostAuthSecret: 'sig-host-secret-1',
        }),
      ).rejects.toThrow('ROOM_OCCUPIED')
      hijackHost.close()

      // Wrong joinToken rejected
      const badJoin = new SignalingClient(url)
      await expect(
        badJoin.joinRoom({ roomId: 'room-alpha-1', joinToken: 'bad-token' }),
      ).rejects.toThrow()
      badJoin.close()

      // Client1 & Client2 join legitimately; Client1 cannot message Client2 or spoof fromPeerId
      const c1 = new SignalingClient(url)
      const c2 = new SignalingClient(url)
      const j1 = await c1.joinRoom({ roomId: 'room-alpha-1', joinToken: 'join-tok-123' })
      const j2 = await c2.joinRoom({ roomId: 'room-alpha-1', joinToken: 'join-tok-123' })

      let c2Received = 0
      c2.setHandlers({ onOffer: () => { c2Received += 1 } })

      // Attempt client-to-client routing -> denied
      c1.sendOffer(j2.peerId, { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' })

      // Attempt to smuggle extra credential field in rtc.offer -> stripped by server whitelist
      const receivedByHost = await new Promise<Record<string, unknown>>((resolve) => {
        hostClient.setHandlers({
          onOffer: (msg) => resolve(msg as unknown as Record<string, unknown>),
        })
        ;(c1 as unknown as { sendMessage: (p: Record<string, unknown>) => void }).sendMessage({
          v: 1,
          type: 'rtc.offer',
          roomId: 'room-alpha-1',
          fromPeerId: j2.peerId, // spoofed sender attempt
          toPeerId: j1.hostPeerId,
          sdp: { type: 'offer', sdp: 'v=0\r\ns=-\r\n', secretApiKey: 'sk-smuggled' },
          providerCredentials: { token: 'leaked' },
        })
      })

      expect(receivedByHost.fromPeerId).toBe(j1.peerId)
      expect((receivedByHost as Record<string, unknown>).providerCredentials).toBeUndefined()
      expect(
        (receivedByHost.sdp as Record<string, unknown>).secretApiKey,
      ).toBeUndefined()
      expect(c2Received).toBe(0)
      expect(sig.getStats().rejectedMessages).toBeGreaterThanOrEqual(1)

      c1.close()
      c2.close()
      hostClient.close()
    } finally {
      await sig.stop()
    }
  })

  it('rejects third-party default STUN fallback and non-stun ICE URLs', async () => {
    expect(() => validateSelfOwnedStunUrls(['turn:relay.example.com:3478'])).toThrow(
      'R3 permits only self-owned stun:',
    )
    const pc = createConfiguredPeerConnection({ stunUrls: ['stun:127.0.0.1:3478'] })
    try {
      expect(pc.config.iceUseDefaultStunServer).toBe(false)
      expect(pc.getConfiguration().iceServers).toEqual([{ urls: ['stun:127.0.0.1:3478'] }])
    } finally {
      await pc.close()
    }
  })

  it('chunks and reassembles large frames and fails closed before allocating oversized frames', () => {
    const payload = new Uint8Array(40_000)
    payload.fill(0x5a)
    const chunks = encodeDataChannelChunks(payload, 65_536, 16_000)
    expect(chunks.length).toBe(3)

    const reassembler = new DataChannelFrameReassembler(65_536)
    expect(reassembler.push(chunks[0]!)).toBeUndefined()
    expect(reassembler.push(chunks[1]!)).toBeUndefined()
    const out = reassembler.push(chunks[2]!)!
    expect(Buffer.from(out).equals(Buffer.from(payload))).toBe(true)

    const tightReassembler = new DataChannelFrameReassembler(20_000)
    expect(tightReassembler.push(chunks[0]!)).toBeUndefined()
    expect(() => tightReassembler.push(chunks[1]!)).toThrow('exceeds maxFrameBytes')
  })

  it('pairs, authorizes, resumes, mutates, broadcasts events, fails over LAN<->WebRTC idempotently, and enforces revocation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-r3-p2p-'))
    const hostStore = new FileHostIdentityStore(join(dir, 'host-identity.json'))
    const trustStore = new InMemoryDeviceTrustStore()
    const tokenRegistry = new PairingTokenRegistry()
    const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry)
    const { seams, calls } = fakeSeams()

    const stun = new SelfHostedStunServer({ enabled: true, host: '127.0.0.1', port: 0 })
    const sig = new SelfHostedSignalingServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      hostAuthSecret: 'r3-host-auth',
    })
    await stun.start()
    await sig.start()

    const runtime = new RemoteHostRuntime({
      seams,
      trustStore,
      hostIdentityStore: hostStore,
      pairingCoordinator: coordinator,
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
      webrtc: {
        enabled: true,
        signalingUrl: sig.getEndpointUrl()!,
        hostAuthSecret: 'r3-host-auth',
        joinToken: 'r3-room-join',
        ice: {
          stunUrls: [stun.getStunUrl()!],
          iceInterfaceAddresses: { udp4: '127.0.0.1' },
          iceStunGatherTimeoutSec: 1,
        },
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

      const qr = createPairingBootstrapDescriptor({
        protocolVersion: 1,
        hostPublicKey: host.identity.publicKey,
        bootstrapToken: tokenRecord.token,
        endpointUrl: runtime.carrier.getEndpointUrl()!,
        signalingUrl: sig.getEndpointUrl()!,
        signalingRoomId: host.identity.fingerprint,
        stunUrls: [stun.getStunUrl()!],
        expiresAt: tokenRecord.expiresAt,
      })
      const parsedQr = parsePairingBootstrapDescriptor(JSON.stringify(qr))
      expect(parsedQr.signalingUrl).toBe(sig.getEndpointUrl())
      expect(parsedQr.stunUrls).toEqual([stun.getStunUrl()])

      const keys = clientKeyPair()
      const webrtcClient = new WebRtcClientCarrier({
        clientKeyPair: keys,
        hostPublicKey: Buffer.from(parsedQr.hostPublicKeyHex, 'hex'),
        signalingUrl: parsedQr.signalingUrl!,
        roomId: parsedQr.signalingRoomId!,
        joinToken: 'r3-room-join',
        ice: {
          stunUrls: parsedQr.stunUrls,
          iceInterfaceAddresses: { udp4: '127.0.0.1' },
          iceStunGatherTimeoutSec: 1,
        },
      })

      // 1. Unpaired WebRTC client is PAIRING_PENDING: blocks RPC, permits pairing.request
      await webrtcClient.connect()
      await expect(webrtcClient.request('session.list')).rejects.toThrow('UNAUTHORIZED_CHANNEL')
      const candidate = await webrtcClient.request('pairing.request', {
        token: parsedQr.bootstrapToken,
        displayName: 'R3 Peer',
      })
      await coordinator.confirmPairing({
        candidateId: candidate.candidateId,
        grantedCapabilities: ['observe', 'prompt', 'approve', 'answer-question'],
      })
      webrtcClient.close()

      // 2. Authorized reconnect over WebRTC DataChannel
      await webrtcClient.reconnectWithBackoff({ initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 2 })
      expect(await webrtcClient.request('session.list')).toEqual([{ id: 's1', title: 'R3 Session' }])

      // Live official event broadcast arrives over WebRTC DataChannel
      const livePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('live WebRTC event timeout')), 2000)
        const unsub = webrtcClient.onEvent((evt) => {
          const rec = evt as Record<string, unknown>
          if (rec?.type === 'stream.event' && rec?.sessionId === 's1') {
            clearTimeout(timer)
            unsub()
            resolve(rec)
          }
        })
      })
      runtime.ingestSessionEventBatch('s1', {
        log: [{ seq: 1, type: 'assistant/chunk', data: { text: 'hello over webrtc' } }],
      })
      const live = await livePromise
      expect((live.event as { seq: number }).seq).toBe(1)

      // 3. Large encrypted prompt (> 16 KiB chunked over SCTP DataChannel)
      const largePrompt = 'A'.repeat(24_000)
      const promptRes = await webrtcClient.request(
        'prompt.submit',
        { sessionId: 's1', prompt: largePrompt },
        { idempotencyKey: 'cross-path-idem-1' },
      )
      expect(promptRes.turnId).toBe('t1')
      expect(calls.followup).toBe(1)
      const webrtcEpoch = webrtcClient.getConnectionEpoch()
      webrtcClient.close()

      // 4. Switch transport from WebRTC P2P (R3) -> LAN (R2) with SAME device & idempotencyKey
      const lanClient = new LanClientCarrier({
        clientKeyPair: keys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: runtime.carrier.getEndpointUrl()!,
      })
      await lanClient.connect()
      expect(lanClient.getConnectionEpoch()).toBeGreaterThan(webrtcEpoch)

      const replayRes = await lanClient.request(
        'prompt.submit',
        { sessionId: 's1', prompt: largePrompt },
        { idempotencyKey: 'cross-path-idem-1' },
      )
      expect(replayRes).toEqual(promptRes)
      expect(calls.followup).toBe(1) // Official followup NEVER executed twice across transport switch
      const lanEpoch = lanClient.getConnectionEpoch()
      lanClient.close()

      // 5. Switch back LAN (R2) -> WebRTC P2P (R3): monotonic epoch increases and revocation terminates live channel
      await webrtcClient.connect()
      expect(webrtcClient.getConnectionEpoch()).toBeGreaterThan(lanEpoch)
      await webrtcClient.request('approval.respond', { callId: 'c1', decision: 'approved' }, { idempotencyKey: 'appr-1' })
      expect(calls.approval).toBe(1)

      const closeWait = new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!webrtcClient.isOpen()) {
            clearInterval(check)
            resolve()
          }
        }, 20)
      })
      await trustStore.revoke(webrtcClient.deviceId, 'lost-device')
      await closeWait
      expect(webrtcClient.isOpen()).toBe(false)

      // Post-revocation WebRTC reconnect fails closed
      await expect(
        webrtcClient.reconnectWithBackoff({ initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 2 }),
      ).rejects.toThrow()
      webrtcClient.close()
    } finally {
      await runtime.stop()
      await sig.stop()
      await stun.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('separates ICE dial timeout from post-DataChannel Noise handshakeTimeoutMs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-r3-phase-timer-'))
    const hostStore = new FileHostIdentityStore(join(dir, 'host.json'))
    const trustStore = new InMemoryDeviceTrustStore()
    const sig = new SelfHostedSignalingServer({ enabled: true, host: '127.0.0.1', port: 0 })
    await sig.start()

    const runtime = new RemoteHostRuntime({
      seams: {
        async listSessions() {
          return [{ id: 's-timer', title: 'Phase Timer Probe' }]
        },
        async assertSession() {},
        async followup() {
          return {}
        },
        async respondApproval() {
          return {}
        },
        async respondQuestion() {
          return {}
        },
      },
      trustStore,
      hostIdentityStore: hostStore,
      carrier: { enabled: false },
      webrtc: {
        enabled: true,
        signalingUrl: sig.getEndpointUrl()!,
        ice: { iceInterfaceAddresses: { udp4: '127.0.0.1' } },
      },
    })
    await runtime.start()

    try {
      const host = await hostStore.loadOrCreate()
      const keys = clientKeyPair()
      trustStore.trustSync({
        staticPublicKey: keys.publicKey,
        displayName: 'Timer Probe',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client = new WebRtcClientCarrier({
        clientKeyPair: keys,
        hostPublicKey: host.identity.publicKey,
        signalingUrl: sig.getEndpointUrl()!,
        iceConnectTimeoutMs: 5_000,
        handshakeTimeoutMs: 400,
        ice: { iceInterfaceAddresses: { udp4: '127.0.0.1' } },
      })
      await client.connect()
      expect(await client.request('session.list')).toEqual([{ id: 's-timer', title: 'Phase Timer Probe' }])
      client.close()

      // Verify dial phase delay (> handshakeTimeoutMs) does not trip pre-Noise timeout,
      // while post-open Noise stall still fails closed at handshakeTimeoutMs
      let transportClosed = false
      const session = new RemoteClientSession({
        clientKeyPair: keys,
        hostPublicKey: host.identity.publicKey,
        handshakeTimeoutMs: 60,
      })
      const startedAt = Date.now()
      await expect(
        session.connectWithTransport(() => ({
          kind: 'webrtc',
          isOpen: () => !transportClosed,
          connect: async () => {
            await new Promise((r) => setTimeout(r, 90))
          },
          send: () => {
            // Silently drop Noise msg1 after DataChannel opens
          },
          close: () => {
            transportClosed = true
          },
        })),
      ).rejects.toThrow('client connection timeout')
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(130)
      expect(transportClosed).toBe(true)
    } finally {
      await runtime.stop()
      await sig.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
