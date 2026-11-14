import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-ignore - noise-handshake/dh.js
import dh from 'noise-handshake/dh.js'
import {
  BlindGatewayServer,
  BlindRelayServer,
  encodePairingWebUrl,
  FailoverRemoteClient,
  InMemoryDeviceTrustStore,
  InMemoryHostIdentityStore,
  normalizeIpForRateLimit,
  PairingCoordinator,
  PairingTokenRegistry,
  parsePairingInput,
  RemoteHostRuntime,
  SelfHostedSignalingServer,
  type OfficialRemoteSeams,
} from '../src/index.js'
import { createPairingBootstrapDescriptor } from '../src/carrier/pairing-qr.js'
import { SignalingClient } from '../src/carrier/signaling-client.js'

interface DhModule {
  generateKeyPair(): { publicKey: Buffer; secretKey: Buffer }
}

const dhHelper: DhModule =
  (dh as unknown as { default?: DhModule }).default ?? (dh as unknown as DhModule)

function makeKeyPair() {
  const raw = dhHelper.generateKeyPair()
  return {
    publicKey: new Uint8Array(raw.publicKey),
    secretKey: new Uint8Array(raw.secretKey),
  }
}

async function openRawWebSocketUpgrade(
  host: string,
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; socket: Socket }> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`timed out waiting for HTTP upgrade response on ${path}`))
    }, 3_000)
    const wsKey = randomBytes(16).toString('base64')
    const headerLines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${wsKey}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      '\r\n',
    ]
    let buffered = ''
    const finish = (statusCode: number) => {
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      resolve({ statusCode, socket })
    }
    const onError = (err: Error) => {
      clearTimeout(timer)
      reject(err)
    }
    const onClose = () => {
      clearTimeout(timer)
      const firstLine = buffered.split('\r\n')[0] ?? ''
      const match = /^HTTP\/\d+\.\d+\s+(\d{3})/.exec(firstLine)
      if (match) {
        resolve({ statusCode: Number(match[1]), socket })
      } else {
        reject(new Error(`socket closed before HTTP response (${buffered})`))
      }
    }
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const headerEnd = buffered.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const statusLine = buffered.slice(0, buffered.indexOf('\r\n'))
      const match = /^HTTP\/\d+\.\d+\s+(\d{3})/.exec(statusLine)
      if (!match) {
        clearTimeout(timer)
        socket.destroy()
        reject(new Error(`invalid HTTP response status line: ${statusLine}`))
        return
      }
      finish(Number(match[1]))
    }
    socket.on('error', onError)
    socket.once('close', onClose)
    socket.on('data', onData)
    socket.once('connect', () => {
      socket.write(headerLines.join('\r\n'))
    })
  })
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!
    await Promise.resolve(fn()).catch(() => {})
  }
})

