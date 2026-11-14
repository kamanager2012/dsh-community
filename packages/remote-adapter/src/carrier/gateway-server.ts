import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP, type AddressInfo, type Socket } from 'node:net'
import { extname, resolve, sep } from 'node:path'
import { RemoteCryptoError } from '../crypto/errors.js'
import { ProxyAwareHttpConnectionGuard } from './ip-cap.js'
import {
  BlindRelayServer,
  type BlindRelayFrameObservation,
  type BlindRelayStats,
} from './relay-server.js'
import {
  SelfHostedSignalingServer,
  type SignalingStats,
} from './signaling-server.js'

const MAX_STATIC_ASSET_BYTES = 8 * 1024 * 1024

const STATIC_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
})

const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';",
})

export interface BlindGatewayStats {
  readonly relay: BlindRelayStats
  readonly signaling: SignalingStats
  readonly webAppEnabled: boolean
  readonly webAppRequests: number
  readonly webAppRejectedRequests: number
  readonly unknownUpgradeRequests: number
  readonly rejectedPerIpCap: number
  readonly rejectedPreAuthRate: number
}

export interface BlindGatewayServerOptions {
  /** Explicitly enable the single-port gateway. Default is false (fail closed). */
  readonly enabled?: boolean | undefined
  /** IP address to bind (e.g. 127.0.0.1 or 0.0.0.0 with allowWildcardHost). */
  readonly host: string
  /** TCP port for unified HTTP + WebSocket multiplexing (0 for ephemeral). */
  readonly port?: number | undefined
  readonly allowWildcardHost?: boolean | undefined
  /** Shared host registration secret for both /relay and /signal unless overridden per path. */
  readonly hostAuthSecret?: string | undefined
  readonly relayHostSecret?: string | undefined
  readonly signalingHostSecret?: string | undefined
  readonly maxRooms?: number | undefined
  readonly maxClientsPerRoom?: number | undefined
  readonly maxPeersPerRoom?: number | undefined
  readonly maxConnections?: number | undefined
  readonly maxConnectionsPerIp?: number | undefined
  /** IPv6 prefix length used when bucketing client IPs (default: 64). */
  readonly ipv6PrefixLength?: number | undefined
  /** Sliding-window global pre-auth admission cap (default: max(32, floor(maxConnections / 2))). */
  readonly maxPreAuthConnectionsPerWindow?: number | undefined
  /** Sliding window length for global pre-auth rate budget in ms (default: 5000). */
  readonly preAuthRateWindowMs?: number | undefined
  /** Explicit trusted reverse-proxy IPs/CIDRs allowed to supply forwarded client IPs (fail-closed by default). */
  readonly trustedProxies?: readonly string[] | undefined
  readonly maxOpaquePayloadBytes?: number | undefined
  readonly maxFrameBytes?: number | undefined
  readonly maxOutboundQueue?: number | undefined
  readonly maxFramesPerSecond?: number | undefined
  readonly maxMessagesPerSecond?: number | undefined
  readonly registerTimeoutMs?: number | undefined
  readonly idleTimeoutMs?: number | undefined
  readonly onBlindFrame?: ((obs: BlindRelayFrameObservation) => void) | undefined
  /**
   * Optional directory containing built static PWA assets served strictly read-only at `/app/`.
   * Disabled by default when omitted.
   */
  readonly webAppDir?: string | undefined
}

function sendJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  const json = JSON.stringify(body)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  })
  res.end(json)
}

