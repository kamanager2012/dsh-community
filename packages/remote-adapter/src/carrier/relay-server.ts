import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { isIP, type AddressInfo, type Socket } from 'node:net'
import { RemoteCryptoError } from '../crypto/errors.js'
import {
  encodeCloseFrame,
  encodeWebSocketFrame,
  parseClosePayload,
  WebSocketFrameParser,
  WebSocketOpcode,
} from './websocket-frame.js'

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const ROOM_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/
const CONN_ID_HEX_RE = /^[0-9a-f]{32}$/

export const RELAY_FRAME_DATA = 0x01
export const RELAY_FRAME_CONTROL = 0x02
export const RELAY_CONN_ID_BYTES = 16
export const RELAY_DATA_HEADER_BYTES = 1 + RELAY_CONN_ID_BYTES

export interface BlindRelayFrameObservation {
  readonly direction: 'client-to-host' | 'host-to-client'
  readonly roomId: string
  readonly connIdHex: string
  readonly payload: Uint8Array
}

export interface BlindRelayStats {
  readonly activeRooms: number
  readonly activeHostPeers: number
  readonly activeClientPeers: number
  readonly opaqueFramesRelayed: number
  readonly opaqueBytesRelayed: number
  readonly droppedRateLimited: number
  readonly droppedOversized: number
  readonly droppedBackpressure: number
  readonly rejectedUnauthorized: number
  readonly rejectedPerIpCap: number
}

export interface BlindRelayServerOptions {
  /** Explicitly enable the blind relay server. Default is false (fail closed). */
  readonly enabled?: boolean | undefined
  /** Explicit IP interface to bind. */
  readonly host: string
  /** TCP port (0 selects an ephemeral port). */
  readonly port?: number | undefined
  /** Allow binding wildcard 0.0.0.0 / :: for multi-interface hosts. */
  readonly allowWildcardHost?: boolean | undefined
  /** Optional shared secret required when registering a Host room. */
  readonly hostAuthSecret?: string | undefined
  readonly maxRooms?: number | undefined
  readonly maxClientsPerRoom?: number | undefined
  readonly maxConnections?: number | undefined
  readonly maxConnectionsPerIp?: number | undefined
  /** Maximum opaque ciphertext payload bytes per frame (default: 64 KiB). */
  readonly maxOpaquePayloadBytes?: number | undefined
  readonly maxOutboundQueue?: number | undefined
  readonly maxOutboundBytes?: number | undefined
  /** Sliding 1s frame cap per connection (default: 240). */
  readonly maxFramesPerSecond?: number | undefined
  /** Sliding 1s byte cap per connection and per room (default: 1 MiB/s). */
  readonly maxBytesPerSecond?: number | undefined
  readonly maxRoomBytesPerSecond?: number | undefined
  readonly registerTimeoutMs?: number | undefined
  readonly idleTimeoutMs?: number | undefined
  /** Optional audit hook receiving strictly blind ciphertext payloads handled by the relay. */
  readonly onBlindFrame?: ((obs: BlindRelayFrameObservation) => void) | undefined
}

interface RelayPeer {
  readonly socket: Socket
  readonly remoteIp: string
  readonly parser: WebSocketFrameParser
  role: 'unregistered' | 'host' | 'client'
  roomId: string | undefined
  connIdHex: string | undefined
  connIdBytes: Buffer | undefined
  closed: boolean
  pendingOutboundFrames: number
  pendingOutboundBytes: number
  rateWindowStartMs: number
  rateFrames: number
  rateBytes: number
  registerTimer: NodeJS.Timeout | undefined
  idleTimer: NodeJS.Timeout | undefined
}

interface RelayRoom {
  readonly roomId: string
  readonly host: RelayPeer
  readonly clientTokenDigest: Buffer | undefined
  readonly clientsByHex: Map<string, RelayPeer>
  roomRateWindowStartMs: number
  roomRateBytes: number
}

function sha256Digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function constantTimeDigestEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