describe('BlindGatewayServer', () => {
  it('fails closed unless enabled is explicitly true and explicit non-wildcard host is set', async () => {
    const disabled = new BlindGatewayServer({ host: '127.0.0.1', port: 0 })
    await expect(disabled.start()).rejects.toThrow(/disabled by default/i)

    const wildcardDenied = new BlindGatewayServer({ enabled: true, host: '0.0.0.0', port: 0 })
    await expect(wildcardDenied.start()).rejects.toThrow(/wildcard binding is disabled/i)

    const badHost = new BlindGatewayServer({ enabled: true, host: 'localhost', port: 0 })
    await expect(badHost.start()).rejects.toThrow(/explicit IP address/i)
  })

  it('multiplexes /healthz, WS /relay, WS /signal, and rejects unconfigured /app/ on a single port', async () => {
    const gateway = new BlindGatewayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      hostAuthSecret: 'gw-secret-123',
    })
    await gateway.start()
    cleanups.push(() => gateway.stop())

    const relayUrl = gateway.getRelayEndpointUrl()!
    const signalingUrl = gateway.getSignalingEndpointUrl()!
    const httpBase = gateway.getHttpBaseUrl()!

    expect(relayUrl.endsWith('/relay')).toBe(true)
    expect(signalingUrl.endsWith('/signal')).toBe(true)
    expect(gateway.getWebAppUrl()).toBeUndefined()

    const healthRes = await fetch(`${httpBase}/healthz`)
    expect(healthRes.status).toBe(200)
    const health = (await healthRes.json()) as {
      ok: boolean
      mode: string
      endpoints: { relay: string; signaling: string; app: null | string }
    }
    expect(health.ok).toBe(true)
    expect(health.mode).toBe('gateway')
    expect(health.endpoints).toEqual({ relay: '/relay', signaling: '/signal', app: null })
    expect(JSON.stringify(health)).not.toContain('gw-secret-123')

    const appMissing = await fetch(`${httpBase}/app/`)
    expect(appMissing.status).toBe(404)

    // 1. Test /relay end-to-end encrypted traffic
    const hostStore = new InMemoryHostIdentityStore()
    const trustStore = new InMemoryDeviceTrustStore()
    const tokenRegistry = new PairingTokenRegistry()
    const coordinator = new PairingCoordinator(hostStore, trustStore, tokenRegistry)
    const seams: OfficialRemoteSeams = {
      listSessions: async () => [{ id: 's-gw', title: 'Gateway Session' }],
      assertSession: async () => {},
      followup: async () => ({}),
      respondApproval: async () => ({}),
      respondQuestion: async () => ({}),
    }
    const runtime = new RemoteHostRuntime({
      seams,
      trustStore,
      hostIdentityStore: hostStore,
      pairingCoordinator: coordinator,
      carrier: { enabled: false },
      relay: {
        enabled: true,
        relayUrl,
        hostAuthSecret: 'gw-secret-123',
        roomId: 'gw-room-0001',
      },
    })
    await runtime.start()
    cleanups.push(() => runtime.stop())

    const host = await hostStore.loadOrCreate()
    const tokenRecord = tokenRegistry.createToken({
      trustDomainId: host.identity.trustDomainId,
      hostGeneration: host.identity.generation,
      allowedCapabilities: ['observe'],
      ttlMs: 60_000,
    })

    const clientKeys = makeKeyPair()
    const client = new FailoverRemoteClient({
      clientKeyPair: clientKeys,
      hostPublicKey: host.identity.publicKey,
      priorityOrder: ['relay'],
      relay: {
        relayUrl,
        roomId: 'gw-room-0001',
      },
    })
    await client.connect()
    cleanups.push(async () => client.close())
    const pairReq = (await client.request('pairing.request', {
      token: tokenRecord.token,
      displayName: 'Gateway Client',
    })) as { candidateId: string }
    await coordinator.confirmPairing({
      candidateId: pairReq.candidateId,
      grantedCapabilities: ['observe'],
    })
    client.close()
    await client.connect()
    const sessions = (await client.request('session.list')) as Array<{ id: string }>
    expect(sessions[0]?.id).toBe('s-gw')

    // 2. Test /signal WebRTC signaling rendezvous on the exact same port
    const hostSignal = new SignalingClient(signalingUrl)
    await hostSignal.registerHost({
      roomId: 'gw-sig-room-1',
      hostAuthSecret: 'gw-secret-123',
    })
    cleanups.push(async () => hostSignal.close())

    const clientSignal = new SignalingClient(signalingUrl)
    const seenOffer = new Promise<string>((resolve) => {
      clientSignal.setHandlers({
        onOffer: (msg) => resolve(msg.sdp.sdp),
      })
    })
    const joined = await clientSignal.joinRoom({ roomId: 'gw-sig-room-1' })
    cleanups.push(async () => clientSignal.close())

    hostSignal.sendOffer(joined.peerId, { type: 'offer', sdp: 'v=0\r\n' })
    expect(await seenOffer).toBe('v=0\r\n')

    // 3. Unknown WS upgrade path is rejected cleanly
    const unknownClosed = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${httpBase.replace('http:', 'ws:')}/unknown`)
      ws.onerror = () => resolve(true)
      ws.onclose = () => resolve(true)
      ws.onopen = () => {
        ws.close()
        resolve(false)
      }
    })
    expect(unknownClosed).toBe(true)

    const stats = gateway.getStats()
    expect(stats.relay.opaqueFramesRelayed).toBeGreaterThan(0)
    expect(stats.signaling.relayedMessages).toBeGreaterThanOrEqual(1)
    expect(stats.unknownUpgradeRequests).toBe(1)
  })

  it('serves opt-in /app/ assets with strict CSP, path-traversal containment, and symlink rejection', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'dsh-gw-webapp-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-gw-outside-'))
    cleanups.push(() => rm(tmp, { recursive: true, force: true }))
    cleanups.push(() => rm(outside, { recursive: true, force: true }))

    await writeFile(join(outside, 'secret.html'), '<h1>secret</h1>', 'utf8')
    await writeFile(join(tmp, 'index.html'), '<!doctype html><html><body>OK</body></html>', 'utf8')
    await writeFile(join(tmp, 'app.js'), 'console.log("ok")\n', 'utf8')
    await writeFile(join(tmp, 'app.js.map'), '{"version":3}', 'utf8')
    await mkdir(join(tmp, 'sub'))
    await writeFile(join(tmp, '.hidden.html'), 'hidden', 'utf8')
    await symlink(join(outside, 'secret.html'), join(tmp, 'leak.html'))

    const gateway = new BlindGatewayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      webAppDir: tmp,
    })
    await gateway.start()
    cleanups.push(() => gateway.stop())

    const base = gateway.getHttpBaseUrl()!
    expect(gateway.getWebAppUrl()).toBe(`${base}/app/`)

    // Redirect /app -> /app/
    const redir = await fetch(`${base}/app`, { redirect: 'manual' })
    expect(redir.status).toBe(302)
    expect(redir.headers.get('location')).toBe('/app/')

    // Serve /app/ (index.html) with no-store & CSP
    const indexRes = await fetch(`${base}/app/`)
    expect(indexRes.status).toBe(200)
    expect(indexRes.headers.get('x-content-type-options')).toBe('nosniff')
    expect(indexRes.headers.get('cache-control')).toBe('no-store')
    expect(indexRes.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(indexRes.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(indexRes.headers.get('x-frame-options')).toBe('DENY')
    expect(await indexRes.text()).toContain('OK')

    // Serve allowlisted .js with cache header
    const jsRes = await fetch(`${base}/app/app.js`)
    expect(jsRes.status).toBe(200)
    expect(jsRes.headers.get('content-type')).toContain('application/javascript')
    expect(jsRes.headers.get('cache-control')).toBe('public, max-age=300')

    // Reject .map, dotfiles, path traversal, and symlinks
    expect((await fetch(`${base}/app/app.js.map`)).status).toBe(404)
    expect((await fetch(`${base}/app/.hidden.html`)).status).toBe(404)
    expect((await fetch(`${base}/app/%2e%2e/outside/secret.html`)).status).toBe(404)
    expect((await fetch(`${base}/app/leak.html`)).status).toBe(404)
  })

  it('encodes companion Web pairing URL using #pair fragment', () => {
    const serverKeys = makeKeyPair()
    const descriptor = createPairingBootstrapDescriptor({
      protocolVersion: 1,
      hostPublicKey: serverKeys.publicKey,
      bootstrapToken: 'tok-12345678',
      endpointUrl: 'ws://127.0.0.1:9000/ws',
      relayUrl: 'wss://gateway.example.com/relay',
      relayRoomId: 'room-12345678',
      expiresAt: Date.now() + 60_000,
    })

    const webUrl = encodePairingWebUrl('https://gateway.example.com/app/#stale', descriptor)
    expect(webUrl.startsWith('https://gateway.example.com/app/#pair=')).toBe(true)
    const encodedPair = webUrl.split('#pair=')[1]!
    const parsed = parsePairingInput(Buffer.from(encodedPair, 'base64url').toString('utf8'))
    expect(parsed.hostFingerprint).toBe(descriptor.hostFingerprint)
    expect(parsed.relayUrl).toBe('wss://gateway.example.com/relay')

    // Loopback http:// and https:// succeed; non-loopback http:// and embedded credentials are rejected
    expect(encodePairingWebUrl('http://127.0.0.1:4555/app/', descriptor)).toContain('#pair=')
    expect(encodePairingWebUrl('http://localhost:4555/app/', descriptor)).toContain('#pair=')
    expect(encodePairingWebUrl('http://[::1]:4555/app/', descriptor)).toContain('#pair=')
    expect(() => encodePairingWebUrl('http://192.168.1.25:4555/app/', descriptor)).toThrow(/non-loopback/)
    expect(() => encodePairingWebUrl('http://gateway.example.com/app/', descriptor)).toThrow(/non-loopback/)
    expect(() => encodePairingWebUrl('http://0.0.0.0:4555/app/', descriptor)).toThrow(/non-loopback/)
    expect(() => encodePairingWebUrl('https://user:pass@gateway.example.com/app/', descriptor)).toThrow(/credentials/)
  })

  it('enforces maxConnectionsPerIp across SelfHostedSignalingServer and BlindGatewayServer /relay + /signal', async () => {
    const openWs = (url: string) =>
      new Promise<WebSocket | null>((resolve) => {
        const ws = new WebSocket(url)
        let settled = false
        const fail = () => {
          if (settled) return
          settled = true
          resolve(null)
        }
        ws.onopen = () => {
          if (settled) return
          settled = true
          cleanups.push(async () => {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
              ws.close()
            }
          })
          resolve(ws)
        }
        ws.onerror = fail
        ws.onclose = fail
      })

    const closeWsAndSettle = (ws: WebSocket) =>
      new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) {
          resolve()
          return
        }
        ws.onclose = () => setTimeout(resolve, 20)
        ws.close()
      })

    // 1. Standalone SelfHostedSignalingServer per-IP cap
    const sig = new SelfHostedSignalingServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      maxConnectionsPerIp: 2,
    })
    await sig.start()
    cleanups.push(() => sig.stop())

    const sigUrl = sig.getEndpointUrl()!
    const s1 = await openWs(sigUrl)
    const s2 = await openWs(sigUrl)
    expect(s1).not.toBeNull()
    expect(s2).not.toBeNull()

    const s3 = await openWs(sigUrl)
    expect(s3).toBeNull()
    expect(sig.getStats().rejectedPerIpCap).toBeGreaterThanOrEqual(1)

    await closeWsAndSettle(s1!)
    const s4 = await openWs(sigUrl)
    expect(s4).not.toBeNull()

    // 2. BlindGatewayServer combined /relay + /signal per-IP cap
    const gateway = new BlindGatewayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      maxConnectionsPerIp: 2,
      hostAuthSecret: 'cap-secret-1',
    })
    await gateway.start()
    cleanups.push(() => gateway.stop())

    const gwRelay = gateway.getRelayEndpointUrl()!
    const gwSig = gateway.getSignalingEndpointUrl()!
    const g1 = await openWs(gwRelay)
    const g2 = await openWs(gwSig)
    expect(g1).not.toBeNull()
    expect(g2).not.toBeNull()

    const g3 = await openWs(gwSig)
    const g4 = await openWs(gwRelay)
    expect(g3).toBeNull()
    expect(g4).toBeNull()

    await closeWsAndSettle(g1!)
    const g5 = await openWs(gwSig)
    expect(g5).not.toBeNull()

    await Promise.all([
      closeWsAndSettle(s2!),
      closeWsAndSettle(s4!),
      closeWsAndSettle(g2!),
      closeWsAndSettle(g5!),
    ])
  })

  it('enforces maxConnectionsPerIp pre-upgrade on idle/incomplete TCP connections and times out stalled handshakes', async () => {
    const gateway = new BlindGatewayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      maxConnections: 4,
      maxConnectionsPerIp: 1,
      registerTimeoutMs: 120,
      hostAuthSecret: 'cap-secret-2',
    })
    await gateway.start()
    cleanups.push(() => gateway.stop())

    const addr = gateway.getBoundAddress()!
    const connectRaw = () =>
      new Promise<Socket>((resolve, reject) => {
        const sock = createConnection({ host: addr.host, port: addr.port }, () => resolve(sock))
        sock.once('error', reject)
        cleanups.push(async () => {
          sock.destroy()
        })
      })

    // Open one incomplete HTTP / idle TCP socket consuming the single per-IP slot
    const s1 = await connectRaw()
    s1.write('GET /healthz HTTP/1.1\r\n')
    await new Promise((r) => setTimeout(r, 20))

    // Second concurrent socket from the same IP is rejected immediately pre-upgrade with 429
    const secondOutcome = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = []
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve(Buffer.concat(chunks).toString('utf8'))
      }
      const s2 = createConnection({ host: addr.host, port: addr.port })
      s2.on('data', (chunk) => chunks.push(chunk))
      s2.once('close', done)
      s2.once('error', done)
      cleanups.push(async () => {
        s2.destroy()
      })
    })
    expect(secondOutcome).toContain('429 Too Many Requests')
    expect(gateway.getStats().rejectedPerIpCap).toBeGreaterThanOrEqual(1)

    // First stalled socket times out via pre-upgrade registerTimeoutMs and frees the IP slot
    await new Promise<void>((resolve, reject) => {
      if (s1.destroyed || s1.closed) {
        resolve()
        return
      }
      const timer = setTimeout(() => reject(new Error('stalled gateway socket did not time out')), 2_000)
      s1.once('close', () => {
        clearTimeout(timer)
        setTimeout(resolve, 20)
      })
    })

    // Now a valid /relay WebSocket connection from the same IP succeeds
    const wsOk = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(gateway.getRelayEndpointUrl()!)
      ws.onopen = () => {
        ws.close()
        resolve(true)
      }
      ws.onerror = () => resolve(false)
    })
    expect(wsOk).toBe(true)
  })

  it('distinguishes proxied client IPs across /relay and /signal when trustedProxies is set and resists spoofed headers', async () => {
    const gateway = new BlindGatewayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      maxConnections: 16,
      maxConnectionsPerIp: 2,
      trustedProxies: ['127.0.0.1', '10.0.0.0/8'],
    })
    await gateway.start()
    cleanups.push(() => gateway.stop())

    const addr = gateway.getBoundAddress()!
    const openSockets: Socket[] = []
    cleanups.push(async () => {
      for (const s of openSockets) s.destroy()
    })

    // 5 concurrent upgrades from distinct proxied client IPs exceed maxConnectionsPerIp (2) if bucketed by 127.0.0.1
    const distinctClients = [
      { path: '/relay', xff: '203.0.113.1' },
      { path: '/signal', xff: '203.0.113.2' },
      { path: '/relay', xff: '203.0.113.3' },
      { path: '/signal', xff: '203.0.113.4, 10.0.0.12' },
      { path: '/relay', xff: '203.0.113.5' },
    ]
    for (const c of distinctClients) {
      const res = await openRawWebSocketUpgrade('127.0.0.1', addr.port, c.path, {
        'X-Forwarded-For': c.xff,
      })
      openSockets.push(res.socket)
      expect(res.statusCode).toBe(101)
    }

    // Abusive client spoofing arbitrary left-side hops still shares one bucket ('203.0.113.9')
    const abuser1 = await openRawWebSocketUpgrade('127.0.0.1', addr.port, '/relay', {
      'X-Forwarded-For': '1.1.1.1, 203.0.113.9',
    })
    openSockets.push(abuser1.socket)
    expect(abuser1.statusCode).toBe(101)

    const abuser2 = await openRawWebSocketUpgrade('127.0.0.1', addr.port, '/signal', {
      'X-Forwarded-For': '8.8.8.8, ::ffff:203.0.113.9, 10.0.0.9',
    })
    openSockets.push(abuser2.socket)
    expect(abuser2.statusCode).toBe(101)

    const abuserBlocked = await openRawWebSocketUpgrade('127.0.0.1', addr.port, '/relay', {
      'X-Forwarded-For': '9.9.9.9, 203.0.113.9:51234',
    })
    abuserBlocked.socket.destroy()
    expect(abuserBlocked.statusCode).toBe(429)
    expect(gateway.getStats().rejectedPerIpCap).toBeGreaterThanOrEqual(1)

    // Saturated client is also throttled on HTTP endpoints while healthy proxied clients succeed
    const blockedHttp = await fetch(`${gateway.getHttpBaseUrl()!}/healthz`, {
      headers: { 'X-Forwarded-For': '203.0.113.9' },
    })
    expect(blockedHttp.status).toBe(429)

    const healthyHttp = await fetch(`${gateway.getHttpBaseUrl()!}/healthz`, {
      headers: { 'X-Forwarded-For': '203.0.113.10' },
    })
    expect(healthyHttp.status).toBe(200)

    // RFC 7239 Forwarded header resolves cleanly for another client while abuser stays blocked
    const rfcClient = await openRawWebSocketUpgrade('127.0.0.1', addr.port, '/signal', {
      Forwarded: 'for="203.0.113.11:4444";proto=https',
    })
    openSockets.push(rfcClient.socket)
    expect(rfcClient.statusCode).toBe(101)
  })

  it('fails closed on forwarding headers unless peer matches trustedProxies and rejects invalid CIDRs', async () => {
    expect(
      () =>
        new BlindGatewayServer({
          enabled: true,
          host: '127.0.0.1',
          port: 0,
          trustedProxies: ['0.0.0.0/0'],
        }),
    ).toThrow(/between 1 and 32/i)
    expect(
      () =>
        new BlindGatewayServer({
          enabled: true,
          host: '127.0.0.1',
          port: 0,
          trustedProxies: ['not-a-cidr'],
        }),
    ).toThrow(/invalid trusted proxy/i)

    // Without trustedProxies, X-Forwarded-For is completely ignored and peer IP is capped
    const noProxyGw = new BlindGatewayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      maxConnectionsPerIp: 2,
    })
    await noProxyGw.start()
    cleanups.push(() => noProxyGw.stop())

    const addr1 = noProxyGw.getBoundAddress()!
    const s1 = await openRawWebSocketUpgrade('127.0.0.1', addr1.port, '/relay', {
      'X-Forwarded-For': '203.0.113.21',
    })
    const s2 = await openRawWebSocketUpgrade('127.0.0.1', addr1.port, '/relay', {
      'X-Forwarded-For': '203.0.113.22',
    })
    cleanups.push(async () => {
      s1.socket.destroy()
      s2.socket.destroy()
    })
    expect(s1.statusCode).toBe(101)
    expect(s2.statusCode).toBe(101)

    const s3 = await openRawWebSocketUpgrade('127.0.0.1', addr1.port, '/relay', {
      'X-Forwarded-For': '203.0.113.23',
    })
    s3.socket.destroy()
    expect(s3.statusCode).toBe(429)

    // With non-matching trustedProxies (10.20.0.0/16), loopback 127.0.0.1 peer still cannot spoof X-Forwarded-For
    const mismatchProxyGw = new BlindGatewayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      maxConnectionsPerIp: 1,
      trustedProxies: ['10.20.0.0/16'],
    })
    await mismatchProxyGw.start()
    cleanups.push(() => mismatchProxyGw.stop())

    const addr2 = mismatchProxyGw.getBoundAddress()!
    const m1 = await openRawWebSocketUpgrade('127.0.0.1', addr2.port, '/signal', {
      'X-Forwarded-For': '203.0.113.31',
    })
    cleanups.push(async () => m1.socket.destroy())
    expect(m1.statusCode).toBe(101)

    const m2 = await openRawWebSocketUpgrade('127.0.0.1', addr2.port, '/signal', {
      'X-Forwarded-For': '203.0.113.32',
    })
    m2.socket.destroy()
    expect(m2.statusCode).toBe(429)
  })

  it('supports proxy-aware per-IP caps and IPv6 canonicalization on standalone BlindRelayServer and SelfHostedSignalingServer', async () => {
    const relay = new BlindRelayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      maxConnectionsPerIp: 1,
      trustedProxies: ['127.0.0.1'],
    })
    await relay.start()
    cleanups.push(() => relay.stop())
    const rAddr = relay.getBoundAddress()!

    const r1 = await openRawWebSocketUpgrade('127.0.0.1', rAddr.port, '/', {
      'X-Forwarded-For': '203.0.113.41',
    })
    const r2 = await openRawWebSocketUpgrade('127.0.0.1', rAddr.port, '/', {
      'X-Forwarded-For': '203.0.113.42',
    })
    cleanups.push(async () => {
      r1.socket.destroy()
      r2.socket.destroy()
    })
    expect(r1.statusCode).toBe(101)
    expect(r2.statusCode).toBe(101)

    const r3 = await openRawWebSocketUpgrade('127.0.0.1', rAddr.port, '/', {
      'X-Forwarded-For': '203.0.113.41',
    })
    r3.socket.destroy()
    expect(r3.statusCode).toBe(429)

    const signaling = new SelfHostedSignalingServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      maxConnectionsPerIp: 1,
      ipv6PrefixLength: 128,
      trustedProxies: ['127.0.0.1'],
    })
    await signaling.start()
    cleanups.push(() => signaling.stop())
    const sAddr = signaling.getBoundAddress()!

    const sig1 = await openRawWebSocketUpgrade('127.0.0.1', sAddr.port, '/', {
      'X-Forwarded-For': '[2001:0db8::1]:40001',
    })
    const sig2 = await openRawWebSocketUpgrade('127.0.0.1', sAddr.port, '/', {
      'X-Forwarded-For': '2001:db8:0:0::2',
    })
    cleanups.push(async () => {
      sig1.socket.destroy()
      sig2.socket.destroy()
    })
    expect(sig1.statusCode).toBe(101)
    expect(sig2.statusCode).toBe(101)

    // Equivalent non-canonical IPv6 form hits the same per-IP cap as sig1
    const sigDup = await openRawWebSocketUpgrade('127.0.0.1', sAddr.port, '/', {
      'X-Forwarded-For': '2001:db8:0000:0000:0000:0000:0000:0001',
    })
    sigDup.socket.destroy()
    expect(sigDup.statusCode).toBe(429)
  })

  it('aggregates IPv6 prefixes (default /64, configurable) and enforces a global pre-auth rate budget', async () => {
    expect(normalizeIpForRateLimit('2001:db8:abcd:1234::1')).toBe('2001:db8:abcd:1234::/64')
    expect(normalizeIpForRateLimit('2001:db8:abcd:1234:dead:beef::99')).toBe('2001:db8:abcd:1234::/64')
    expect(normalizeIpForRateLimit('2001:db8:abcd:1234::1', 48)).toBe('2001:db8:abcd::/48')
    expect(normalizeIpForRateLimit('::ffff:203.0.113.9', 64)).toBe('203.0.113.9')
    expect(() => normalizeIpForRateLimit('2001:db8::1', 0)).toThrow(/ipv6PrefixLength/i)
    expect(() => normalizeIpForRateLimit('2001:db8::1', 129)).toThrow(/ipv6PrefixLength/i)

    expect(
      () =>
        new BlindGatewayServer({
          enabled: true,
          host: '127.0.0.1',
          port: 0,
          ipv6PrefixLength: 0,
        }),
    ).toThrow(/ipv6PrefixLength/i)

    // Default /64 aggregation: distinct /128s inside the same /64 share maxConnectionsPerIp
    const v6Gw = new BlindGatewayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      maxConnections: 16,
      maxConnectionsPerIp: 2,
      trustedProxies: ['127.0.0.1'],
    })
    await v6Gw.start()
    cleanups.push(() => v6Gw.stop())
    const v6Addr = v6Gw.getBoundAddress()!

    const p1 = await openRawWebSocketUpgrade('127.0.0.1', v6Addr.port, '/relay', {
      'X-Forwarded-For': '2001:db8:1:2::1',
    })
    const p2 = await openRawWebSocketUpgrade('127.0.0.1', v6Addr.port, '/signal', {
      'X-Forwarded-For': '2001:db8:1:2:dead:beef::2',
    })
    cleanups.push(async () => {
      p1.socket.destroy()
      p2.socket.destroy()
    })
    expect(p1.statusCode).toBe(101)
    expect(p2.statusCode).toBe(101)

    const p3Same64 = await openRawWebSocketUpgrade('127.0.0.1', v6Addr.port, '/relay', {
      'X-Forwarded-For': '2001:db8:1:2:cafe::3',
    })
    p3Same64.socket.destroy()
    expect(p3Same64.statusCode).toBe(429)
    expect(v6Gw.getStats().rejectedPerIpCap).toBeGreaterThanOrEqual(1)

    const p4Other64 = await openRawWebSocketUpgrade('127.0.0.1', v6Addr.port, '/relay', {
      'X-Forwarded-For': '2001:db8:1:3::1',
    })
    cleanups.push(async () => p4Other64.socket.destroy())
    expect(p4Other64.statusCode).toBe(101)

    // Global pre-auth rate budget stops rapid churn across distinct prefixes/IPs without filling maxConnections
    const rateGw = new BlindGatewayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      maxConnections: 16,
      maxConnectionsPerIp: 2,
      ipv6PrefixLength: 48,
      maxPreAuthConnectionsPerWindow: 3,
      preAuthRateWindowMs: 80,
      trustedProxies: ['127.0.0.1'],
    })
    await rateGw.start()
    cleanups.push(() => rateGw.stop())
    const rAddr = rateGw.getBoundAddress()!

    const distinctPrefixes = [
      '2001:db8:10::1',
      '2001:db8:20::1',
      '2001:db8:30::1',
      '2001:db8:40::1',
    ]
    const results: number[] = []
    for (const ip of distinctPrefixes) {
      const up = await openRawWebSocketUpgrade('127.0.0.1', rAddr.port, '/relay', {
        'X-Forwarded-For': ip,
      })
      results.push(up.statusCode)
      up.socket.destroy()
    }
    expect(results).toEqual([101, 101, 101, 429])
    expect(rateGw.getStats().rejectedPreAuthRate).toBeGreaterThanOrEqual(1)

    await new Promise((resolve) => setTimeout(resolve, 95))
    const recovered = await openRawWebSocketUpgrade('127.0.0.1', rAddr.port, '/signal', {
      'X-Forwarded-For': '2001:db8:50::1',
    })
    recovered.socket.destroy()
    expect(recovered.statusCode).toBe(101)
  })

  it('enforces per-IP and IPv6 prefix pre-auth admission windows before global budget', async () => {
    expect(
      () =>
        new BlindGatewayServer({
          enabled: true,
          host: '127.0.0.1',
          port: 0,
          maxPreAuthConnectionsPerIpPerWindow: 0,
        }),
    ).toThrow(/maxPreAuthConnectionsPerIpPerWindow/i)

    // Single attacker /64 hammering /healthz sequentially cannot starve global pre-auth budget
    const httpGw = new BlindGatewayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      maxConnections: 32,
      maxConnectionsPerIp: 1,
      maxPreAuthConnectionsPerWindow: 3, // default per-IP window => max(1, floor(3 / 4)) = 1
      preAuthRateWindowMs: 1_000,
      trustedProxies: ['127.0.0.1'],
    })
    await httpGw.start()
    cleanups.push(() => httpGw.stop())
    const httpAddr = httpGw.getBoundAddress()!

    const sendHealthz = async (forwardedIp: string) => {
      const res = await fetch(`http://127.0.0.1:${httpAddr.port}/healthz`, {
        headers: { 'X-Forwarded-For': forwardedIp },
      })
      const body = (await res.json()) as { ok?: boolean; error?: string }
      return { status: res.status, body }
    }

    const r1 = await sendHealthz('2001:db8:77::1')
    const r2Same64 = await sendHealthz('2001:db8:77::2')
    const r3Same64 = await sendHealthz('2001:db8:77::3')
    expect(r1.status).toBe(200)
    expect(r2Same64.status).toBe(429)
    expect(r2Same64.body.error).toBe('too many requests')
    expect(r3Same64.status).toBe(429)
    expect(httpGw.getStats().rejectedPerIpCap).toBe(2)
    expect(httpGw.getStats().rejectedPreAuthRate).toBe(0)

    const otherClient1 = await sendHealthz('198.51.100.44')
    const otherClient2 = await sendHealthz('203.0.113.45')
    const overGlobal = await sendHealthz('203.0.113.46')
    expect(otherClient1.status).toBe(200)
    expect(otherClient2.status).toBe(200)
    expect(overGlobal.status).toBe(429)
    expect(overGlobal.body.error).toBe('too many pre-auth requests')
    expect(httpGw.getStats().rejectedPreAuthRate).toBe(1)

    // Explicit maxPreAuthConnectionsPerIpPerWindow on WebSocket upgrades behind trusted proxy
    const wsGw = new BlindGatewayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      maxConnections: 32,
      maxConnectionsPerIp: 4,
      maxPreAuthConnectionsPerWindow: 4,
      maxPreAuthConnectionsPerIpPerWindow: 2,
      preAuthRateWindowMs: 1_000,
      trustedProxies: ['127.0.0.1'],
    })
    await wsGw.start()
    cleanups.push(() => wsGw.stop())
    const wsAddr = wsGw.getBoundAddress()!

    const wsStatuses: number[] = []
    for (let i = 0; i < 4; i++) {
      const up = await openRawWebSocketUpgrade('127.0.0.1', wsAddr.port, i < 2 ? '/relay' : '/signal', {
        'X-Forwarded-For': '198.51.100.10',
      })
      wsStatuses.push(up.statusCode)
      up.socket.destroy()
    }
    expect(wsStatuses).toEqual([101, 101, 429, 429])
    expect(wsGw.getStats().rejectedPerIpCap).toBe(2)
    expect(wsGw.getStats().rejectedPreAuthRate).toBe(0)

    const otherWs = await openRawWebSocketUpgrade('127.0.0.1', wsAddr.port, '/signal', {
      'X-Forwarded-For': '203.0.113.55',
    })
    otherWs.socket.destroy()
    expect(otherWs.statusCode).toBe(101)

    // Direct untrusted TCP connection path also enforces per-IP window before global budget
    const directRelay = new BlindRelayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      maxConnections: 16,
      maxConnectionsPerIp: 4,
      maxPreAuthConnectionsPerWindow: 3,
      maxPreAuthConnectionsPerIpPerWindow: 1,
      preAuthRateWindowMs: 90,
    })
    await directRelay.start()
    cleanups.push(() => directRelay.stop())
    const directAddr = directRelay.getBoundAddress()!

    const d1 = await openRawWebSocketUpgrade('127.0.0.1', directAddr.port, '/relay')
    d1.socket.destroy()
    expect(d1.statusCode).toBe(101)

    const d2 = await openRawWebSocketUpgrade('127.0.0.1', directAddr.port, '/relay')
    d2.socket.destroy()
    expect(d2.statusCode).toBe(429)
    expect(directRelay.getStats().rejectedPerIpCap).toBeGreaterThanOrEqual(1)
    expect(directRelay.getStats().rejectedPreAuthRate).toBe(0)

    await new Promise((resolve) => setTimeout(resolve, 110))
    const d3Recovered = await openRawWebSocketUpgrade('127.0.0.1', directAddr.port, '/relay')
    d3Recovered.socket.destroy()
    expect(d3Recovered.statusCode).toBe(101)
  })

  it('rate-limits pipelined and keep-alive HTTP requests plus post-HTTP upgrades on tracked sockets', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'dsh-gw-keepalive-rate-'))
    cleanups.push(() => rm(tmp, { recursive: true, force: true }))
    await writeFile(join(tmp, 'index.html'), '<!doctype html><html><body>OK</body></html>', 'utf8')
    await writeFile(join(tmp, 'app.js'), 'console.log("asset")\n', 'utf8')

    // Exact Codex repro: direct socket with both limits = 1 pipelining 64 /app/app.js GETs
    const gw = new BlindGatewayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      maxConnections: 16,
      maxConnectionsPerIp: 1,
      maxPreAuthConnectionsPerWindow: 1,
      maxPreAuthConnectionsPerIpPerWindow: 1,
      preAuthRateWindowMs: 1_000,
      webAppDir: tmp,
    })
    await gw.start()
    cleanups.push(() => gw.stop())
    const addr = gw.getBoundAddress()!

    const pipelinedResponses = await new Promise<string>((resolve, reject) => {
      const sock = createConnection({ host: '127.0.0.1', port: addr.port })
      const chunks: Buffer[] = []
      const timer = setTimeout(() => {
        sock.destroy()
        reject(new Error('timed out waiting for pipelined HTTP responses'))
      }, 3_000)
      sock.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      sock.on('data', (chunk) => chunks.push(chunk))
      sock.once('close', () => {
        clearTimeout(timer)
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
      sock.once('connect', () => {
        const singleReq =
          `GET /app/app.js HTTP/1.1\r\nHost: 127.0.0.1:${addr.port}\r\nConnection: keep-alive\r\n\r\n`
        sock.write(singleReq.repeat(64))
      })
    })

    const statusCodes = [...pipelinedResponses.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((m) => Number(m[1]))
    expect(statusCodes.length).toBeGreaterThanOrEqual(2)
    expect(statusCodes[0]).toBe(200)
    expect(statusCodes.slice(1).every((code) => code === 429)).toBe(true)
    expect(gw.getStats().webAppRequests).toBe(1)
    expect(gw.getStats().rejectedPerIpCap).toBeGreaterThanOrEqual(1)

    // Keep-alive HTTP request consumes the initial connection admission, so a subsequent WS upgrade or keep-alive GET is also rate-checked
    const gw2 = new BlindGatewayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      maxConnections: 16,
      maxConnectionsPerIp: 2,
      maxPreAuthConnectionsPerWindow: 1,
      maxPreAuthConnectionsPerIpPerWindow: 2,
      preAuthRateWindowMs: 1_000,
      webAppDir: tmp,
    })
    await gw2.start()
    cleanups.push(() => gw2.stop())
    const addr2 = gw2.getBoundAddress()!

    await new Promise<void>((resolve, reject) => {
      const sock = createConnection({ host: '127.0.0.1', port: addr2.port })
      const timer = setTimeout(() => {
        sock.destroy()
        reject(new Error('timed out waiting for keep-alive HTTP + WS upgrade'))
      }, 3_000)
      let stage: 'http' | 'ws' = 'http'
      let buf = ''
      sock.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        if (stage === 'http') {
          if (!buf.includes('console.log("asset")')) return
          stage = 'ws'
          buf = ''
          sock.write(
            [
              'GET /relay HTTP/1.1',
              `Host: 127.0.0.1:${addr2.port}`,
              'Upgrade: websocket',
              'Connection: Upgrade',
              'Sec-WebSocket-Version: 13',
              `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
              '\r\n',
            ].join('\r\n'),
          )
        } else {
          if (!buf.includes('\r\n\r\n')) return
          clearTimeout(timer)
          sock.destroy()
          expect(buf.startsWith('HTTP/1.1 429 ')).toBe(true)
          resolve()
        }
      })
      sock.once('connect', () => {
        sock.write(
          `GET /app/app.js HTTP/1.1\r\nHost: 127.0.0.1:${addr2.port}\r\nConnection: keep-alive\r\n\r\n`,
        )
      })
    })
    expect(gw2.getStats().webAppRequests).toBe(1)
    expect(gw2.getStats().rejectedPreAuthRate).toBe(1)
  })
})
