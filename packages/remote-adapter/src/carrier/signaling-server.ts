import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { isIP, type AddressInfo, type Socket } from 'node:net'
import { RemoteCryptoError } from '../crypto/errors.js'
import {
  encodeCloseFrame,
  encodeWebSocketFrame,
  WebSocketFrameParser,
  WebSocketOpcode,
  type WebSocketFrame,
} from './websocket-frame.js'

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export interface RtcSessionDescriptionPayload {
  readonly type: 'offer' | 'answer'
  readonly sdp: string
}

export interface RtcIceCandidatePayload {
  readonly candidate: string
  readonly sdpMid?: string | undefined
  readonly sdpMLineIndex?: number | undefined
  readonly usernameFragment?: string | undefined
}

export interface SignalingStats {
  readonly activeRooms: number
  readonly activePeers: number
  readonly relayedMessages: number
  readonly rejectedMessages: number
}

export interface SelfHostedSignalingServerOptions {
  /** Explicitly enable the signaling server. Default is false (fail closed). */
  readonly enabled?: boolean | undefined
  /** Explicit IP interface to bind. */
  readonly host: string
  /** TCP port (0 selects an ephemeral port). */
  readonly port?: number | undefined
  /** Allow binding wildcard 0.0.0.0 / :: for multi-interface container/router hosts. */
  readonly allowWildcardHost?: boolean | undefined
  /** Optional shared secret required when registering a Host room. */
  readonly hostAuthSecret?: string | undefined
  readonly maxRooms?: number | undefined
  readonly maxPeersPerRoom?: number | undefined
  readonly maxConnections?: number | undefined
  readonly maxFrameBytes?: number | undefined
  readonly maxOutboundQueue?: number | undefined
  readonly maxMessagesPerSecond?: number | undefined
  readonly registerTimeoutMs?: number | undefined
  readonly idleTimeoutMs?: number | undefined
}

interface SignalingPeer {
  readonly id: string
  readonly socket: Socket
  readonly parser: WebSocketFrameParser
  role: 'unregistered' | 'host' | 'client'
  roomId: string | undefined
  closed: boolean
  pendingOutboundFrames: number
  rateWindowStartMs: number
  rateCount: number
  registerTimer: NodeJS.Timeout | undefined
  idleTimer: NodeJS.Timeout | undefined
}

interface SignalingRoom {
  readonly roomId: string
  readonly host: SignalingPeer
  readonly joinTokenDigest: Buffer | undefined
  readonly clients: Map<string, SignalingPeer>
}

function sha256Digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function constantTimeDigestEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

function sanitizeSdp(raw: unknown): RtcSessionDescriptionPayload | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  if ((obj.type !== 'offer' && obj.type !== 'answer') || typeof obj.sdp !== 'string') {
    return undefined
  }
  if (obj.sdp.length === 0 || obj.sdp.length > 28_000) return undefined
  return { type: obj.type, sdp: obj.sdp }
}