function normalizeRemoteIp(address: string | undefined): string {
  if (!address) return 'unknown'
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

/**
 * Community-owned zero-trust blind WebSocket relay.
 *
 * Host peers multiplex per-client opaque frames as [0x01][16B connId][ciphertext]
 * and relay control events as [0x02][JSON]. Joined client sockets operate in pure
 * opaque binary mode so relay infrastructure sees only ciphertext and never parses,
 * decrypts, stores, or terminates E2EE application traffic.
 */
export class BlindRelayServer {
  private readonly options: BlindRelayServerOptions
  private readonly maxRooms: number
  private readonly maxClientsPerRoom: number
  private readonly maxConnections: number
  private readonly maxConnectionsPerIp: number
  private readonly maxOpaquePayloadBytes: number
  private readonly maxTransportFrameBytes: number
  private readonly maxOutboundQueue: number
  private readonly maxOutboundBytes: number
  private readonly maxFramesPerSecond: number
  private readonly maxBytesPerSecond: number
  private readonly maxRoomBytesPerSecond: number
  private readonly registerTimeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly hostAuthDigest: Buffer | undefined

  private server: Server | undefined = undefined
  private isRunning = false
  private readonly socketIps = new Map<Socket, string>()
  private readonly connectionsPerIp = new Map<string, number>()
  private readonly preUpgradeSockets = new Map<Socket, NodeJS.Timeout>()
  private readonly peers = new Set<RelayPeer>()
  private readonly rooms = new Map<string, RelayRoom>()

  private opaqueFramesRelayed = 0
  private opaqueBytesRelayed = 0
  private droppedRateLimited = 0
  private droppedOversized = 0
  private droppedBackpressure = 0
  private rejectedUnauthorized = 0
  private rejectedPerIpCap = 0

  constructor(options: BlindRelayServerOptions) {
    this.options = options
    this.maxRooms = options.maxRooms ?? 64
    this.maxClientsPerRoom = options.maxClientsPerRoom ?? 8
    this.maxConnections = options.maxConnections ?? 128
    this.maxConnectionsPerIp = options.maxConnectionsPerIp ?? 16
    this.maxOpaquePayloadBytes = options.maxOpaquePayloadBytes ?? 64 * 1024
    this.maxTransportFrameBytes = this.maxOpaquePayloadBytes + RELAY_DATA_HEADER_BYTES
    this.maxOutboundQueue = options.maxOutboundQueue ?? 32
    this.maxOutboundBytes = options.maxOutboundBytes ?? 512 * 1024
    this.maxFramesPerSecond = options.maxFramesPerSecond ?? 240
    this.maxBytesPerSecond = options.maxBytesPerSecond ?? 1024 * 1024
    this.maxRoomBytesPerSecond = options.maxRoomBytesPerSecond ?? 2 * 1024 * 1024
    this.registerTimeoutMs = options.registerTimeoutMs ?? 5_000
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000
    this.hostAuthDigest =
      options.hostAuthSecret !== undefined && options.hostAuthSecret.length > 0
        ? sha256Digest(options.hostAuthSecret)
        : undefined
  }

  isListening(): boolean {
    return this.isRunning && this.server !== undefined
  }

  getBoundAddress(): { host: string; port: number } | undefined {
    if (!this.server || !this.isRunning) return undefined
    const addr = this.server.address() as AddressInfo | null
    if (!addr) return undefined
    return { host: addr.address, port: addr.port }
  }

  getEndpointUrl(): string | undefined {
    const addr = this.getBoundAddress()
    if (!addr) return undefined
    const hostPart = addr.host.includes(':') ? `[${addr.host}]` : addr.host
    return `ws://${hostPart}:${addr.port}`
  }

  getStats(): BlindRelayStats {
    let activeHostPeers = 0
    let activeClientPeers = 0
    for (const peer of this.peers) {
      if (peer.role === 'host') activeHostPeers += 1
      else if (peer.role === 'client') activeClientPeers += 1
    }
    return {
      activeRooms: this.rooms.size,
      activeHostPeers,
      activeClientPeers,
      opaqueFramesRelayed: this.opaqueFramesRelayed,
      opaqueBytesRelayed: this.opaqueBytesRelayed,
      droppedRateLimited: this.droppedRateLimited,
      droppedOversized: this.droppedOversized,
      droppedBackpressure: this.droppedBackpressure,
      rejectedUnauthorized: this.rejectedUnauthorized,
      rejectedPerIpCap: this.rejectedPerIpCap,
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) return

    if (this.options.enabled !== true) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'blind relay server is disabled by default; options.enabled must be explicitly true',
      )
    }

    const bindHost = this.options.host?.trim()
    if (!bindHost || isIP(bindHost) === 0) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        `blind relay server requires explicit IP address, received '${this.options.host}'`,
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
      throw new RemoteCryptoError('HANDSHAKE_FAILED', `invalid relay port: ${bindPort}`)
    }

    const server = createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    })

    server.on('connection', (socket: Socket) => {
      const ip = normalizeRemoteIp(socket.remoteAddress)
      const ipCount = this.connectionsPerIp.get(ip) ?? 0
      if (ipCount >= this.maxConnectionsPerIp) {
        this.rejectedPerIpCap += 1
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
        socket.destroy()
        return
      }
      if (this.preUpgradeSockets.size + this.peers.size >= this.maxConnections) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
        socket.destroy()
        return
      }

      this.socketIps.set(socket, ip)
      this.connectionsPerIp.set(ip, ipCount + 1)

      const preTimer = setTimeout(() => {
        this.preUpgradeSockets.delete(socket)
        socket.destroy()
      }, this.registerTimeoutMs)
      this.preUpgradeSockets.set(socket, preTimer)

      socket.once('close', () => {
        const timer = this.preUpgradeSockets.get(socket)
        if (timer) {
          clearTimeout(timer)
          this.preUpgradeSockets.delete(socket)
        }
        const trackedIp = this.socketIps.get(socket)
        if (trackedIp !== undefined) {
          this.socketIps.delete(socket)
          const remaining = (this.connectionsPerIp.get(trackedIp) ?? 1) - 1
          if (remaining <= 0) {
            this.connectionsPerIp.delete(trackedIp)
          } else {
            this.connectionsPerIp.set(trackedIp, remaining)
          }
        }
      })
      socket.once('error', () => {})
    })

    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as Socket, head)
    })

    server.headersTimeout = Math.min(server.headersTimeout, Math.max(this.registerTimeoutMs, 5_000))
    server.requestTimeout = Math.max(this.registerTimeoutMs, 10_000)

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(bindPort, bindHost, () => {
        server.removeListener('error', reject)
        server.on('error', () => {})
        resolve()
      })
    })

    this.server = server
    this.isRunning = true
  }

  private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const preTimer = this.preUpgradeSockets.get(socket)
    if (preTimer) {
      clearTimeout(preTimer)
      this.preUpgradeSockets.delete(socket)
    }

    if (this.peers.size >= this.maxConnections) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
      socket.destroy()
      return
    }

    const upgrade = req.headers['upgrade']
    const connection = req.headers['connection']
    const version = req.headers['sec-websocket-version']
    const wsKey = req.headers['sec-websocket-key']

    const hasUpgradeToken =
      typeof connection === 'string' &&
      connection
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .includes('upgrade')

    if (
      typeof upgrade !== 'string' ||
      upgrade.trim().toLowerCase() !== 'websocket' ||
      !hasUpgradeToken ||
      version !== '13' ||
      typeof wsKey !== 'string'
    ) {
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

    const acceptKey = createHash('sha1')
      .update(wsKey.trim() + WS_MAGIC_GUID)
      .digest('base64')
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '\r\n',
      ].join('\r\n'),
    )

    const remoteIp = this.socketIps.get(socket) ?? normalizeRemoteIp(socket.remoteAddress)
    let peer!: RelayPeer
    const parser = new WebSocketFrameParser(this.maxTransportFrameBytes, true, {
      onFrame: (frame) => {
        if (peer.closed) return
        if (frame.opcode === WebSocketOpcode.PING) {
          if (!this.consumeConnectionBudget(peer, frame.payload.byteLength)) {
            return
          }
          this.resetIdleTimer(peer)
          this.sendRawWs(peer, WebSocketOpcode.PONG, frame.payload)
          return
        }
        if (frame.opcode === WebSocketOpcode.PONG) {
          if (!this.consumeConnectionBudget(peer, frame.payload.byteLength)) {
            return
          }
          this.resetIdleTimer(peer)
          return
        }
        if (frame.opcode === WebSocketOpcode.CLOSE) {
          const parsedClose = parseClosePayload(frame.payload)
          this.terminatePeer(peer, parsedClose.code, parsedClose.reason)
          return
        }
        this.resetIdleTimer(peer)
        const buf = Buffer.from(
          frame.payload.buffer,
          frame.payload.byteOffset,
          frame.payload.byteLength,
        )
        this.handlePeerFrame(peer, frame.opcode, buf)
      },
      onTextFrameRejected: () => {
        this.rejectedUnauthorized += 1
        this.terminatePeer(peer, 1003, 'binary WebSocket frames required')
      },
      onOversizedFrame: () => {
        this.droppedOversized += 1
        this.terminatePeer(peer, 1009, 'relay transport frame exceeds limit')
      },
      onProtocolError: (reason) => {
        this.terminatePeer(peer, 1002, reason)
      },
    })

    peer = {
      socket,
      remoteIp,
      parser,
      role: 'unregistered',
      roomId: undefined,
      connIdHex: undefined,
      connIdBytes: undefined,
      closed: false,
      pendingOutboundFrames: 0,
      pendingOutboundBytes: 0,
      rateWindowStartMs: Date.now(),
      rateFrames: 0,
      rateBytes: 0,
      registerTimer: undefined,
      idleTimer: undefined,
    }
    this.peers.add(peer)

    peer.registerTimer = setTimeout(() => {
      if (!peer.closed && peer.role === 'unregistered') {
        this.rejectedUnauthorized += 1
        this.terminatePeer(peer, 1008, 'relay registration timeout')
      }
    }, this.registerTimeoutMs)
    this.resetIdleTimer(peer)

    socket.on('data', (chunk: Buffer) => {
      if (!peer.closed) {
        parser.push(chunk)
      }
    })
    socket.on('close', () => this.cleanupPeer(peer))
    socket.on('error', () => this.cleanupPeer(peer))

    if (head.length > 0) {
      parser.push(head)
    }
  }

  private resetIdleTimer(peer: RelayPeer): void {
    if (peer.idleTimer) {
      clearTimeout(peer.idleTimer)
    }
    peer.idleTimer = setTimeout(() => {
      if (!peer.closed) {
        this.terminatePeer(peer, 1000, 'relay idle timeout')
      }
    }, this.idleTimeoutMs)
  }

  private consumeConnectionBudget(peer: RelayPeer, payloadBytes: number): boolean {
    const now = Date.now()
    if (now - peer.rateWindowStartMs >= 1_000) {
      peer.rateWindowStartMs = now
      peer.rateFrames = 0
      peer.rateBytes = 0
    }
    peer.rateFrames += 1
    peer.rateBytes += payloadBytes
    if (peer.rateFrames > this.maxFramesPerSecond || peer.rateBytes > this.maxBytesPerSecond) {
      this.droppedRateLimited += 1
      this.terminatePeer(peer, 1008, 'relay connection rate limit exceeded')
      return false
    }
    return true
  }

  private consumeRoomBudget(room: RelayRoom, payloadBytes: number): boolean {
    const now = Date.now()
    if (now - room.roomRateWindowStartMs >= 1_000) {
      room.roomRateWindowStartMs = now
      room.roomRateBytes = 0
    }
    room.roomRateBytes += payloadBytes
    if (room.roomRateBytes > this.maxRoomBytesPerSecond) {
      this.droppedRateLimited += 1
      return false
    }
    return true
  }

  private sendRawWs(peer: RelayPeer, opcode: WebSocketOpcode, payload: Uint8Array): boolean {
    if (peer.closed || peer.socket.destroyed) return false
    if (
      peer.pendingOutboundFrames >= this.maxOutboundQueue ||
      peer.pendingOutboundBytes + payload.byteLength > this.maxOutboundBytes
    ) {
      this.droppedBackpressure += 1
      this.terminatePeer(peer, 1008, 'relay outbound queue limit exceeded')
      return false
    }

    peer.pendingOutboundFrames += 1
    peer.pendingOutboundBytes += payload.byteLength
    const frame = encodeWebSocketFrame(payload, opcode)
    try {
      peer.socket.write(frame, () => {
        peer.pendingOutboundFrames = Math.max(0, peer.pendingOutboundFrames - 1)
        peer.pendingOutboundBytes = Math.max(0, peer.pendingOutboundBytes - payload.byteLength)
      })
      return true
    } catch {
      this.cleanupPeer(peer)
      return false
    }
  }

  private sendJsonControl(peer: RelayPeer, payload: Record<string, unknown>, binaryTag = false): void {
    const jsonBytes = Buffer.from(JSON.stringify(payload), 'utf8')
    if (binaryTag) {
      const framed = Buffer.allocUnsafe(1 + jsonBytes.length)
      framed[0] = RELAY_FRAME_CONTROL
      jsonBytes.copy(framed, 1)
      this.sendRawWs(peer, WebSocketOpcode.BINARY, framed)
    } else {
      this.sendRawWs(peer, WebSocketOpcode.BINARY, jsonBytes)
    }
  }

  private sendError(peer: RelayPeer, code: string, message: string, binaryTag = false): void {
    this.sendJsonControl(peer, { v: 1, type: 'error', code, message }, binaryTag)
  }

  private handlePeerFrame(peer: RelayPeer, opcode: WebSocketOpcode, payload: Buffer): void {
    if (!this.consumeConnectionBudget(peer, payload.byteLength)) {
      return
    }

    if (peer.role === 'client') {
      if (opcode !== WebSocketOpcode.BINARY) {
        this.rejectedUnauthorized += 1
        this.terminatePeer(peer, 1003, 'relay blind client accepts binary ciphertext only')
        return
      }
      if (payload.byteLength > this.maxOpaquePayloadBytes) {
        this.droppedOversized += 1
        this.terminatePeer(peer, 1009, 'relay opaque frame exceeds limit')
        return
      }
      this.forwardClientOpaqueToHost(peer, payload)
      return
    }

    if (peer.role === 'host') {
      if (opcode !== WebSocketOpcode.BINARY || payload.byteLength < 1) {
        this.terminatePeer(peer, 1003, 'relay host requires tagged binary frames')
        return
      }
      const tag = payload[0]
      if (tag === RELAY_FRAME_DATA) {
        if (payload.byteLength < RELAY_DATA_HEADER_BYTES) {
          this.terminatePeer(peer, 1002, 'malformed relay data frame header')
          return
        }
        const opaquePayload = payload.subarray(RELAY_DATA_HEADER_BYTES)
        if (opaquePayload.byteLength > this.maxOpaquePayloadBytes) {
          this.droppedOversized += 1
          this.terminatePeer(peer, 1009, 'relay opaque payload exceeds limit')
          return
        }
        const connIdHex = payload.subarray(1, RELAY_DATA_HEADER_BYTES).toString('hex')
        this.forwardHostOpaqueToClient(peer, connIdHex, opaquePayload)
        return
      }
      if (tag === RELAY_FRAME_CONTROL) {
        this.handleHostControl(peer, payload.subarray(1))
        return
      }
      this.terminatePeer(peer, 1002, 'unknown relay host frame tag')
      return
    }

    // Unregistered registration/join handshake
    if (opcode !== WebSocketOpcode.TEXT && opcode !== WebSocketOpcode.BINARY) {
      this.terminatePeer(peer, 1003, 'unexpected opcode during registration')
      return
    }
    this.handleRegistrationFrame(peer, payload)
  }

  private handleRegistrationFrame(peer: RelayPeer, payload: Buffer): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload.toString('utf8'))
    } catch {
      this.rejectedUnauthorized += 1
      this.terminatePeer(peer, 1002, 'invalid relay registration JSON')
      return
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.rejectedUnauthorized += 1
      this.terminatePeer(peer, 1002, 'relay registration must be a JSON object')
      return
    }

    const msg = parsed as Record<string, unknown>
    if (msg.v !== 1 || typeof msg.type !== 'string') {
      this.rejectedUnauthorized += 1
      this.terminatePeer(peer, 1002, 'unsupported relay protocol version')
      return
    }

    if (msg.type === 'relay.host.register') {
      this.handleHostRegister(peer, msg)
      return
    }
    if (msg.type === 'relay.client.join') {
      this.handleClientJoin(peer, msg)
      return
    }

    this.rejectedUnauthorized += 1
    this.terminatePeer(peer, 1008, 'peer must register before relaying')
  }

  private handleHostRegister(peer: RelayPeer, msg: Record<string, unknown>): void {
    const roomId = typeof msg.roomId === 'string' ? msg.roomId : ''
    if (!ROOM_ID_RE.test(roomId)) {
      this.rejectedUnauthorized += 1
      this.sendError(peer, 'INVALID_ROOM', 'invalid roomId')
      this.terminatePeer(peer, 1008, 'invalid roomId')
      return
    }

    if (this.hostAuthDigest) {
      const provided = typeof msg.hostAuthSecret === 'string' ? msg.hostAuthSecret : ''
      if (
        provided.length === 0 ||
        !constantTimeDigestEquals(sha256Digest(provided), this.hostAuthDigest)
      ) {
        this.rejectedUnauthorized += 1
        this.sendError(peer, 'AUTH_FAILED', 'host authentication failed')
        this.terminatePeer(peer, 1008, 'host authentication failed')
        return
      }
    }

    if (this.rooms.has(roomId)) {
      this.rejectedUnauthorized += 1
      this.sendError(peer, 'ROOM_OCCUPIED', 'room already has an active host')
      this.terminatePeer(peer, 1008, 'room occupied')
      return
    }

    if (this.rooms.size >= this.maxRooms) {
      this.sendError(peer, 'RELAY_CAPACITY', 'relay room capacity exceeded')
      this.terminatePeer(peer, 1013, 'relay room capacity exceeded')
      return
    }

    const clientToken = typeof msg.clientToken === 'string' ? msg.clientToken : ''
    const room: RelayRoom = {
      roomId,
      host: peer,
      clientTokenDigest: clientToken.length > 0 ? sha256Digest(clientToken) : undefined,
      clientsByHex: new Map(),
      roomRateWindowStartMs: Date.now(),
      roomRateBytes: 0,
    }
    this.rooms.set(roomId, room)

    peer.role = 'host'
    peer.roomId = roomId
    if (peer.registerTimer) {
      clearTimeout(peer.registerTimer)
      peer.registerTimer = undefined
    }

    this.sendJsonControl(peer, { v: 1, type: 'relay.host.registered', roomId }, true)
  }

  private handleClientJoin(peer: RelayPeer, msg: Record<string, unknown>): void {
    const roomId = typeof msg.roomId === 'string' ? msg.roomId : ''
    if (!ROOM_ID_RE.test(roomId)) {
      this.rejectedUnauthorized += 1
      this.sendError(peer, 'INVALID_ROOM', 'invalid roomId')
      this.terminatePeer(peer, 1008, 'invalid roomId')
      return
    }

    const room = this.rooms.get(roomId)
    if (!room || room.host.closed) {
      this.sendError(peer, 'ROOM_UNKNOWN', 'relay room does not exist')
      this.terminatePeer(peer, 1008, 'unknown room')
      return
    }

    if (room.clientTokenDigest) {
      const provided = typeof msg.clientToken === 'string' ? msg.clientToken : ''
      if (
        provided.length === 0 ||
        !constantTimeDigestEquals(sha256Digest(provided), room.clientTokenDigest)
      ) {
        this.rejectedUnauthorized += 1
        this.sendError(peer, 'AUTH_FAILED', 'invalid client relay token')
        this.terminatePeer(peer, 1008, 'invalid client relay token')
        return
      }
    }

    if (room.clientsByHex.size >= this.maxClientsPerRoom) {
      this.sendError(peer, 'ROOM_FULL', 'relay room client limit exceeded')
      this.terminatePeer(peer, 1013, 'room full')
      return
    }

    const connIdBytes = randomBytes(RELAY_CONN_ID_BYTES)
    const connIdHex = connIdBytes.toString('hex')
    peer.role = 'client'
    peer.roomId = roomId
    peer.connIdHex = connIdHex
    peer.connIdBytes = connIdBytes
    if (peer.registerTimer) {
      clearTimeout(peer.registerTimer)
      peer.registerTimer = undefined
    }
    room.clientsByHex.set(connIdHex, peer)

    this.sendJsonControl(
      room.host,
      { v: 1, type: 'relay.peer.joined', roomId, connIdHex },
      true,
    )
    this.sendJsonControl(peer, { v: 1, type: 'relay.client.joined', roomId, connIdHex }, false)
  }

  private forwardClientOpaqueToHost(client: RelayPeer, opaquePayload: Buffer): void {
    if (!client.roomId || !client.connIdBytes || !client.connIdHex) return
    const room = this.rooms.get(client.roomId)
    if (!room || room.host.closed) {
      this.terminatePeer(client, 1001, 'relay host offline')
      return
    }
    if (!this.consumeRoomBudget(room, opaquePayload.byteLength)) {
      return
    }

    const wrapped = Buffer.allocUnsafe(RELAY_DATA_HEADER_BYTES + opaquePayload.byteLength)
    wrapped[0] = RELAY_FRAME_DATA
    client.connIdBytes.copy(wrapped, 1)
    opaquePayload.copy(wrapped, RELAY_DATA_HEADER_BYTES)

    this.opaqueFramesRelayed += 1
    this.opaqueBytesRelayed += opaquePayload.byteLength
    this.options.onBlindFrame?.({
      direction: 'client-to-host',
      roomId: room.roomId,
      connIdHex: client.connIdHex,
      payload: Buffer.from(opaquePayload),
    })

    this.sendRawWs(room.host, WebSocketOpcode.BINARY, wrapped)
  }

  private forwardHostOpaqueToClient(
    host: RelayPeer,
    connIdHex: string,
    opaquePayload: Buffer,
  ): void {
    if (!host.roomId) return
    const room = this.rooms.get(host.roomId)
    if (!room || room.host !== host) return
    const client = room.clientsByHex.get(connIdHex)
    if (!client || client.closed) return
    if (!this.consumeRoomBudget(room, opaquePayload.byteLength)) {
      return
    }

    this.opaqueFramesRelayed += 1
    this.opaqueBytesRelayed += opaquePayload.byteLength
    this.options.onBlindFrame?.({
      direction: 'host-to-client',
      roomId: room.roomId,
      connIdHex,
      payload: Buffer.from(opaquePayload),
    })

    this.sendRawWs(client, WebSocketOpcode.BINARY, opaquePayload)
  }

  private handleHostControl(host: RelayPeer, controlBytes: Buffer): void {
    if (!host.roomId) return
    const room = this.rooms.get(host.roomId)
    if (!room || room.host !== host) return

    let msg: Record<string, unknown>
    try {
      const parsed = JSON.parse(controlBytes.toString('utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
      msg = parsed as Record<string, unknown>
    } catch {
      return
    }

    if (msg.v !== 1) return

    if (msg.type === 'relay.ping') {
      this.sendJsonControl(
        host,
        {
          v: 1,
          type: 'relay.pong',
          ...(typeof msg.ts === 'number' && Number.isFinite(msg.ts) ? { ts: msg.ts } : {}),
        },
        true,
      )
      return
    }

    if (
      msg.type === 'relay.peer.kick' &&
      typeof msg.connIdHex === 'string' &&
      CONN_ID_HEX_RE.test(msg.connIdHex)
    ) {
      const target = room.clientsByHex.get(msg.connIdHex)
      if (target) {
        this.terminatePeer(target, 1008, 'kicked by host')
      }
    }
  }

  private cleanupPeer(peer: RelayPeer): void {
    if (peer.closed) return
    peer.closed = true
    if (peer.registerTimer) {
      clearTimeout(peer.registerTimer)
      peer.registerTimer = undefined
    }
    if (peer.idleTimer) {
      clearTimeout(peer.idleTimer)
      peer.idleTimer = undefined
    }
    this.peers.delete(peer)

    if (!peer.roomId) return
    const room = this.rooms.get(peer.roomId)
    if (!room) return

    if (peer.role === 'host' && room.host === peer) {
      this.rooms.delete(peer.roomId)
      for (const client of Array.from(room.clientsByHex.values())) {
        this.terminatePeer(client, 1001, 'relay host disconnected')
      }
      room.clientsByHex.clear()
      return
    }

    if (peer.role === 'client' && peer.connIdHex) {
      room.clientsByHex.delete(peer.connIdHex)
      if (!room.host.closed) {
        this.sendJsonControl(
          room.host,
          { v: 1, type: 'relay.peer.left', roomId: room.roomId, connIdHex: peer.connIdHex },
          true,
        )
      }
    }
  }

  private terminatePeer(peer: RelayPeer, code: number, reason: string): void {
    const wasClosed = peer.closed
    this.cleanupPeer(peer)
    if (!wasClosed && !peer.socket.destroyed) {
      const closeFrame = encodeCloseFrame(code, reason)
      const forceTimer = setTimeout(() => {
        if (!peer.socket.destroyed) peer.socket.destroy()
      }, 100)
      forceTimer.unref?.()
      try {
        if (peer.socket.writable) {
          peer.socket.end(closeFrame, () => {
            clearTimeout(forceTimer)
            if (!peer.socket.destroyed) peer.socket.destroy()
          })
          return
        }
      } catch {}
      clearTimeout(forceTimer)
      peer.socket.destroy()
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning && !this.server) return
    this.isRunning = false

    for (const [socket, timer] of this.preUpgradeSockets.entries()) {
      clearTimeout(timer)
      this.preUpgradeSockets.delete(socket)
      socket.destroy()
    }
    for (const peer of Array.from(this.peers)) {
      this.terminatePeer(peer, 1001, 'relay server shutting down')
    }
    this.rooms.clear()

    const server = this.server
    this.server = undefined
    if (server) {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }
  }
}