function resolveCanonicalWebAppRoot(dir: string): string {
  const trimmed = dir.trim()
  if (trimmed.length === 0) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'webAppDir must not be empty')
  }
  let rootReal: string
  let rootStat
  try {
    rootReal = realpathSync(trimmed)
    rootStat = statSync(rootReal)
  } catch {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', `webAppDir does not exist: ${dir}`)
  }
  if (!rootStat.isDirectory()) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', `webAppDir is not a directory: ${dir}`)
  }
  const indexPath = resolve(rootReal, 'index.html')
  let indexReal: string
  let indexStat
  try {
    const lstat = lstatSync(indexPath)
    if (lstat.isSymbolicLink()) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'webAppDir index.html must not be a symlink')
    }
    indexReal = realpathSync(indexPath)
    indexStat = statSync(indexReal)
  } catch (err) {
    if (err instanceof RemoteCryptoError) throw err
    throw new RemoteCryptoError(
      'HANDSHAKE_FAILED',
      `webAppDir must contain index.html: ${dir}`,
    )
  }
  if (!indexReal.startsWith(`${rootReal}${sep}`) || !indexStat.isFile()) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', `invalid index.html in webAppDir: ${dir}`)
  }
  return rootReal
}

function resolveSafeStaticFile(
  canonicalRoot: string,
  subPath: string,
): { readonly path: string; readonly mimeType: string; readonly relName: string } | undefined {
  const trimmed = subPath.length === 0 ? 'index.html' : subPath
  if (trimmed.includes('\0') || trimmed.includes('\\')) {
    return undefined
  }
  const rawSegments = trimmed.split('/')
  const decodedSegments: string[] = []
  for (const rawSeg of rawSegments) {
    if (rawSeg.length === 0) return undefined
    let decoded: string
    try {
      decoded = decodeURIComponent(rawSeg)
    } catch {
      return undefined
    }
    if (
      decoded.length === 0 ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.startsWith('.') ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      decoded.includes('\0')
    ) {
      return undefined
    }
    decodedSegments.push(decoded)
  }

  const ext = extname(decodedSegments[decodedSegments.length - 1] ?? '').toLowerCase()
  const mimeType = STATIC_MIME_TYPES[ext]
  if (!mimeType) {
    return undefined
  }

  let cursor = canonicalRoot
  for (let i = 0; i < decodedSegments.length; i += 1) {
    const seg = decodedSegments[i]!
    cursor = resolve(cursor, seg)
    if (!cursor.startsWith(`${canonicalRoot}${sep}`)) {
      return undefined
    }
    try {
      const lst = lstatSync(cursor)
      if (lst.isSymbolicLink()) {
        return undefined
      }
      if (i < decodedSegments.length - 1) {
        if (!lst.isDirectory()) return undefined
      } else {
        if (!lst.isFile() || lst.size > MAX_STATIC_ASSET_BYTES) return undefined
      }
    } catch {
      return undefined
    }
  }

  try {
    const resolvedReal = realpathSync(cursor)
    if (!resolvedReal.startsWith(`${canonicalRoot}${sep}`)) {
      return undefined
    }
    return {
      path: resolvedReal,
      mimeType,
      relName: decodedSegments.join('/'),
    }
  } catch {
    return undefined
  }
}

/**
 * Single-port blind edge gateway multiplexing:
 *   - `GET /healthz`                -> liveness + blind telemetry (no secrets)
 *   - `WS  /relay`                  -> BlindRelayServer (opaque ciphertext forwarding only)
 *   - `WS  /signal`                 -> SelfHostedSignalingServer (SDP/ICE rendezvous only)
 *   - `GET /app/` (opt-in webAppDir)-> read-only PWA static bundle with strict containment + CSP
 */
export class BlindGatewayServer {
  readonly relay: BlindRelayServer
  readonly signaling: SelfHostedSignalingServer

  private readonly options: BlindGatewayServerOptions
  private readonly maxConnections: number
  private readonly registerTimeoutMs: number
  private readonly connectionGuard: ProxyAwareHttpConnectionGuard
  private server: Server | undefined = undefined
  private canonicalWebAppRoot: string | undefined = undefined
  private isRunning = false
  private webAppRequests = 0
  private webAppRejectedRequests = 0
  private unknownUpgradeRequests = 0
  private rejectedPerIpCap = 0
  private rejectedPreAuthRate = 0