function sanitizeCandidate(raw: unknown): RtcIceCandidatePayload | null | undefined {
  if (raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  if (typeof obj.candidate !== 'string' || obj.candidate.length > 4096) return undefined
  const out: {
    candidate: string
    sdpMid?: string
    sdpMLineIndex?: number
    usernameFragment?: string
  } = { candidate: obj.candidate }
  if (typeof obj.sdpMid === 'string' && obj.sdpMid.length <= 128) {
    out.sdpMid = obj.sdpMid
  }
  if (
    typeof obj.sdpMLineIndex === 'number' &&
    Number.isSafeInteger(obj.sdpMLineIndex) &&
    obj.sdpMLineIndex >= 0 &&
    obj.sdpMLineIndex <= 1024
  ) {
    out.sdpMLineIndex = obj.sdpMLineIndex
  }
  if (typeof obj.usernameFragment === 'string' && obj.usernameFragment.length <= 256) {
    out.usernameFragment = obj.usernameFragment
  }
  return out
}

/**
 * Self-owned WebSocket signaling server for WebRTC SDP/ICE rendezvous.
 * Whitelists only Peer/SDP/ICE fields and never receives or forwards DSH secrets,
 * credentials, prompts, events, or approvals.
 */
export class SelfHostedSignalingServer {
  private readonly options: SelfHostedSignalingServerOptions
  private readonly maxRooms: number
  private readonly maxPeersPerRoom: number
  private readonly maxConnections: number
  private readonly maxFrameBytes: number
  private readonly maxOutboundQueue: number
  private readonly maxMessagesPerSecond: number
  private readonly registerTimeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly hostAuthDigest: Buffer | undefined

  private server: Server | undefined = undefined
  private isRunning = false
  private readonly preUpgradeSockets = new Map<Socket, NodeJS.Timeout>()
  private readonly peers = new Set<SignalingPeer>()
  private readonly rooms = new Map<string, SignalingRoom>()
  private relayedMessages = 0
  private rejectedMessages = 0

  constructor(options: SelfHostedSignalingServerOptions) {
    this.options = options
    this.maxRooms = options.maxRooms ?? 64
    this.maxPeersPerRoom = options.maxPeersPerRoom ?? 16
    this.maxConnections = options.maxConnections ?? 128
    this.maxFrameBytes = options.maxFrameBytes ?? 32_768
    this.maxOutboundQueue = options.maxOutboundQueue ?? 32
    this.maxMessagesPerSecond = options.maxMessagesPerSecond ?? 60
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

  getStats(): SignalingStats {
    return {
      activeRooms: this.rooms.size,
      activePeers: this.peers.size,
      relayedMessages: this.relayedMessages,
      rejectedMessages: this.rejectedMessages,
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) return

    if (this.options.enabled !== true) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'signaling server is disabled by default; options.enabled must be explicitly true',
      )
    }

    const bindHost = this.options.host?.trim()
    if (!bindHost || isIP(bindHost) === 0) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        `signaling server requires explicit IP address, received '${this.options.host}'`,
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
      throw new RemoteCryptoError('HANDSHAKE_FAILED', `invalid signaling port: ${bindPort}`)
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
      if (this.preUpgradeSockets.size + this.peers.size >= this.maxConnections) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
        socket.destroy()
        return
      }
      const timer = setTimeout(() => {
        this.preUpgradeSockets.delete(socket)
        socket.destroy()
      }, this.registerTimeoutMs)
      this.preUpgradeSockets.set(socket, timer)
      const clearPreUpgrade = () => {
        const existing = this.preUpgradeSockets.get(socket)
        if (existing) {
          clearTimeout(existing)
          this.preUpgradeSockets.delete(socket)
        }
      }
      socket.once('close', clearPreUpgrade)
      socket.once('error', clearPreUpgrade)
    })

    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as Socket, head)
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

    const peerId = `peer-${randomBytes(8).toString('hex')}`
    const peer: SignalingPeer = {
      id: peerId,
      socket,
      parser: undefined as unknown as WebSocketFrameParser,
      role: 'unregistered',
      roomId: undefined,
      closed: false,
      pendingOutboundFrames: 0,
      rateWindowStartMs: Date.now(),
      rateCount: 0,
      registerTimer: undefined,
      idleTimer: undefined,
    }

    const parser = new WebSocketFrameParser(this.maxFrameBytes, true, {
      onFrame: (frame) => this.handleFrame(peer, frame),
      onTextFrameRejected: () => this.terminatePeer(peer, 1003, 'binary signaling frames required'),
      onOversizedFrame: () => this.terminatePeer(peer, 1009, 'signaling frame exceeds limit'),
      onProtocolError: (reason) => this.terminatePeer(peer, 1002, reason),
    })
    ;(peer as { parser: WebSocketFrameParser }).parser = parser

    peer.registerTimer = setTimeout(() => {
      if (peer.role === 'unregistered') {
        this.terminatePeer(peer, 1008, 'signaling registration timeout')
      }
    }, this.registerTimeoutMs)
    this.resetPeerIdle(peer)

    this.peers.add(peer)

    socket.on('data', (chunk: Buffer) => {
      try {
        this.resetPeerIdle(peer)
        peer.parser.push(chunk)
      } catch {
        this.terminatePeer(peer, 1008, 'internal signaling error')
      }
    })
    socket.on('error', () => this.cleanupPeer(peer))
    socket.on('close', () => this.cleanupPeer(peer))

    if (head.length > 0) {
      try {
        peer.parser.push(head)
      } catch {
        this.terminatePeer(peer, 1008, 'invalid initial signaling data')
      }
    }
  }

  private resetPeerIdle(peer: SignalingPeer): void {
    if (peer.closed) return
    if (peer.idleTimer) clearTimeout(peer.idleTimer)
    peer.idleTimer = setTimeout(() => {
      this.terminatePeer(peer, 1000, 'idle timeout')
    }, this.idleTimeoutMs)
  }

  private sendJson(peer: SignalingPeer, payload: Record<string, unknown>): void {
    if (peer.closed || !peer.socket.writable) return
    if (peer.pendingOutboundFrames >= this.maxOutboundQueue) {
      this.terminatePeer(peer, 1008, 'slow signaling peer')
      return
    }
    const raw = textEncoder.encode(JSON.stringify(payload))
    if (raw.byteLength > this.maxFrameBytes) {
      return
    }
    const frame = encodeWebSocketFrame(raw, WebSocketOpcode.BINARY)
    peer.pendingOutboundFrames += 1
    peer.socket.write(frame, () => {
      peer.pendingOutboundFrames = Math.max(0, peer.pendingOutboundFrames - 1)
    })
  }

  private sendError(peer: SignalingPeer, code: string, message: string): void {
    this.rejectedMessages += 1
    this.sendJson(peer, { v: 1, type: 'error', code, message })
  }

  private consumePeerRateBudget(peer: SignalingPeer): boolean {
    const now = Date.now()
    if (now - peer.rateWindowStartMs >= 1_000) {
      peer.rateWindowStartMs = now
      peer.rateCount = 1
      return true
    }
    if (peer.rateCount >= this.maxMessagesPerSecond) {
      return false
    }
    peer.rateCount += 1
    return true
  }

  private handleFrame(peer: SignalingPeer, frame: WebSocketFrame): void {
    if (peer.closed) return

    if (frame.opcode === WebSocketOpcode.CLOSE) {
      this.terminatePeer(peer, 1000, 'closed')
      return
    }

    if (frame.opcode === WebSocketOpcode.PING) {
      if (peer.pendingOutboundFrames >= this.maxOutboundQueue) {
        this.terminatePeer(peer, 1008, 'slow signaling peer')
        return
      }
      const pong = encodeWebSocketFrame(frame.payload, WebSocketOpcode.PONG)
      peer.pendingOutboundFrames += 1
      peer.socket.write(pong, () => {
        peer.pendingOutboundFrames = Math.max(0, peer.pendingOutboundFrames - 1)
      })
      return
    }

    if (frame.opcode === WebSocketOpcode.PONG) {
      return
    }

    if (frame.opcode !== WebSocketOpcode.BINARY) {
      this.terminatePeer(peer, 1002, 'unsupported signaling opcode')
      return
    }

    if (!this.consumePeerRateBudget(peer)) {
      this.terminatePeer(peer, 1008, 'signaling rate limit exceeded')
      return
    }

    let parsed: Record<string, unknown>
    try {
      const obj = JSON.parse(textDecoder.decode(frame.payload))
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        this.terminatePeer(peer, 1002, 'signaling message must be an object')
        return
      }
      parsed = obj as Record<string, unknown>
    } catch {
      this.terminatePeer(peer, 1002, 'malformed signaling JSON')
      return
    }

    if (parsed.v !== 1 || typeof parsed.type !== 'string') {
      this.sendError(peer, 'INVALID_MESSAGE', 'unsupported signaling message version or type')
      return
    }

    switch (parsed.type) {
      case 'ping':
        this.sendJson(peer, { v: 1, type: 'pong' })
        return
      case 'host.register':
        this.handleHostRegister(peer, parsed)
        return
      case 'client.join':
        this.handleClientJoin(peer, parsed)
        return
      case 'rtc.offer':
      case 'rtc.answer':
        this.handleRelaySdp(peer, parsed)
        return
      case 'rtc.ice':
        this.handleRelayIce(peer, parsed)
        return
      default:
        this.sendError(peer, 'INVALID_MESSAGE', `unknown signaling type '${parsed.type}'`)
    }
  }

  private handleHostRegister(peer: SignalingPeer, msg: Record<string, unknown>): void {
    if (peer.role !== 'unregistered') {
      this.sendError(peer, 'ALREADY_REGISTERED', 'connection is already registered')
      return
    }

    const roomId = typeof msg.roomId === 'string' ? msg.roomId : ''
    if (!ROOM_ID_PATTERN.test(roomId)) {
      this.sendError(peer, 'INVALID_ROOM', 'invalid roomId')
      return
    }

    if (this.hostAuthDigest) {
      const supplied = typeof msg.hostAuthSecret === 'string' ? msg.hostAuthSecret : ''
      if (!supplied || !constantTimeDigestEquals(sha256Digest(supplied), this.hostAuthDigest)) {
        this.terminatePeer(peer, 1008, 'host signaling authentication failed')
        return
      }
    }

    if (this.rooms.has(roomId)) {
      this.sendError(peer, 'ROOM_OCCUPIED', 'room already has an active host')
      return
    }

    if (this.rooms.size >= this.maxRooms) {
      this.sendError(peer, 'ROOM_CAPACITY_EXCEEDED', 'signaling server room capacity reached')
      return
    }

    const joinToken = typeof msg.joinToken === 'string' && msg.joinToken.length > 0
      ? sha256Digest(msg.joinToken)
      : undefined

    peer.role = 'host'
    peer.roomId = roomId
    if (peer.registerTimer) {
      clearTimeout(peer.registerTimer)
      peer.registerTimer = undefined
    }

    this.rooms.set(roomId, {
      roomId,
      host: peer,
      joinTokenDigest: joinToken,
      clients: new Map(),
    })

    this.sendJson(peer, {
      v: 1,
      type: 'host.registered',
      roomId,
      peerId: peer.id,
    })
  }

  private handleClientJoin(peer: SignalingPeer, msg: Record<string, unknown>): void {
    if (peer.role !== 'unregistered') {
      this.sendError(peer, 'ALREADY_REGISTERED', 'connection is already registered')
      return
    }

    const roomId = typeof msg.roomId === 'string' ? msg.roomId : ''
    if (!ROOM_ID_PATTERN.test(roomId)) {
      this.sendError(peer, 'INVALID_ROOM', 'invalid roomId')
      return
    }

    const room = this.rooms.get(roomId)
    if (!room || room.host.closed) {
      this.sendError(peer, 'HOST_OFFLINE', 'no active host for requested room')
      return
    }

    if (room.joinTokenDigest) {
      const supplied = typeof msg.joinToken === 'string' ? msg.joinToken : ''
      if (!supplied || !constantTimeDigestEquals(sha256Digest(supplied), room.joinTokenDigest)) {
        this.terminatePeer(peer, 1008, 'room join authentication failed')
        return
      }
    }

    if (room.clients.size >= this.maxPeersPerRoom) {
      this.sendError(peer, 'ROOM_FULL', 'room peer limit exceeded')
      return
    }

    peer.role = 'client'
    peer.roomId = roomId
    if (peer.registerTimer) {
      clearTimeout(peer.registerTimer)
      peer.registerTimer = undefined
    }
    room.clients.set(peer.id, peer)

    this.sendJson(peer, {
      v: 1,
      type: 'client.joined',
      roomId,
      peerId: peer.id,
      hostPeerId: room.host.id,
    })
    this.sendJson(room.host, {
      v: 1,
      type: 'peer.joined',
      roomId,
      peerId: peer.id,
    })
  }

  private resolveTargetPeer(
    sender: SignalingPeer,
    msg: Record<string, unknown>,
  ): { room: SignalingRoom; target: SignalingPeer } | undefined {
    if (sender.role === 'unregistered' || !sender.roomId) {
      this.sendError(sender, 'UNAUTHORIZED', 'peer is not registered in a room')
      return undefined
    }
    const room = this.rooms.get(sender.roomId)
    if (!room) {
      this.sendError(sender, 'HOST_OFFLINE', 'room is no longer active')
      return undefined
    }
    if (msg.roomId !== undefined && msg.roomId !== sender.roomId) {
      this.sendError(sender, 'ROUTING_DENIED', 'cross-room signaling is forbidden')
      return undefined
    }
    const toPeerId = typeof msg.toPeerId === 'string' ? msg.toPeerId : ''
    if (!toPeerId) {
      this.sendError(sender, 'INVALID_MESSAGE', 'toPeerId is required')
      return undefined
    }

    if (sender.role === 'client') {
      if (toPeerId !== room.host.id) {
        this.sendError(sender, 'ROUTING_DENIED', 'clients may only signal the room host')
        return undefined
      }
      return { room, target: room.host }
    }

    const client = room.clients.get(toPeerId)
    if (!client) {
      this.sendError(sender, 'PEER_UNKNOWN', 'target peer is not in room')
      return undefined
    }
    return { room, target: client }
  }

  private handleRelaySdp(sender: SignalingPeer, msg: Record<string, unknown>): void {
    const resolved = this.resolveTargetPeer(sender, msg)
    if (!resolved) return

    const sdp = sanitizeSdp(msg.sdp)
    const expectedType = msg.type === 'rtc.offer' ? 'offer' : 'answer'
    if (!sdp || sdp.type !== expectedType) {
      this.sendError(sender, 'INVALID_MESSAGE', 'invalid SDP payload')
      return
    }

    this.relayedMessages += 1
    this.sendJson(resolved.target, {
      v: 1,
      type: msg.type,
      roomId: resolved.room.roomId,
      fromPeerId: sender.id,
      toPeerId: resolved.target.id,
      sdp,
    })
  }

  private handleRelayIce(sender: SignalingPeer, msg: Record<string, unknown>): void {
    const resolved = this.resolveTargetPeer(sender, msg)
    if (!resolved) return

    const candidate = sanitizeCandidate(msg.candidate)
    if (candidate === undefined) {
      this.sendError(sender, 'INVALID_MESSAGE', 'invalid ICE candidate payload')
      return
    }

    this.relayedMessages += 1
    this.sendJson(resolved.target, {
      v: 1,
      type: 'rtc.ice',
      roomId: resolved.room.roomId,
      fromPeerId: sender.id,
      toPeerId: resolved.target.id,
      candidate,
    })
  }

  private cleanupPeer(peer: SignalingPeer): void {
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
      for (const client of Array.from(room.clients.values())) {
        this.sendJson(client, { v: 1, type: 'host.offline', roomId: room.roomId })
        this.terminatePeer(client, 1001, 'host disconnected')
      }
      room.clients.clear()
      return
    }

    if (peer.role === 'client') {
      room.clients.delete(peer.id)
      if (!room.host.closed) {
        this.sendJson(room.host, {
          v: 1,
          type: 'peer.left',
          roomId: room.roomId,
          peerId: peer.id,
        })
      }
    }
  }

  private terminatePeer(peer: SignalingPeer, code: number, reason: string): void {
    const wasClosed = peer.closed
    this.cleanupPeer(peer)
    if (!wasClosed) {
      try {
        if (peer.socket.writable) {
          peer.socket.write(encodeCloseFrame(code, reason))
        }
      } catch {}
    }
    try {
      if (!peer.socket.destroyed) {
        peer.socket.destroy()
      }
    } catch {}
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return
    this.isRunning = false

    for (const [socket, timer] of this.preUpgradeSockets.entries()) {
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {}
    }
    this.preUpgradeSockets.clear()

    for (const peer of Array.from(this.peers)) {
      this.terminatePeer(peer, 1001, 'signaling server shutting down')
    }
    this.rooms.clear()

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve())
      })
      this.server = undefined
    }
  }
}
