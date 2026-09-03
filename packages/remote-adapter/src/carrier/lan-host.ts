import { createServer, type Server, type IncomingMessage } from 'node:http'
import type { Socket, AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { RemoteCryptoError } from '../crypto/errors.js'
import { ConnectionEpochAllocator } from '../crypto/epoch.js'
import type { DeviceTrustStore } from '../crypto/device-trust.js'
import type { HostIdentityStore, HostKeyPair } from '../crypto/host-identity.js'
import type { PairingCoordinator } from '../crypto/pairing-coordinator.js'
import type { PairingTokenRegistry } from '../crypto/pairing-token.js'
import type { RemoteAdapterCore } from '../core.js'
import { LanConnection } from './lan-connection.js'
import { LAN_CARRIER_BOUNDS, type LanCarrierBounds } from './constants.js'

export interface HostLanCarrierOptions {
  /**
   * Explicitly enable the LAN carrier. Default is false (disabled by default).
   */
  readonly enabled?: boolean

  /**
   * Explicit host/interface IP to bind. Default forbids wildcard.
   * Must be an explicit IP (e.g. '127.0.0.1', '192.168.1.100', '::1').
   * '0.0.0.0' or '::' or empty is strictly rejected fail-closed.
   */
  readonly host?: string

  /**
   * Port to bind. 0 selects a random available port.
   */
  readonly port?: number

  readonly core: RemoteAdapterCore
  readonly trustStore: DeviceTrustStore
  readonly hostIdentityStore: HostIdentityStore
  readonly pairingCoordinator?: PairingCoordinator
  readonly pairingTokenRegistry?: PairingTokenRegistry
  readonly bounds?: Partial<LanCarrierBounds>
}

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function assertValidHostBinding(host: string | undefined): string {
  if (!host || host.trim().length === 0) {
    throw new RemoteCryptoError(
      'HANDSHAKE_FAILED',
      'host binding address must be explicitly provided; wildcard default is forbidden',
    )
  }

  const trimmed = host.trim().toLowerCase()
  if (
    trimmed === '0.0.0.0' ||
    trimmed === '::' ||
    trimmed === '0:0:0:0:0:0:0:0' ||
    trimmed === '*' ||
    trimmed === 'all'
  ) {
    throw new RemoteCryptoError(
      'HANDSHAKE_FAILED',
      `binding to wildcard or public default address '${host}' is strictly forbidden`,
    )
  }

  return trimmed
}

export class HostLanCarrier {
  private readonly options: HostLanCarrierOptions
  private readonly bounds: LanCarrierBounds
  private server: Server | undefined = undefined
  private isRunning = false
  private hostKeyPair: HostKeyPair | undefined = undefined
  private readonly epochAllocator = new ConnectionEpochAllocator()
  private readonly activeConnections = new Map<string, LanConnection>()
  private readonly deviceConnections = new Map<string, Set<LanConnection>>()
  private unsubscribeRevocations: (() => void) | undefined = undefined

  constructor(options: HostLanCarrierOptions) {
    this.options = options
    this.bounds = Object.freeze({
      ...LAN_CARRIER_BOUNDS,
      ...(options.bounds ?? {}),
    })
  }

  isEnabled(): boolean {
    return this.options.enabled === true
  }

  isListening(): boolean {
    return this.isRunning && this.server !== undefined
  }

  getActiveConnectionCount(): number {
    return this.activeConnections.size
  }

  getBoundAddress(): { host: string; port: number } | undefined {
    if (!this.server || !this.isRunning) return undefined
    const addr = this.server.address() as AddressInfo | null
    if (!addr) return undefined
    return {
      host: addr.address,
      port: addr.port,
    }
  }

  getEndpointUrl(): string | undefined {
    const addr = this.getBoundAddress()
    if (!addr) return undefined
    const hostPart = addr.host.includes(':') ? `[${addr.host}]` : addr.host
    return `ws://${hostPart}:${addr.port}`
  }

  async start(): Promise<void> {
    if (this.isRunning) return

    // 1. Default disabled check: if explicitly enabled is false and start called without enabled: true
    if (!this.isEnabled()) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'LAN carrier is disabled by default; options.enabled must be explicitly true',
      )
    }

    // 2. Validate network binding: strictly forbids 0.0.0.0 and wildcard
    const bindHost = assertValidHostBinding(this.options.host)
    const bindPort = this.options.port ?? 0

    if (bindPort < 0 || bindPort > 65535 || !Number.isInteger(bindPort)) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', `invalid port: ${bindPort}`)
    }

    // 3. Load host identity
    this.hostKeyPair = await this.options.hostIdentityStore.loadOrCreate()

    // 4. Hook active channel revocation termination
    this.unsubscribeRevocations = this.options.trustStore.subscribeRevocations((event) => {
      this.handleRevocation(event.deviceId)
    })

    // 5. Create HTTP server for WebSocket upgrade
    const server = createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    })

    server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      this.handleUpgrade(req, socket, head)
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(bindPort, bindHost, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })

    this.server = server
    this.isRunning = true
  }

  private handleUpgrade(req: IncomingMessage, socket: Socket, _head: Buffer): void {
    // Check connection cap before accepting
    if (this.activeConnections.size >= this.bounds.maxConcurrentConnections) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
      socket.destroy()
      return
    }

    const upgradeHeader = req.headers['upgrade']
    const wsKey = req.headers['sec-websocket-key']

    if (
      !upgradeHeader ||
      typeof upgradeHeader !== 'string' ||
      upgradeHeader.toLowerCase() !== 'websocket' ||
      !wsKey ||
      typeof wsKey !== 'string'
    ) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }

    // RFC 6455 Accept response
    const acceptKey = createHash('sha1').update(wsKey + WS_MAGIC_GUID).digest('base64')
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n',
    ]

    socket.write(responseHeaders.join('\r\n'))

    const connId = randomBytes(16).toString('hex')
    const conn = new LanConnection(
      socket,
      {
        core: this.options.core,
        trustStore: this.options.trustStore,
        hostIdentityStore: this.options.hostIdentityStore,
        hostKeyPair: this.hostKeyPair!,
        epochAllocator: this.epochAllocator,
        pairingCoordinator: this.options.pairingCoordinator,
        bounds: this.bounds,
        onPeerAuthenticated: (peer, authenticatedConn) => {
          let set = this.deviceConnections.get(peer.deviceId)
          if (!set) {
            set = new Set()
            this.deviceConnections.set(peer.deviceId, set)
          }
          set.add(authenticatedConn)
        },
        onClosed: (closedConn) => this.removeConnection(closedConn),
      },
      connId,
    )

    this.activeConnections.set(connId, conn)
  }

  private handleRevocation(deviceId: string): void {
    const conns = this.deviceConnections.get(deviceId)
    if (!conns) return

    for (const conn of Array.from(conns)) {
      try {
        conn.terminate(1008, 'device revoked')
      } catch {
        // Fault isolation: one connection error does not stop others
      }
    }
    this.deviceConnections.delete(deviceId)
  }

  private removeConnection(conn: LanConnection): void {
    this.activeConnections.delete(conn.id)
    const peer = conn.getPeer()
    if (peer) {
      const set = this.deviceConnections.get(peer.deviceId)
      if (set) {
        set.delete(conn)
        if (set.size === 0) {
          this.deviceConnections.delete(peer.deviceId)
        }
      }
    }
  }

  broadcastEvent(event: unknown): void {
    for (const conn of this.activeConnections.values()) {
      if (conn.getState() === 'ACTIVE') {
        try {
          conn.sendEvent(event)
        } catch {
          // Fault isolation
        }
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return
    this.isRunning = false

    if (this.unsubscribeRevocations) {
      this.unsubscribeRevocations()
      this.unsubscribeRevocations = undefined
    }

    // Close all active connections
    for (const conn of Array.from(this.activeConnections.values())) {
      try {
        conn.terminate(1001, 'host shutting down')
      } catch {}
    }
    this.activeConnections.clear()
    this.deviceConnections.clear()

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
      this.server = undefined
    }
  }
}