  constructor(options: BlindGatewayServerOptions) {
    this.options = options
    this.maxConnections = options.maxConnections ?? 128
    this.registerTimeoutMs = options.registerTimeoutMs ?? 5_000
    this.connectionGuard = new ProxyAwareHttpConnectionGuard({
      maxConnections: this.maxConnections,
      maxConnectionsPerIp: options.maxConnectionsPerIp ?? 16,
      registerTimeoutMs: this.registerTimeoutMs,
      ...(options.ipv6PrefixLength !== undefined ? { ipv6PrefixLength: options.ipv6PrefixLength } : {}),
      ...(options.maxPreAuthConnectionsPerWindow !== undefined
        ? { maxPreAuthConnectionsPerWindow: options.maxPreAuthConnectionsPerWindow }
        : {}),
      ...(options.preAuthRateWindowMs !== undefined
        ? { preAuthRateWindowMs: options.preAuthRateWindowMs }
        : {}),
      ...(options.trustedProxies !== undefined ? { trustedProxies: options.trustedProxies } : {}),
      onPerIpRejected: () => {
        this.rejectedPerIpCap += 1
      },
      onPreAuthRateRejected: () => {
        this.rejectedPreAuthRate += 1
      },
    })

    const relaySecret = options.relayHostSecret ?? options.hostAuthSecret
    const signalingSecret = options.signalingHostSecret ?? options.hostAuthSecret

    this.relay = new BlindRelayServer({
      enabled: options.enabled,
      host: options.host,
      port: options.port,
      allowWildcardHost: options.allowWildcardHost,
      ...(relaySecret !== undefined ? { hostAuthSecret: relaySecret } : {}),
      ...(options.maxRooms !== undefined ? { maxRooms: options.maxRooms } : {}),
      ...(options.maxClientsPerRoom !== undefined ? { maxClientsPerRoom: options.maxClientsPerRoom } : {}),
      maxConnections: this.maxConnections,
      ...(options.maxConnectionsPerIp !== undefined ? { maxConnectionsPerIp: options.maxConnectionsPerIp } : {}),
      ...(options.ipv6PrefixLength !== undefined ? { ipv6PrefixLength: options.ipv6PrefixLength } : {}),
      ...(options.maxPreAuthConnectionsPerWindow !== undefined
        ? { maxPreAuthConnectionsPerWindow: options.maxPreAuthConnectionsPerWindow }
        : {}),
      ...(options.preAuthRateWindowMs !== undefined
        ? { preAuthRateWindowMs: options.preAuthRateWindowMs }
        : {}),
      ...(options.trustedProxies !== undefined ? { trustedProxies: options.trustedProxies } : {}),
      ...(options.maxOpaquePayloadBytes !== undefined
        ? { maxOpaquePayloadBytes: options.maxOpaquePayloadBytes }
        : {}),
      ...(options.maxOutboundQueue !== undefined ? { maxOutboundQueue: options.maxOutboundQueue } : {}),
      ...(options.maxFramesPerSecond !== undefined ? { maxFramesPerSecond: options.maxFramesPerSecond } : {}),
      ...(options.registerTimeoutMs !== undefined ? { registerTimeoutMs: options.registerTimeoutMs } : {}),
      ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
      ...(options.onBlindFrame !== undefined ? { onBlindFrame: options.onBlindFrame } : {}),
    })

    this.signaling = new SelfHostedSignalingServer({
      enabled: options.enabled,
      host: options.host,
      port: options.port,
      allowWildcardHost: options.allowWildcardHost,
      ...(signalingSecret !== undefined ? { hostAuthSecret: signalingSecret } : {}),
      ...(options.maxRooms !== undefined ? { maxRooms: options.maxRooms } : {}),
      ...(options.maxPeersPerRoom !== undefined ? { maxPeersPerRoom: options.maxPeersPerRoom } : {}),
      maxConnections: this.maxConnections,
      ...(options.maxConnectionsPerIp !== undefined ? { maxConnectionsPerIp: options.maxConnectionsPerIp } : {}),
      ...(options.ipv6PrefixLength !== undefined ? { ipv6PrefixLength: options.ipv6PrefixLength } : {}),
      ...(options.maxPreAuthConnectionsPerWindow !== undefined
        ? { maxPreAuthConnectionsPerWindow: options.maxPreAuthConnectionsPerWindow }
        : {}),
      ...(options.preAuthRateWindowMs !== undefined
        ? { preAuthRateWindowMs: options.preAuthRateWindowMs }
        : {}),
      ...(options.trustedProxies !== undefined ? { trustedProxies: options.trustedProxies } : {}),
      ...(options.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {}),
      ...(options.maxOutboundQueue !== undefined ? { maxOutboundQueue: options.maxOutboundQueue } : {}),
      ...(options.maxMessagesPerSecond !== undefined ? { maxMessagesPerSecond: options.maxMessagesPerSecond } : {}),
      ...(options.registerTimeoutMs !== undefined ? { registerTimeoutMs: options.registerTimeoutMs } : {}),
      ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    })
  }

