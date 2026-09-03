import { describe, expect, it } from 'vitest'
import { createConnection, createServer as createNetServer, type Socket } from 'node:net'
// @ts-ignore - noise-handshake/dh.js
import dh from 'noise-handshake/dh.js'
import {
  HostLanCarrier,
  LanClientCarrier,
  RemoteAdapterCore,
  InMemoryHostIdentityStore,
  InMemoryDeviceTrustStore,
  PairingCoordinator,
  PairingTokenRegistry,
  RemoteCryptoError,
  RemoteProtocolError,
  createDiscoveryHint,
  assertNoSecretsInDiscoveryHint,
  createPairingBootstrapDescriptor,
  parsePairingBootstrapDescriptor,
  assertNoSessionOrCredentialsInDescriptor,
  encodeWebSocketFrame,
  WebSocketOpcode,
  validateLanCarrierBounds,
  validateLanBindingAddress,
  InMemoryMdnsAdvertiser,
  type OfficialRemoteSeams,
  REMOTE_PROTOCOL_VERSION,
} from '../src/index.js'

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

function fakeSeams(overrides?: Partial<OfficialRemoteSeams>) {
  const calls = {
    list: 0,
    followup: 0,
    approval: 0,
    question: 0,
  }
  const seams: OfficialRemoteSeams = {
    async listSessions() {
      calls.list += 1
      return [{ id: 's1', title: 'Session 1' }]
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
    ...(overrides ?? {}),
  }
  return { seams, calls }
}

async function performRawWsHandshake(port: number, host = '127.0.0.1'): Promise<Socket> {
  const socket = createConnection({ port, host })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })

  const req = [
    'GET / HTTP/1.1',
    `Host: ${host}:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    '\r\n',
  ].join('\r\n')

  socket.write(req)

  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('101 Switching Protocols')) {
        socket.removeListener('data', onData)
        resolve()
      }
    }
    socket.on('data', onData)
    socket.once('error', reject)
  })

  return socket
}

describe('R2B LAN Carrier Adversarial Security & Regression Suite', () => {
  // P0-1: LAN Binding Policy Tests
  it('1. public/global bind rejected', () => {
    expect(() => validateLanBindingAddress('8.8.8.8', { skipInterfaceCheckForTesting: true })).toThrow('public')
    expect(() => validateLanBindingAddress('1.1.1.1', { skipInterfaceCheckForTesting: true })).toThrow('public')
    expect(() => validateLanBindingAddress('93.184.216.34', { skipInterfaceCheckForTesting: true })).toThrow('public')
    expect(() => validateLanBindingAddress('2408:823c::1', { skipInterfaceCheckForTesting: true })).toThrow('public')
    expect(() => validateLanBindingAddress('2001:4860:4860::8888', { skipInterfaceCheckForTesting: true })).toThrow('public')
  })

  it('2. non-IP host rejected', () => {
    expect(() => validateLanBindingAddress('localhost')).toThrow('not a valid IP address')
    expect(() => validateLanBindingAddress('example.com')).toThrow('not a valid IP address')
    expect(() => validateLanBindingAddress('')).toThrow('must be explicitly provided')
  })

  it('3. wildcard/public default rejected', () => {
    expect(() => validateLanBindingAddress('0.0.0.0')).toThrow('forbidden')
    expect(() => validateLanBindingAddress('::')).toThrow('forbidden')
    expect(() => validateLanBindingAddress('*')).toThrow('forbidden')
    expect(() => validateLanBindingAddress('all')).toThrow('forbidden')
  })

  it('4. loopback and private interfaces permitted', () => {
    expect(validateLanBindingAddress('127.0.0.1')).toBe('127.0.0.1')
    expect(validateLanBindingAddress('::1')).toBe('::1')
    expect(validateLanBindingAddress('192.168.1.100', { skipInterfaceCheckForTesting: true })).toBe('192.168.1.100')
    expect(validateLanBindingAddress('10.0.1.5', { skipInterfaceCheckForTesting: true })).toBe('10.0.1.5')
    expect(validateLanBindingAddress('172.16.0.2', { skipInterfaceCheckForTesting: true })).toBe('172.16.0.2')
  })

  // P0-5: Bounds Validation Tests
  it('5. invalid bounds rejected', () => {
    expect(() => validateLanCarrierBounds({ maxFrameBytes: 0 })).toThrow('positive finite integer')
    expect(() => validateLanCarrierBounds({ maxFrameBytes: -100 })).toThrow('positive finite integer')
    expect(() => validateLanCarrierBounds({ maxFrameBytes: Infinity })).toThrow('positive finite integer')
    expect(() => validateLanCarrierBounds({ maxFrameBytes: NaN })).toThrow('positive finite integer')
    expect(() => validateLanCarrierBounds({ maxFrameBytes: 100.5 })).toThrow('positive finite integer')
    expect(() => validateLanCarrierBounds({ maxHandshakeBytes: 70_000, maxFrameBytes: 65_536 })).toThrow('cannot exceed maxFrameBytes')
    expect(() => validateLanCarrierBounds({ maxFrameBytes: 300_000, maxBufferedEventBytes: 262_144 })).toThrow('cannot exceed maxBufferedEventBytes')
    // @ts-ignore
    expect(() => validateLanCarrierBounds({ unknownProp: 123 })).toThrow('unknown bounds property')
  })

  it('6. LAN carrier disabled by default', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })

    expect(carrier.isEnabled()).toBe(false)
    expect(carrier.isListening()).toBe(false)
    await expect(carrier.start()).rejects.toThrow(RemoteCryptoError)
  })

  it('7. explicit interface bind', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })

    await carrier.start()
    try {
      const bound = carrier.getBoundAddress()
      expect(bound).toBeDefined()
      expect(bound!.host).toBe('127.0.0.1')
      expect(bound!.port).toBeGreaterThan(0)
      expect(carrier.getEndpointUrl()).toBe(`ws://127.0.0.1:${bound!.port}`)
    } finally {
      await carrier.stop()
    }
  })

  it('8. binary encrypted RPC success', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()

    try {
      const clientKeys = generateClientKeyPair()
      trustStore.trustSync({
        staticPublicKey: clientKeys.publicKey,
        displayName: 'Client 1',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })

      await client.connect()
      expect(client.isOpen()).toBe(true)

      const result = await client.request('session.list')
      expect(result).toEqual([{ id: 's1', title: 'Session 1' }])

      client.close()
    } finally {
      await carrier.stop()
    }
  })

  it('9. plaintext JSON rejected', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()
    const port = carrier.getBoundAddress()!.port

    try {
      const socket = await performRawWsHandshake(port)

      const plaintextJson = Buffer.from('{"jsonrpc":"2.0","method":"session.list"}', 'utf8')
      const maskKey = new Uint8Array([1, 2, 3, 4])
      const frame = encodeWebSocketFrame(plaintextJson, WebSocketOpcode.BINARY, maskKey)
      socket.write(frame)

      const closed = await new Promise<boolean>((resolve) => {
        socket.on('close', () => resolve(true))
        socket.on('data', (chunk) => {
          if (chunk.length >= 2 && chunk[0] === 0x88) resolve(true)
        })
        setTimeout(() => resolve(false), 2000)
      })
      expect(closed).toBe(true)
      socket.destroy()
    } finally {
      await carrier.stop()
    }
  })

  it('10. text WebSocket frame rejected', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()
    const port = carrier.getBoundAddress()!.port

    try {
      const socket = await performRawWsHandshake(port)

      const textData = Buffer.from('hello text', 'utf8')
      const maskKey = new Uint8Array([5, 6, 7, 8])
      const frame = encodeWebSocketFrame(textData, WebSocketOpcode.TEXT, maskKey)
      socket.write(frame)

      const closed = await new Promise<boolean>((resolve) => {
        socket.on('close', () => resolve(true))
        socket.on('data', (chunk) => {
          if (chunk.length >= 2 && chunk[0] === 0x88) resolve(true)
        })
        setTimeout(() => resolve(false), 2000)
      })
      expect(closed).toBe(true)
      socket.destroy()
    } finally {
      await carrier.stop()
    }
  })

  it('11. oversized frame rejected before expensive processing', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
      bounds: {
        maxFrameBytes: 1_024,
      },
    })
    await carrier.start()
    const port = carrier.getBoundAddress()!.port

    try {
      const socket = await performRawWsHandshake(port)

      // Send 6-byte header declaring 5,000 bytes payload (> limit 1,024)
      const header = Buffer.alloc(6)
      header[0] = 0x82 // FIN=1, BINARY
      header[1] = 0x80 | 126 // MASK=1, 16-bit extended length
      header.writeUInt16BE(5_000, 2)
      header[4] = 1 // mask key
      header[5] = 2

      socket.write(header)

      const closed = await new Promise<boolean>((resolve) => {
        socket.on('close', () => resolve(true))
        socket.on('data', (chunk) => {
          if (chunk.length >= 2 && chunk[0] === 0x88) resolve(true)
        })
        setTimeout(() => resolve(false), 2000)
      })
      expect(closed).toBe(true)
      socket.destroy()
    } finally {
      await carrier.stop()
    }
  })

  // P0-3: Control frames validation
  it('12. control frame >125 rejected', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()
    const port = carrier.getBoundAddress()!.port

    try {
      const socket = await performRawWsHandshake(port)

      // PING frame with payload length = 126 (> 125, violation of RFC 6455 5.5)
      const header = Buffer.alloc(8)
      header[0] = 0x89 // FIN=1, PING
      header[1] = 0x80 | 126 // MASK=1, extended length 126
      header.writeUInt16BE(126, 2)
      header[4] = 1 // mask
      header[5] = 2
      header[6] = 3
      header[7] = 4

      socket.write(header)

      const closed = await new Promise<boolean>((resolve) => {
        socket.on('close', () => resolve(true))
        socket.on('data', (chunk) => {
          if (chunk.length >= 2 && chunk[0] === 0x88) resolve(true)
        })
        setTimeout(() => resolve(false), 2000)
      })
      expect(closed).toBe(true)
      socket.destroy()
    } finally {
      await carrier.stop()
    }
  })

  it('13. fragmented/RSV invalid frame rejected', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()
    const port = carrier.getBoundAddress()!.port

    try {
      // 1. RSV1 set
      const socket1 = await performRawWsHandshake(port)
      const rsvFrame = Buffer.alloc(6)
      rsvFrame[0] = 0xc2 // FIN=1, RSV1=1, BINARY
      rsvFrame[1] = 0x80 | 0 // MASK=1, len=0
      socket1.write(rsvFrame)

      const closed1 = await new Promise<boolean>((resolve) => {
        socket1.on('close', () => resolve(true))
        socket1.on('data', (c) => { if (c[0] === 0x88) resolve(true) })
        setTimeout(() => resolve(false), 2000)
      })
      expect(closed1).toBe(true)
      socket1.destroy()

      // 2. Fragmented control frame (FIN=0, PING)
      const socket2 = await performRawWsHandshake(port)
      const fragControl = Buffer.alloc(6)
      fragControl[0] = 0x09 // FIN=0, PING
      fragControl[1] = 0x80 | 0
      socket2.write(fragControl)

      const closed2 = await new Promise<boolean>((resolve) => {
        socket2.on('close', () => resolve(true))
        socket2.on('data', (c) => { if (c[0] === 0x88) resolve(true) })
        setTimeout(() => resolve(false), 2000)
      })
      expect(closed2).toBe(true)
      socket2.destroy()
    } finally {
      await carrier.stop()
    }
  })

  // P0-3: Bounded PING/PONG flood
  it('14. PING/PONG flood bounded', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
      bounds: {
        maxFrameBytes: 1024,
        maxHandshakeBytes: 512,
        maxOutboundQueue: 2,
        maxBufferedEventBytes: 1024,
      },
    })
    await carrier.start()
    const port = carrier.getBoundAddress()!.port

    try {
      const socket = await performRawWsHandshake(port)

      // Send burst of PING frames in a single chunk so they hit pendingOutboundFrames limit
      const pingPayload = Buffer.alloc(100, 0xaa)
      const maskKey = new Uint8Array([1, 2, 3, 4])
      const pingFrame = encodeWebSocketFrame(pingPayload, WebSocketOpcode.PING, maskKey)
      const burst = Buffer.concat(Array(10).fill(pingFrame))

      socket.write(burst)

      // High-water mark on PONG output triggers termination
      const closed = await new Promise<boolean>((resolve) => {
        socket.on('close', () => resolve(true))
        socket.on('data', (chunk) => {
          if (chunk.length >= 2 && chunk[0] === 0x88) resolve(true)
        })
        setTimeout(() => resolve(false), 2000)
      })
      expect(closed).toBe(true)
      socket.destroy()
    } finally {
      await carrier.stop()
    }
  })

  // P0-2: Unified Inbound Work Budget for PAIRING_PENDING
  it('15. PAIRING_PENDING flood bounded', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const tokenRegistry = new PairingTokenRegistry()
    const coordinator = new PairingCoordinator(trustStore, tokenRegistry)
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
      pairingCoordinator: coordinator,
      bounds: {
        maxInboundQueue: 2, // Strict inbound limit
      },
    })
    await carrier.start()

    try {
      const clientKeys = generateClientKeyPair()
      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client.connect()

      // Burst requests without awaiting to exceed maxInboundQueue
      const p1 = client.request('pairing.request', { token: 't1' })
      const p2 = client.request('pairing.request', { token: 't2' })
      const p3 = client.request('pairing.request', { token: 't3' })
      const p4 = client.request('pairing.request', { token: 't4' })

      const results = await Promise.allSettled([p1, p2, p3, p4])
      const rejected = results.some((r) => r.status === 'rejected')
      expect(rejected).toBe(true)

      client.close()
    } finally {
      await carrier.stop()
    }
  })

  // P0-4: Outbound Frame Bounds
  it('16. oversized outbound event rejected', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
      bounds: {
        maxFrameBytes: 1_024,
      },
    })
    await carrier.start()

    try {
      const clientKeys = generateClientKeyPair()
      trustStore.trustSync({
        staticPublicKey: clientKeys.publicKey,
        displayName: 'Client',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client.connect()

      // Broadcast an event larger than maxFrameBytes (1,024)
      const largeEvent = { type: 'huge', data: 'x'.repeat(2000) }
      carrier.broadcastEvent(largeEvent)

      // Connection must be terminated fail-closed
      const closed = await new Promise<boolean>((resolve) => {
        const ws = (client as any).ws as WebSocket
        ws.onclose = () => resolve(true)
        setTimeout(() => resolve(false), 2000)
      })
      expect(closed).toBe(true)
      client.close()
    } finally {
      await carrier.stop()
    }
  })

  it('17. oversized outbound RPC result rejected', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    // Seam returning a huge response
    const { seams } = fakeSeams({
      async listSessions() {
        return [{ id: 's1', title: 'A'.repeat(5000) }]
      },
    })
    const core = new RemoteAdapterCore(seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
      bounds: {
        maxFrameBytes: 1_024,
      },
    })
    await carrier.start()

    try {
      const clientKeys = generateClientKeyPair()
      trustStore.trustSync({
        staticPublicKey: clientKeys.publicKey,
        displayName: 'Client',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client.connect()

      // Request that produces oversized outbound result
      await expect(client.request('session.list')).rejects.toThrow()

      client.close()
    } finally {
      await carrier.stop()
    }
  })

  // P0-6: Poisoned Trust Store Exception Containment
  it('18. poisoned trust store cannot crash process', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const { seams, calls } = fakeSeams()

    // Poisoned trust store that throws on getSync
    const poisonedTrustStore = new InMemoryDeviceTrustStore()
    poisonedTrustStore.getSync = () => {
      throw new Error('CORRUPTED_DATABASE_SECTOR: disk failure simulation')
    }

    const core = new RemoteAdapterCore(seams, { trustStore: poisonedTrustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore: poisonedTrustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()

    let uncaught = 0
    const onUncaught = () => { uncaught += 1 }
    process.on('uncaughtException', onUncaught)

    try {
      const clientKeys = generateClientKeyPair()
      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })

      // Client connecting will trigger getSync during authorization evaluation
      await expect(client.connect()).rejects.toThrow()

      // Official seam must not be touched
      expect(calls.list).toBe(0)
      // Process level uncaught exception must be ZERO
      expect(uncaught).toBe(0)

      client.close()
    } finally {
      process.removeListener('uncaughtException', onUncaught)
      await carrier.stop()
    }
  })

  // P1-3: Upgrade head preserved
  it('19. upgrade head preserved', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()
    const port = carrier.getBoundAddress()!.port

    try {
      const clientKeys = generateClientKeyPair()
      const clientNoise = new (await import('../src/index.js')).NoiseInitiatorSession(
        clientKeys,
        host.identity.publicKey,
      )
      const m1 = clientNoise.writeMessage1()
      const m1Frame = encodeWebSocketFrame(m1, WebSocketOpcode.BINARY, new Uint8Array([1, 2, 3, 4]))

      const socket = createConnection({ port, host: '127.0.0.1' })
      await new Promise<void>((r) => socket.once('connect', r))

      const upgradeReq = Buffer.from(
        [
          'GET / HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          '\r\n',
        ].join('\r\n'),
        'utf8',
      )

      // Send Upgrade request AND first Noise binary frame together in a single TCP write!
      const pipelined = Buffer.concat([upgradeReq, m1Frame])
      socket.write(pipelined)

      // Host must handle upgrade, read head, and return 101 Switching Protocols + Noise Message 2
      const receivedChunks: Buffer[] = []
      await new Promise<void>((resolve) => {
        socket.on('data', (chunk) => {
          receivedChunks.push(chunk)
          const all = Buffer.concat(receivedChunks).toString('utf8')
          if (all.includes('101 Switching Protocols')) {
            resolve()
          }
        })
      })

      expect(receivedChunks.length).toBeGreaterThan(0)
      socket.destroy()
    } finally {
      await carrier.stop()
    }
  })

  // P1-4: Transactional startup rollback
  it('20. startup listen failure cleans subscription', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    // Occupy a port with a raw server
    const blocker = createNetServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
    const occupiedPort = (blocker.address() as any).port

    let revocationCallbackCount = 0
    trustStore.subscribeRevocations(() => {
      revocationCallbackCount += 1
    })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: occupiedPort,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })

    // Start must fail due to occupied port
    await expect(carrier.start()).rejects.toThrow()
    expect(carrier.isListening()).toBe(false)

    blocker.close()

    // Retry on available port 0
    const carrierRetry = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrierRetry.start()
    expect(carrierRetry.isListening()).toBe(true)

    await carrierRetry.stop()
  })

  // P1-1: Actual mDNS Advertiser Lifecycle
  it('21. actual mDNS advertiser lifecycle', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const advertiser = new InMemoryMdnsAdvertiser()
    expect(advertiser.isPublished()).toBe(false)

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
      mdnsAdvertiser: advertiser,
      hostDisplayLabel: 'Test DSH Host',
    })

    await carrier.start()
    expect(advertiser.isPublished()).toBe(true)
    const record = advertiser.getPublishedRecord()!
    expect(record.name).toBe('Test DSH Host')
    expect(record.type).toBe('_dsh-remote._tcp')
    expect(record.port).toBe(carrier.getBoundAddress()!.port)
    expect(record.txt.v).toBe('1')
    expect(record.txt.fp).toBeDefined()

    // Verify no secrets in mDNS
    assertNoSecretsInDiscoveryHint(record as any)

    await carrier.stop()
    expect(advertiser.isPublished()).toBe(false)
  })

  // Pairing Transport Integration: 3 tests
  it('22. valid transport pairing over authenticated Noise channel', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const tokenRegistry = new PairingTokenRegistry()
    const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry)
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
      pairingCoordinator: coordinator,
    })
    await carrier.start()

    try {
      const pairingToken = tokenRegistry.createToken({
        trustDomainId: host.identity.trustDomainId,
        hostGeneration: host.identity.generation,
        allowedCapabilities: ['observe'],
        ttlMs: 60_000,
      })
      const token = pairingToken.token

      const clientKeys = generateClientKeyPair()
      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client.connect()

      // Submit pairing request over encrypted channel
      const res = await client.request('pairing.request', { token, displayName: 'Enrolled Phone' })
      expect(res.candidateId).toBeDefined()

      // Host confirms pairing
      await coordinator.confirmPairing({ candidateId: res.candidateId, grantedCapabilities: ['observe'] })

      // Verify device is enrolled in trust store
      const enrolled = trustStore.getSync(client.deviceId)
      expect(enrolled).toBeDefined()
      expect(enrolled?.displayName).toBe('Enrolled Phone')

      client.close()
    } finally {
      await carrier.stop()
    }
  })

  it('23. pairing token replay denied', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const tokenRegistry = new PairingTokenRegistry()
    const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry)
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
      pairingCoordinator: coordinator,
    })
    await carrier.start()

    try {
      const pairingToken = tokenRegistry.createToken({
        trustDomainId: host.identity.trustDomainId,
        hostGeneration: host.identity.generation,
        allowedCapabilities: ['observe'],
        ttlMs: 60_000,
      })
      const token = pairingToken.token

      const clientKeys1 = generateClientKeyPair()
      const client1 = new LanClientCarrier({
        clientKeyPair: clientKeys1,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client1.connect()
      const res = await client1.request('pairing.request', { token, displayName: 'Device 1' })
      expect(res.candidateId).toBeDefined()
      client1.close()

      // Second client attempts to reuse token
      const clientKeys2 = generateClientKeyPair()
      const client2 = new LanClientCarrier({
        clientKeyPair: clientKeys2,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client2.connect()
      await expect(
        client2.request('pairing.request', { token, displayName: 'Device 2' }),
      ).rejects.toThrow('PAIRING_FAILED')
      client2.close()
    } finally {
      await carrier.stop()
    }
  })

  it('24. expired pairing token denied', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    let now = Date.now()
    const tokenRegistry = new PairingTokenRegistry(16, 60_000, 300_000, { clock: () => now })
    const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry)
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
      pairingCoordinator: coordinator,
    })
    await carrier.start()

    try {
      const pairingToken = tokenRegistry.createToken({
        trustDomainId: host.identity.trustDomainId,
        hostGeneration: host.identity.generation,
        allowedCapabilities: ['observe'],
        ttlMs: 1_000,
      })
      const token = pairingToken.token

      // Advance clock past expiration
      now += 2_000

      const clientKeys = generateClientKeyPair()
      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client.connect()

      await expect(
        client.request('pairing.request', { token, displayName: 'Expired Device' }),
      ).rejects.toThrow('PAIRING_FAILED')

      client.close()
    } finally {
      await carrier.stop()
    }
  })

  // Plaintext Wire Proof: Inbound & Outbound
  it('25. inbound wire plaintext absent', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()

    try {
      const clientKeys = generateClientKeyPair()
      trustStore.trustSync({
        staticPublicKey: clientKeys.publicKey,
        displayName: 'Inbound Sniff Device',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })

      const inboundWireChunks: Buffer[] = []
      await client.connect()

      // Hook raw socket on host side to observe inbound bytes
      const activeConn = (carrier as any).activeConnections.values().next().value
      const rawSocket = activeConn?.socket as Socket
      rawSocket.on('data', (chunk) => {
        inboundWireChunks.push(Buffer.from(chunk))
      })

      await client.request('session.list')
      await new Promise((r) => setTimeout(r, 50))

      const totalInbound = Buffer.concat(inboundWireChunks).toString('binary')
      expect(totalInbound).not.toContain('session.list')
      expect(totalInbound).not.toContain('jsonrpc')
      expect(totalInbound).not.toContain('req-1')

      client.close()
    } finally {
      await carrier.stop()
    }
  })

  it('26. outbound wire plaintext absent', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()
    const port = carrier.getBoundAddress()!.port

    try {
      const clientKeys = generateClientKeyPair()
      trustStore.trustSync({
        staticPublicKey: clientKeys.publicKey,
        displayName: 'Outbound Sniff Device',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client.connect()

      const outboundChunks: Buffer[] = []
      const activeConn = (carrier as any).activeConnections.values().next().value
      const rawSocket = activeConn?.socket as Socket
      const origWrite = rawSocket.write.bind(rawSocket)
      rawSocket.write = (chunk: any, ...args: any[]): any => {
        if (Buffer.isBuffer(chunk)) {
          outboundChunks.push(Buffer.from(chunk))
        } else if (typeof chunk === 'string') {
          outboundChunks.push(Buffer.from(chunk, 'utf8'))
        }
        return origWrite(chunk, ...args)
      }

      const res = await client.request('session.list')
      expect(res).toEqual([{ id: 's1', title: 'Session 1' }])

      await new Promise((r) => setTimeout(r, 50))

      const totalOutbound = Buffer.concat(outboundChunks).toString('binary')
      expect(totalOutbound).not.toContain('Session 1')
      expect(totalOutbound).not.toContain('s1')
      expect(totalOutbound).not.toContain('jsonrpc')

      client.close()
    } finally {
      await carrier.stop()
    }
  })

  it('27. wrong Noise key rejected', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
      bounds: {
        handshakeTimeoutMs: 150,
      },
    })
    await carrier.start()

    try {
      const clientKeys = generateClientKeyPair()
      const wrongHostKeys = generateClientKeyPair()

      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: wrongHostKeys.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })

      await expect(client.connect()).rejects.toThrow()
      client.close()
    } finally {
      await carrier.stop()
    }
  })

  it('28. tampered ciphertext closes channel', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()

    try {
      const clientKeys = generateClientKeyPair()
      trustStore.trustSync({
        staticPublicKey: clientKeys.publicKey,
        displayName: 'Client 1',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client.connect()

      const noise = client.getNoiseSession()!
      const validCipher = noise.encrypt(new TextEncoder().encode('{"jsonrpc":"2.0","method":"session.list","id":"t1","protocolVersion":1,"connectionEpoch":1,"requestSeq":1,"params":{}}'))
      validCipher[2] = (validCipher[2] ?? 0) ^ 0xff

      const ws = (client as any).ws as WebSocket
      ws.send(validCipher)

      const closed = await new Promise<boolean>((resolve) => {
        ws.onclose = () => resolve(true)
        setTimeout(() => resolve(false), 2000)
      })
      expect(closed).toBe(true)
      client.close()
    } finally {
      await carrier.stop()
    }
  })

  it('29. unpaired channel cannot dispatch ordinary RPC', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()

    try {
      const clientKeys = generateClientKeyPair()
      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client.connect()

      await expect(client.request('session.list')).rejects.toThrow('UNAUTHORIZED_CHANNEL')
      client.close()
    } finally {
      await carrier.stop()
    }
  })

  it('30. paired authorized device can dispatch permitted RPC', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()

    try {
      const clientKeys = generateClientKeyPair()
      trustStore.trustSync({
        staticPublicKey: clientKeys.publicKey,
        displayName: 'Authorized Device',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client.connect()

      const list = await client.request('session.list')
      expect(list).toEqual([{ id: 's1', title: 'Session 1' }])

      client.close()
    } finally {
      await carrier.stop()
    }
  })

  it('31. capability denial preserved', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()

    try {
      const clientKeys = generateClientKeyPair()
      trustStore.trustSync({
        staticPublicKey: clientKeys.publicKey,
        displayName: 'Observe Only Device',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client.connect()

      await expect(
        client.request('prompt.submit', { sessionId: 's1', prompt: 'hello' }),
      ).rejects.toThrow('CAPABILITY_DENIED')

      client.close()
    } finally {
      await carrier.stop()
    }
  })

  it('32. revoked device active connection terminated', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()

    try {
      const clientKeys = generateClientKeyPair()
      const record = trustStore.trustSync({
        staticPublicKey: clientKeys.publicKey,
        displayName: 'Device To Revoke',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client.connect()

      const list1 = await client.request('session.list')
      expect(list1).toBeDefined()

      // Revoke device
      trustStore.revokeSync(record.deviceId)

      const closed = await new Promise<boolean>((resolve) => {
        const ws = (client as any).ws as WebSocket
        if (!ws || ws.readyState === WebSocket.CLOSED) return resolve(true)
        ws.onclose = () => resolve(true)
        setTimeout(() => resolve(false), 2000)
      })
      expect(closed).toBe(true)

      client.close()
    } finally {
      await carrier.stop()
    }
  })

  it('33. two active connections revoked together', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()

    try {
      const clientKeys = generateClientKeyPair()
      const record = trustStore.trustSync({
        staticPublicKey: clientKeys.publicKey,
        displayName: 'Dual Conn Device',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client1 = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      const client2 = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })

      await client1.connect()
      await client2.connect()

      trustStore.revokeSync(record.deviceId)

      const closed1 = await new Promise<boolean>((resolve) => {
        const ws1 = (client1 as any).ws as WebSocket
        if (!ws1 || ws1.readyState === WebSocket.CLOSED) return resolve(true)
        ws1.onclose = () => resolve(true)
        setTimeout(() => resolve(false), 2000)
      })
      const closed2 = await new Promise<boolean>((resolve) => {
        const ws2 = (client2 as any).ws as WebSocket
        if (!ws2 || ws2.readyState === WebSocket.CLOSED) return resolve(true)
        ws2.onclose = () => resolve(true)
        setTimeout(() => resolve(false), 2000)
      })

      expect(closed1).toBe(true)
      expect(closed2).toBe(true)

      client1.close()
      client2.close()
    } finally {
      await carrier.stop()
    }
  })

  it('34. reconnect gets fresh epoch', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()

    try {
      const clientKeys = generateClientKeyPair()
      trustStore.trustSync({
        staticPublicKey: clientKeys.publicKey,
        displayName: 'Reconnect Device',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client1 = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client1.connect()
      expect(client1.getConnectionEpoch()).toBe(1)
      await client1.request('session.list')
      client1.close()

      const client2 = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client2.connect()
      expect(client2.getConnectionEpoch()).toBe(2)
      await client2.request('session.list')
      client2.close()
    } finally {
      await carrier.stop()
    }
  })

  it('35. stable device identity survives reconnect', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()

    try {
      const clientKeys = generateClientKeyPair()
      trustStore.trustSync({
        staticPublicKey: clientKeys.publicKey,
        displayName: 'Stable Device',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client1 = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client1.connect()
      const devId1 = client1.deviceId
      client1.close()

      const client2 = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client2.connect()
      const devId2 = client2.deviceId
      client2.close()

      expect(devId1).toBe(devId2)
    } finally {
      await carrier.stop()
    }
  })

  it('36. stale requestSeq/replay rejected', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()

    try {
      const clientKeys = generateClientKeyPair()
      trustStore.trustSync({
        staticPublicKey: clientKeys.publicKey,
        displayName: 'Replay Test Device',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client.connect()

      const res1 = await client.request('session.list', {}, { requestSeq: 1 })
      expect(res1).toBeDefined()

      await expect(
        client.request('session.list', {}, { requestSeq: 1, customId: 'stale-1' }),
      ).rejects.toThrow('REQUEST_REPLAY')

      client.close()
    } finally {
      await carrier.stop()
    }
  })

  it('37. R1 idempotency survives reconnect', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const { seams, calls } = fakeSeams()
    const core = new RemoteAdapterCore(seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await carrier.start()

    try {
      const clientKeys = generateClientKeyPair()
      trustStore.trustSync({
        staticPublicKey: clientKeys.publicKey,
        displayName: 'Idempotency Device',
        grantedCapabilities: ['observe', 'prompt'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client1 = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client1.connect()

      const res1 = await client1.request(
        'prompt.submit',
        { sessionId: 's1', prompt: 'test prompt' },
        { idempotencyKey: 'idem-12345' },
      )
      expect(res1.turnId).toBe('t1')
      expect(calls.followup).toBe(1)
      client1.close()

      const client2 = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client2.connect()

      const res2 = await client2.request(
        'prompt.submit',
        { sessionId: 's1', prompt: 'test prompt' },
        { idempotencyKey: 'idem-12345' },
      )

      expect(res2.turnId).toBe('t1')
      expect(calls.followup).toBe(1)

      client2.close()
    } finally {
      await carrier.stop()
    }
  })

  it('38. slow-client outbound queue bounded', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
      bounds: {
        maxFrameBytes: 512,
        maxHandshakeBytes: 256,
        maxOutboundQueue: 4,
        maxBufferedEventBytes: 1024,
      },
    })
    await carrier.start()

    try {
      const clientKeys = generateClientKeyPair()
      trustStore.trustSync({
        staticPublicKey: clientKeys.publicKey,
        displayName: 'Slow Device',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client.connect()

      const ws = (client as any).ws as WebSocket
      const rawSocket = (ws as any)._socket ?? (ws as any).socket
      if (rawSocket && typeof rawSocket.pause === 'function') {
        rawSocket.pause()
      }

      for (let i = 0; i < 50; i++) {
        carrier.broadcastEvent({ type: 'stream.event', seq: i, payload: 'x'.repeat(512) })
      }

      const closed = await new Promise<boolean>((resolve) => {
        ws.onclose = () => resolve(true)
        setTimeout(() => resolve(false), 2000)
      })
      expect(closed).toBe(true)
      client.close()
    } finally {
      await carrier.stop()
    }
  })

  it('39. concurrent connection cap enforced', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
      bounds: {
        maxConcurrentConnections: 2,
      },
    })
    await carrier.start()
    const port = carrier.getBoundAddress()!.port

    try {
      const sock1 = await performRawWsHandshake(port)
      const sock2 = await performRawWsHandshake(port)

      const sock3 = createConnection({ port, host: '127.0.0.1' })
      await new Promise<void>((r) => sock3.once('connect', r))

      const req3 = [
        'GET / HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n')
      sock3.write(req3)

      const rejected = await new Promise<boolean>((resolve) => {
        sock3.on('data', (chunk) => {
          if (chunk.toString('utf8').includes('503 Service Unavailable')) {
            resolve(true)
          }
        })
        sock3.on('close', () => resolve(true))
        setTimeout(() => resolve(false), 2000)
      })

      expect(rejected).toBe(true)
      sock1.destroy()
      sock2.destroy()
      sock3.destroy()
    } finally {
      await carrier.stop()
    }
  })

  it('40. handshake timeout', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
      bounds: {
        handshakeTimeoutMs: 150,
      },
    })
    await carrier.start()
    const port = carrier.getBoundAddress()!.port

    try {
      const socket = await performRawWsHandshake(port)

      const closed = await new Promise<boolean>((resolve) => {
        socket.on('close', () => resolve(true))
        socket.on('data', (chunk) => {
          if (chunk.length >= 2 && chunk[0] === 0x88) resolve(true)
        })
        setTimeout(() => resolve(false), 2000)
      })

      expect(closed).toBe(true)
      socket.destroy()
    } finally {
      await carrier.stop()
    }
  })

  it('41. idle timeout', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
      bounds: {
        idleTimeoutMs: 200,
      },
    })
    await carrier.start()

    try {
      const clientKeys = generateClientKeyPair()
      trustStore.trustSync({
        staticPublicKey: clientKeys.publicKey,
        displayName: 'Idle Device',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })
      await client.connect()

      const closed = await new Promise<boolean>((resolve) => {
        const ws = (client as any).ws as WebSocket
        ws.onclose = () => resolve(true)
        setTimeout(() => resolve(false), 2000)
      })

      expect(closed).toBe(true)
      client.close()
    } finally {
      await carrier.stop()
    }
  })

  it('42. mDNS contains no secret', () => {
    const hint = createDiscoveryHint({
      hostDisplayLabel: "Alice's Workstation",
      protocolVersion: 1,
      endpointUrl: 'ws://192.168.1.50:8443',
      hostFingerprint: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    })

    expect(hint.serviceType).toBe('_dsh-remote._tcp')
    expect(hint.hostDisplayLabel).toBe("Alice's Workstation")
    expect(hint.protocolVersion).toBe(1)
    expect(hint.endpointUrl).toBe('ws://192.168.1.50:8443')

    expect(() => {
      assertNoSecretsInDiscoveryHint({
        ...hint,
        token: 'secret-token-value',
      })
    }).toThrow('sensitive secret field')

    expect(() => {
      assertNoSecretsInDiscoveryHint({
        ...hint,
        sessionId: 's-12345',
      })
    }).toThrow('sensitive secret field')

    expect(() => {
      assertNoSecretsInDiscoveryHint({
        ...hint,
        secretKey: 'raw-secret',
      })
    }).toThrow('sensitive secret field')
  })

  it('43. QR descriptor contains no Session/prompt/credential', () => {
    const hostKeys = generateClientKeyPair()
    const descriptor = createPairingBootstrapDescriptor({
      protocolVersion: 1,
      hostPublicKey: hostKeys.publicKey,
      bootstrapToken: 'pair-tok-998877',
      endpointUrl: 'ws://192.168.1.50:8443',
      expiresAt: Date.now() + 180_000,
    })

    expect(descriptor.protocolVersion).toBe(1)
    expect(descriptor.bootstrapToken).toBe('pair-tok-998877')
    expect(descriptor.endpointUrl).toBe('ws://192.168.1.50:8443')

    const parsed = parsePairingBootstrapDescriptor(JSON.stringify(descriptor))
    expect(parsed).toEqual(descriptor)

    expect(() => {
      assertNoSessionOrCredentialsInDescriptor({
        ...descriptor,
        sessionId: 'session-secret',
      })
    }).toThrow('session or credential field')

    expect(() => {
      assertNoSessionOrCredentialsInDescriptor({
        ...descriptor,
        prompt: 'user private prompt',
      })
    }).toThrow('session or credential field')

    expect(() => {
      assertNoSessionOrCredentialsInDescriptor({
        ...descriptor,
        credential: 'password123',
      })
    }).toThrow('session or credential field')
  })
})
