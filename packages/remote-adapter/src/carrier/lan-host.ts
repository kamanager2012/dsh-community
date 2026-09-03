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
import { LAN_CARRIER_BOUNDS, validateLanCarrierBounds, type LanCarrierBounds } from './constants.js'
import { validateLanBindingAddress } from './address-validator.js'
import { DSH_REMOTE_SERVICE_TYPE, type MdnsAdvertiser, type MdnsAdvertisementRecord } from './mdns.js'

export interface HostLanCarrierOptions {
  /**
   * Explicitly enable the LAN carrier. Default is false (disabled by default).
   */
  readonly enabled?: boolean

  /**
   * Explicit host/interface IP to bind. Default forbids wildcard and public addresses.
   * Must be an explicit LAN/loopback IP (e.g. '127.0.0.1', '192.168.1.100', '::1').
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

  /**
   * Optional mDNS advertiser for LAN discovery hint publication.
   */
  readonly mdnsAdvertiser?: MdnsAdvertiser

  /**
   * Human-readable host display label for mDNS advertisement.
   */
  readonly hostDisplayLabel?: string

  /**
   * Testing flag to allow policy-compliant mock private IPs without binding to local OS interface.
   */
  readonly skipInterfaceCheckForTesting?: boolean
}

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

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
    // P0-5: Validate bounds on constructor/options
    this.bounds = validateLanCarrierBounds(options.bounds)
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

    // 1. Default disabled check: if explicitly enabled is false, fail closed
    if (!this.isEnabled()) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'LAN carrier is disabled by default; options.enabled must be explicitly true',
      )
    }

    // 2. Validate network binding: strictly enforces LAN/loopback policy and valid IP
    const bindHost = validateLanBindingAddress(this.options.host, {
      skipInterfaceCheckForTesting: this.options.skipInterfaceCheckForTesting,
    })
    const bindPort = this.options.port ?? 0

    if (bindPort < 0 || bindPort > 65535 || !Number.isInteger(bindPort)) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', `invalid port: ${bindPort}`)
    }

    try {
      // 3. Load host identity
      this.hostKeyPair = await this.options.hostIdentityStore.loadOrCreate()

      // 4. Create HTTP server for WebSocket upgrade
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

      // 5. P1-1: Publish mDNS advertisement lifecycle (if advertiser configured)
      if (this.options.mdnsAdvertiser) {
        const bound = this.getBoundAddress()!
        const record: MdnsAdvertisementRecord = {
          name: this.options.hostDisplayLabel ?? 'DSH Remote Host',
          type: DSH_REMOTE_SERVICE_TYPE,
          host: bound.host,
          port: bound.port,
          txt: {
            v: '1',
            fp: this.hostKeyPair.identity.fingerprint,
          },
        }
        await this.options.mdnsAdvertiser.publish(record)
      }

      // 6. P1-4: Hook active channel revocation termination ONLY after successful listen
      this.unsubscribeRevocations = this.options.trustStore.subscribeRevocations((event) => {
        this.handleRevocation(event.deviceId)
      })
    } catch (err) {
      // P1-4: Transactional startup rollback on failure
      await this.rollbackStartup()
      throw err
    }
  }

  private async rollbackStartup(): Promise<void> {
    if (this.unsubscribeRevocations) {
      try {
        this.unsubscribeRevocations()
      } catch {}
      this.unsubscribeRevocations = undefined
    }

    if (this.options.mdnsAdvertiser) {
      try {
        await this.options.mdnsAdvertiser.unpublish()
      } catch {}
    }

    if (this.server) {
      try {
        await new Promise<void>((resolve) => {
          this.server!.close(() => resolve())
        })
      } catch {}
      this.server = undefined
    }

    this.isRunning = false
  }

  private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    // Check connection cap before accepting
    if (this.activeConnections.size >= this.bounds.maxConcurrentConnections) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
      socket.destroy()
      return
    }

    const upgradeHeader = req.headers['upgrade']
    const connectionHeader = req.headers['connection']
    const wsVersion = req.headers['sec-websocket-version']
    const wsKey = req.headers['sec-websocket-key']

    // RFC 6455 4.2.1 header validation
    const hasUpgradeToken =
      typeof connectionHeader === 'string' &&
      connectionHeader
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .includes('upgrade')

    const isWsUpgrade =
      typeof upgradeHeader === 'string' && upgradeHeader.trim().toLowerCase() === 'websocket'

    if (!isWsUpgrade || !hasUpgradeToken) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }

    // RFC 6455 Version check: must be 13
    if (wsVersion !== '13') {
      socket.write('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\n\r\n')
      socket.destroy()
      return
    }

    // RFC 6455 Key validation: must decode to 16 bytes
    if (typeof wsKey !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }

    const keyBuf = Buffer.from(wsKey.trim(), 'base64')
    if (keyBuf.length !== 16 || keyBuf.toString('base64') !== wsKey.trim()) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }

    // RFC 6455 Accept calculation
    const acceptKey = createHash('sha1').update(wsKey.trim() + WS_MAGIC_GUID).digest('base64')
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
      head, // P1-3: Pass upgrade head buffer so initial frames are not lost
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
      try {
        this.unsubscribeRevocations()
      } catch {}
      this.unsubscribeRevocations = undefined
    }

    if (this.options.mdnsAdvertiser) {
      try {
        await this.options.mdnsAdvertiser.unpublish()
        await this.options.mdnsAdvertiser.destroy()
      } catch {}
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
