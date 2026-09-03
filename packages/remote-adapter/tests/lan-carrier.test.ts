import { describe, expect, it } from 'vitest'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
// @ts-ignore - noise-handshake/dh.js
import dh from 'noise-handshake/dh.js'
import {
  HostLanCarrier,
  LanClientCarrier,
  RemoteAdapterCore,
  InMemoryHostIdentityStore,
  InMemoryDeviceTrustStore,
  FileDeviceTrustStore,
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
  type OfficialRemoteSeams,
  type RemoteRequest,
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

function fakeSeams() {
  const calls = {
    followup: 0,
    approval: 0,
    question: 0,
  }
  const seams: OfficialRemoteSeams = {
    async listSessions() {
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
  }
  return { seams, calls }
}

async function performRawWsHandshake(port: number, host = '127.0.0.1'): Promise<import('node:net').Socket> {
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

describe('R2B LAN Carrier Adversarial Security Suite', () => {
  it('1. LAN carrier disabled by default', async () => {
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

  it('2. explicit interface bind', async () => {
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

  it('3. wildcard/public default rejected', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    const carrier0 = new HostLanCarrier({
      enabled: true,
      host: '0.0.0.0',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await expect(carrier0.start()).rejects.toThrow('forbidden')

    const carrierColon = new HostLanCarrier({
      enabled: true,
      host: '::',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
    })
    await expect(carrierColon.start()).rejects.toThrow('forbidden')
  })

  it('4. binary encrypted RPC success', async () => {
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

  it('5. plaintext JSON rejected', async () => {
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

      // Send unencrypted plaintext JSON in binary WebSocket frame
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

  it('6. text WebSocket frame rejected', async () => {
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

      // Send text frame (opcode 0x1)
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

  it('7. oversized frame rejected before expensive processing', async () => {
    const hostStore = new InMemoryHostIdentityStore()
    const trustStore = new InMemoryDeviceTrustStore()
    const core = new RemoteAdapterCore(fakeSeams().seams, { trustStore, hostIdentityStore: hostStore })

    // Set a tight maxFrameBytes limit of 1,024 bytes
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
      header[4] = 1 // mask key bytes
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

  it('8. wrong Noise key rejected', async () => {
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

  it('9. tampered ciphertext closes channel', async () => {
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

  it('10. unpaired channel cannot dispatch ordinary RPC', async () => {
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
      // Do NOT trust client in trustStore

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

  it('11. paired authorized device can dispatch permitted RPC', async () => {
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

  it('12. capability denial preserved', async () => {
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
      // Grant ONLY observe capability
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

  it('13. revoked device active connection terminated', async () => {
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

  it('14. two active connections revoked together', async () => {
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

      // Revoke device
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

  it('15. reconnect gets fresh epoch', async () => {
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

  it('16. stable device identity survives reconnect', async () => {
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

  it('17. stale requestSeq/replay rejected', async () => {
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

      // Request 1 with requestSeq = 1
      const res1 = await client.request('session.list', {}, { requestSeq: 1 })
      expect(res1).toBeDefined()

      // Resend request with requestSeq = 1 (stale/replayed)
      await expect(
        client.request('session.list', {}, { requestSeq: 1, customId: 'stale-1' }),
      ).rejects.toThrow('REQUEST_REPLAY')

      client.close()
    } finally {
      await carrier.stop()
    }
  })

  it('18. R1 idempotency survives reconnect', async () => {
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

      // Connection 1: submit prompt with idempotencyKey
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

      // Connection 2 (Fresh connection, epoch 2): resend same idempotencyKey
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

      // Cached response returned without re-invoking mock seam
      expect(res2.turnId).toBe('t1')
      expect(calls.followup).toBe(1)

      client2.close()
    } finally {
      await carrier.stop()
    }
  })

  it('19. slow-client outbound queue bounded', async () => {
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
        maxOutboundQueue: 4,
        maxBufferedEventBytes: 1024,
      },
    })
    await carrier.start()
    const port = carrier.getBoundAddress()!.port

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

      // Client is active; now pause receiving on the client
      const ws = (client as any).ws as WebSocket
      const rawSocket = (ws as any)._socket ?? (ws as any).socket
      if (rawSocket && typeof rawSocket.pause === 'function') {
        rawSocket.pause()
      }

      // Broadcast many events to trigger outbound high-water mark
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

  it('20. concurrent connection cap enforced', async () => {
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

      // 3rd connection attempt must be rejected with 503
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

  it('21. handshake timeout', async () => {
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

  it('22. idle timeout', async () => {
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

  it('23. mDNS contains no secret', () => {
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

  it('24. QR descriptor contains no Session/prompt/credential', () => {
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

  it('25. no plaintext application payload observable at carrier boundary', async () => {
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
        displayName: 'Sniff Test Device',
        grantedCapabilities: ['observe'],
        trustDomainId: host.identity.trustDomainId,
      })

      const client = new LanClientCarrier({
        clientKeyPair: clientKeys,
        hostPublicKey: host.identity.publicKey,
        endpointUrl: carrier.getEndpointUrl()!,
      })

      const wireChunks: Buffer[] = []
      const ws = (client as any).ws as WebSocket | undefined

      await client.connect()

      // Sniff data on carrier connection socket
      const activeConn = (carrier as any).activeConnections.values().next().value
      const rawSocket = activeConn?.socket as import('node:net').Socket
      rawSocket.on('data', (chunk) => {
        wireChunks.push(Buffer.from(chunk))
      })

      // Send application request
      await client.request('session.list')

      await new Promise((r) => setTimeout(r, 50))

      const totalWireBytes = Buffer.concat(wireChunks)
      const wireString = totalWireBytes.toString('binary')

      // Assert that application plaintext NEVER appears in wire traffic
      expect(wireString).not.toContain('session.list')
      expect(wireString).not.toContain('Session 1')
      expect(wireString).not.toContain('jsonrpc')

      client.close()
    } finally {
      await carrier.stop()
    }
  })
})