  isListening(): boolean {
    return this.isRunning && this.server !== undefined
  }

  getBoundAddress(): { readonly host: string; readonly port: number } | undefined {
    if (!this.server || !this.isRunning) return undefined
    const addr = this.server.address() as AddressInfo | null
    if (!addr || typeof addr === 'string') return undefined
    return { host: addr.address, port: addr.port }
  }

  private formatAuthorityHost(host: string): string {
    return host.includes(':') ? `[${host}]` : host
  }

  getHttpBaseUrl(): string | undefined {
    const addr = this.getBoundAddress()
    if (!addr) return undefined
    return `http://${this.formatAuthorityHost(addr.host)}:${addr.port}`
  }

  getRelayEndpointUrl(): string | undefined {
    const addr = this.getBoundAddress()
    if (!addr) return undefined
    return `ws://${this.formatAuthorityHost(addr.host)}:${addr.port}/relay`
  }

  getSignalingEndpointUrl(): string | undefined {
    const addr = this.getBoundAddress()
    if (!addr) return undefined
    return `ws://${this.formatAuthorityHost(addr.host)}:${addr.port}/signal`
  }

  getWebAppUrl(): string | undefined {
    if (!this.canonicalWebAppRoot) return undefined
    const base = this.getHttpBaseUrl()
    return base ? `${base}/app/` : undefined
  }

  getStats(): BlindGatewayStats {
    return {
      relay: this.relay.getStats(),
      signaling: this.signaling.getStats(),
      webAppEnabled: this.canonicalWebAppRoot !== undefined,
      webAppRequests: this.webAppRequests,
      webAppRejectedRequests: this.webAppRejectedRequests,
      unknownUpgradeRequests: this.unknownUpgradeRequests,
      rejectedPerIpCap: this.rejectedPerIpCap,
      rejectedPreAuthRate: this.rejectedPreAuthRate,
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) return

    if (this.options.enabled !== true) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'blind gateway server is disabled by default; options.enabled must be explicitly true',
      )
    }

    const bindHost = this.options.host?.trim()
    if (!bindHost || isIP(bindHost) === 0) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        `blind gateway server requires explicit IP address, received '${this.options.host}'`,
      )
    }
    if (
      (bindHost === '0.0.0.0' || bindHost === '::') &&
      this.options.allowWildcardHost !== true
    ) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'wildcard binding is disabled unless allowWildcardHost is true',
      )
    }

    const bindPort = this.options.port ?? 0
    if (!Number.isInteger(bindPort) || bindPort < 0 || bindPort > 65535) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', `invalid gateway port: ${bindPort}`)
    }

    this.canonicalWebAppRoot =
      this.options.webAppDir !== undefined
        ? resolveCanonicalWebAppRoot(this.options.webAppDir)
        : undefined

    const server = createServer((req, res) => {
      if (!this.connectionGuard.handleHttpRequest(req, res)) {
        return
      }
      this.handleHttpRequest(req, res)
    })
    server.maxConnections = this.maxConnections
    server.requestTimeout = Math.max(this.registerTimeoutMs, 10_000)
    server.headersTimeout = Math.min(5_000, Math.max(this.registerTimeoutMs, 1_000))
    server.keepAliveTimeout = 5_000

    server.on('connection', (socket: Socket) => {
      this.connectionGuard.handleConnection(socket)
    })

    server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      this.connectionGuard.clearPendingTimer(socket)
      this.handleUpgrade(req, socket, head)
    })

    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(bindPort, bindHost, () => {
        server.off('error', rejectListen)
        server.on('error', () => {})
        resolveListen()
      })
    })

    this.server = server
    this.isRunning = true
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }

    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      sendJson(res, 400, { error: 'invalid request url' })
      return
    }

    if (pathname === '/healthz') {
      const payload = JSON.stringify({
        ok: true,
        mode: 'gateway',
        endpoints: {
          relay: '/relay',
          signaling: '/signal',
          app: this.canonicalWebAppRoot ? '/app/' : null,
        },
        relay: this.relay.getStats(),
        signaling: this.signaling.getStats(),
      })
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      })
      if (method === 'HEAD') {
        res.end()
      } else {
        res.end(payload)
      }
      return
    }

    if (
      pathname === '/relay' ||
      pathname === '/relay/' ||
      pathname === '/signal' ||
      pathname === '/signal/' ||
      pathname === '/signaling' ||
      pathname === '/signaling/'
    ) {
      res.writeHead(426, {
        'Content-Type': 'application/json; charset=utf-8',
        Upgrade: 'websocket',
        'X-Content-Type-Options': 'nosniff',
      })
      if (method === 'HEAD') {
        res.end()
      } else {
        res.end('{"error":"websocket upgrade required"}')
      }
      return
    }

    if (this.canonicalWebAppRoot) {
      if (pathname === '/app') {
        res.writeHead(302, {
          Location: '/app/',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        })
        res.end()
        return
      }
      if (pathname.startsWith('/app/')) {
        const subPath = pathname.slice('/app/'.length)
        const resolved = resolveSafeStaticFile(this.canonicalWebAppRoot, subPath)
        if (!resolved) {
          this.webAppRejectedRequests += 1
          sendJson(res, 404, { error: 'not found' })
          return
        }
        try {
          const content = readFileSync(resolved.path)
          this.webAppRequests += 1
          const noStore = resolved.relName === 'index.html' || resolved.relName === 'sw.js'
          res.writeHead(200, {
            ...STATIC_SECURITY_HEADERS,
            'Content-Type': resolved.mimeType,
            'Content-Length': String(content.byteLength),
            'Cache-Control': noStore ? 'no-store' : 'public, max-age=300',
          })
          if (method === 'HEAD') {
            res.end()
          } else {
            res.end(content)
          }
          return
        } catch {
          this.webAppRejectedRequests += 1
          sendJson(res, 404, { error: 'not found' })
          return
        }
      }
    }

    sendJson(res, 404, { error: 'not found' })
  }

  private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    let pathname = ''
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      this.unknownUpgradeRequests += 1
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }

    if (pathname === '/relay' || pathname === '/relay/') {
      const clientIp = this.connectionGuard.acquireUpgrade(req, socket)
      if (!clientIp) {
        return
      }
      this.relay.handleUpgradeRequest(req, socket, head, clientIp)
      return
    }
    if (
      pathname === '/signal' ||
      pathname === '/signal/' ||
      pathname === '/signaling' ||
      pathname === '/signaling/'
    ) {
      const clientIp = this.connectionGuard.acquireUpgrade(req, socket)
      if (!clientIp) {
        return
      }
      this.signaling.handleUpgradeRequest(req, socket, head, clientIp)
      return
    }

    this.unknownUpgradeRequests += 1
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
  }

  async stop(): Promise<void> {
    if (!this.isRunning && !this.server) return
    this.isRunning = false
    this.canonicalWebAppRoot = undefined

    await Promise.allSettled([this.relay.stop(), this.signaling.stop()])

    this.connectionGuard.destroyPendingAndReset()

    if (this.server) {
      const server = this.server
      this.server = undefined
      server.closeAllConnections?.()
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose())
      })
    }
  }
}
