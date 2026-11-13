import { createSocket, type RemoteInfo, type Socket } from 'node:dgram'
import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { crc32 } from 'node:zlib'
import { RemoteCryptoError } from '../crypto/errors.js'

export const STUN_HEADER_BYTES = 20
export const STUN_MAGIC_COOKIE = 0x2112a442
export const STUN_BINDING_REQUEST = 0x0001
export const STUN_BINDING_SUCCESS_RESPONSE = 0x0101
export const STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020
export const STUN_ATTR_SOFTWARE = 0x8022
export const STUN_ATTR_FINGERPRINT = 0x8028
export const STUN_FINGERPRINT_XOR = 0x5354554e

export interface StunAttribute {
  readonly type: number
  readonly value: Buffer
}

export interface StunMessage {
  readonly type: number
  readonly length: number
  readonly transactionId: Buffer
  readonly attributes: readonly StunAttribute[]
  readonly raw: Buffer
}

export interface StunMappedEndpoint {
  readonly family: 'IPv4' | 'IPv6'
  readonly address: string
  readonly port: number
}

export interface SelfHostedStunServerOptions {
  /** Explicitly enable the STUN server. Default is false (fail closed). */
  readonly enabled?: boolean | undefined
  /** UDP bind IP/interface address. */
  readonly host: string
  /** UDP port (0 selects an ephemeral port). */
  readonly port?: number | undefined
  /** Maximum accepted incoming UDP datagram size. Default: 1280 bytes. */
  readonly maxPacketBytes?: number | undefined
  /** Max STUN Binding requests per source IP per 1s window. Default: 60. */
  readonly maxRequestsPerSecondPerIp?: number | undefined
  /** Max source IPs tracked in the rate-limit table. Default: 4096. */
  readonly maxTrackedIps?: number | undefined
  /** Optional SOFTWARE attribute label included in Binding responses. */
  readonly softwareLabel?: string | undefined
}

export interface StunServerStats {
  readonly requestsReceived: number
  readonly responsesSent: number
  readonly droppedMalformed: number
  readonly droppedRateLimited: number
}

function parseIpv4Bytes(address: string): Buffer | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  const out = Buffer.allocUnsafe(4)
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i]!
    if (!/^\d{1,3}$/.test(part)) return undefined
    const num = Number(part)
    if (num < 0 || num > 255) return undefined
    out[i] = num
  }
  return out
}

function expandIpv6Group(group: string): number[] | undefined {
  if (group.length === 0) return []
  const chunks = group.split(':')
  const values: number[] = []
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]!
    if (chunk.includes('.')) {
      if (i !== chunks.length - 1) return undefined
      const v4 = parseIpv4Bytes(chunk)
      if (!v4) return undefined
      values.push(v4.readUInt16BE(0), v4.readUInt16BE(2))
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(chunk)) return undefined
      values.push(Number.parseInt(chunk, 16))
    }
  }
  return values
}

export function parseIpAddressBytes(address: string): {
  family: 0x01 | 0x02
  bytes: Buffer
} {
  const clean = address.split('%')[0] ?? address
  if (clean.startsWith('::ffff:')) {
    const mappedV4 = parseIpv4Bytes(clean.slice(7))
    if (mappedV4) {
      return { family: 0x01, bytes: mappedV4 }
    }
  }

  const v4 = parseIpv4Bytes(clean)
  if (v4) {
    return { family: 0x01, bytes: v4 }
  }

  const doubleColonParts = clean.split('::')
  if (doubleColonParts.length > 2) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', `invalid IPv6 address: ${address}`)
  }

  const out = Buffer.alloc(16)
  if (doubleColonParts.length === 1) {
    const groups = expandIpv6Group(clean)
    if (!groups || groups.length !== 8) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', `invalid IPv6 address: ${address}`)
    }
    groups.forEach((g, idx) => out.writeUInt16BE(g, idx * 2))
    return { family: 0x02, bytes: out }
  }

  const left = expandIpv6Group(doubleColonParts[0]!)
  const right = expandIpv6Group(doubleColonParts[1]!)
  if (!left || !right || left.length + right.length >= 8) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', `invalid IPv6 address: ${address}`)
  }
  left.forEach((g, idx) => out.writeUInt16BE(g, idx * 2))
  const rightStart = 8 - right.length
  right.forEach((g, idx) => out.writeUInt16BE(g, (rightStart + idx) * 2))
  return { family: 0x02, bytes: out }
}

function formatIpv6(bytes: Buffer): string {
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) {
    groups.push(bytes.readUInt16BE(i).toString(16))
  }
  return groups.join(':')
}

function computeStunFingerprintValue(messageUpToFingerprint: Buffer): number {
  return (crc32(messageUpToFingerprint) ^ STUN_FINGERPRINT_XOR) >>> 0
}

function padAttrLength(len: number): number {
  return (4 - (len % 4)) % 4
}

function encodeAttribute(type: number, value: Buffer): Buffer {
  const pad = padAttrLength(value.length)
  const buf = Buffer.alloc(4 + value.length + pad)
  buf.writeUInt16BE(type, 0)
  buf.writeUInt16BE(value.length, 2)
  value.copy(buf, 4)
  return buf
}

export function parseStunPacket(packet: Uint8Array): StunMessage | undefined {
  const raw = Buffer.isBuffer(packet) ? packet : Buffer.from(packet)
  if (raw.length < STUN_HEADER_BYTES) return undefined
  if ((raw[0]! & 0xc0) !== 0) return undefined

  const type = raw.readUInt16BE(0)
  const length = raw.readUInt16BE(2)
  const cookie = raw.readUInt32BE(4)
  if (cookie !== STUN_MAGIC_COOKIE) return undefined
  if (length % 4 !== 0 || STUN_HEADER_BYTES + length !== raw.length) return undefined

  const transactionId = Buffer.from(raw.subarray(8, 20))
  const attributes: StunAttribute[] = []
  let offset = STUN_HEADER_BYTES
  while (offset + 4 <= raw.length) {
    const attrType = raw.readUInt16BE(offset)
    const attrLen = raw.readUInt16BE(offset + 2)
    const valueStart = offset + 4
    const padded = attrLen + padAttrLength(attrLen)
    if (valueStart + padded > raw.length) return undefined
    attributes.push({
      type: attrType,
      value: Buffer.from(raw.subarray(valueStart, valueStart + attrLen)),
    })
    offset = valueStart + padded
  }
  if (offset !== raw.length) return undefined

  return { type, length, transactionId, attributes, raw }
}

export function verifyStunFingerprint(msg: StunMessage): boolean {
  const last = msg.attributes[msg.attributes.length - 1]
  if (!last || last.type !== STUN_ATTR_FINGERPRINT || last.value.length !== 4) {
    return false
  }
  const fpAttrTotalBytes = 8
  const prefix = msg.raw.subarray(0, msg.raw.length - fpAttrTotalBytes)
  const expected = computeStunFingerprintValue(prefix)
  const actual = last.value.readUInt32BE(0) >>> 0
  return expected === actual
}

export function buildStunBindingRequest(
  transactionId: Buffer = randomBytes(12),
  includeFingerprint = true,
): Buffer {
  if (transactionId.length !== 12) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'STUN transactionId must be 12 bytes')
  }
  const attrLength = includeFingerprint ? 8 : 0
  const msg = Buffer.alloc(STUN_HEADER_BYTES + attrLength)
  msg.writeUInt16BE(STUN_BINDING_REQUEST, 0)
  msg.writeUInt16BE(attrLength, 2)
  msg.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  transactionId.copy(msg, 8)
  if (includeFingerprint) {
    const fp = computeStunFingerprintValue(msg.subarray(0, STUN_HEADER_BYTES))
    msg.writeUInt16BE(STUN_ATTR_FINGERPRINT, STUN_HEADER_BYTES)
    msg.writeUInt16BE(4, STUN_HEADER_BYTES + 2)
    msg.writeUInt32BE(fp, STUN_HEADER_BYTES + 4)
  }
  return msg
}

export function buildStunBindingResponse(params: {
  transactionId: Buffer
  remoteAddress: string
  remotePort: number
  softwareLabel?: string | undefined
}): Buffer {
  if (params.transactionId.length !== 12) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'STUN transactionId must be 12 bytes')
  }
  if (!Number.isInteger(params.remotePort) || params.remotePort < 1 || params.remotePort > 65535) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', `invalid STUN remote port: ${params.remotePort}`)
  }

  const parsedIp = parseIpAddressBytes(params.remoteAddress)
  const xorAddrValue = Buffer.alloc(parsedIp.family === 0x01 ? 8 : 20)
  xorAddrValue[0] = 0x00
  xorAddrValue[1] = parsedIp.family
  xorAddrValue.writeUInt16BE((params.remotePort ^ (STUN_MAGIC_COOKIE >>> 16)) & 0xffff, 2)

  const mask = Buffer.allocUnsafe(16)
  mask.writeUInt32BE(STUN_MAGIC_COOKIE, 0)
  params.transactionId.copy(mask, 4)
  for (let i = 0; i < parsedIp.bytes.length; i += 1) {
    xorAddrValue[4 + i] = parsedIp.bytes[i]! ^ mask[i]!
  }

  const attrBuffers: Buffer[] = [encodeAttribute(STUN_ATTR_XOR_MAPPED_ADDRESS, xorAddrValue)]
  if (params.softwareLabel && params.softwareLabel.length > 0) {
    const labelBytes = Buffer.from(params.softwareLabel, 'utf8').subarray(0, 128)
    attrBuffers.push(encodeAttribute(STUN_ATTR_SOFTWARE, labelBytes))
  }

  const bodyBeforeFp = Buffer.concat(attrBuffers)
  const totalAttrBytes = bodyBeforeFp.length + 8
  const full = Buffer.alloc(STUN_HEADER_BYTES + totalAttrBytes)
  full.writeUInt16BE(STUN_BINDING_SUCCESS_RESPONSE, 0)
  full.writeUInt16BE(totalAttrBytes, 2)
  full.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  params.transactionId.copy(full, 8)
  bodyBeforeFp.copy(full, STUN_HEADER_BYTES)

  const fpOffset = STUN_HEADER_BYTES + bodyBeforeFp.length
  const fp = computeStunFingerprintValue(full.subarray(0, fpOffset))
  full.writeUInt16BE(STUN_ATTR_FINGERPRINT, fpOffset)
  full.writeUInt16BE(4, fpOffset + 2)
  full.writeUInt32BE(fp, fpOffset + 4)
  return full
}

export function parseStunXorMappedAddress(msg: StunMessage): StunMappedEndpoint | undefined {
  const attr = msg.attributes.find((item) => item.type === STUN_ATTR_XOR_MAPPED_ADDRESS)
  if (!attr || attr.value.length < 8) return undefined
  const familyCode = attr.value[1]
  const xPort = attr.value.readUInt16BE(2)
  const port = (xPort ^ (STUN_MAGIC_COOKIE >>> 16)) & 0xffff

  const mask = Buffer.allocUnsafe(16)
  mask.writeUInt32BE(STUN_MAGIC_COOKIE, 0)
  msg.transactionId.copy(mask, 4)

  if (familyCode === 0x01) {
    if (attr.value.length !== 8) return undefined
    const ipBytes = Buffer.allocUnsafe(4)
    for (let i = 0; i < 4; i += 1) {
      ipBytes[i] = attr.value[4 + i]! ^ mask[i]!
    }
    return {
      family: 'IPv4',
      address: `${ipBytes[0]}.${ipBytes[1]}.${ipBytes[2]}.${ipBytes[3]}`,
      port,
    }
  }

  if (familyCode === 0x02) {
    if (attr.value.length !== 20) return undefined
    const ipBytes = Buffer.allocUnsafe(16)
    for (let i = 0; i < 16; i += 1) {
      ipBytes[i] = attr.value[4 + i]! ^ mask[i]!
    }
    return {
      family: 'IPv6',
      address: formatIpv6(ipBytes),
      port,
    }
  }

  return undefined
}

export async function stunBindingProbe(params: {
  readonly serverHost: string
  readonly serverPort: number
  readonly sourceHost?: string | undefined
  readonly sourcePort?: number | undefined
  readonly timeoutMs?: number | undefined
}): Promise<StunMappedEndpoint> {
  const family = isIP(params.serverHost) === 6 ? 'udp6' : 'udp4'
  const socket = createSocket(family)
  const txId = randomBytes(12)
  const request = buildStunBindingRequest(txId, true)

  return new Promise<StunMappedEndpoint>((resolve, reject) => {
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {}
      fn()
    }

    const timer = setTimeout(() => {
      done(() => reject(new RemoteCryptoError('HANDSHAKE_FAILED', 'STUN binding probe timed out')))
    }, params.timeoutMs ?? 2000)

    socket.on('error', (err) => {
      done(() => reject(err))
    })

    socket.on('message', (msgBytes) => {
      const parsed = parseStunPacket(msgBytes)
      if (
        !parsed ||
        parsed.type !== STUN_BINDING_SUCCESS_RESPONSE ||
        !parsed.transactionId.equals(txId) ||
        !verifyStunFingerprint(parsed)
      ) {
        return
      }
      const mapped = parseStunXorMappedAddress(parsed)
      if (!mapped) {
        done(() => reject(new RemoteCryptoError('HANDSHAKE_FAILED', 'STUN response missing XOR-MAPPED-ADDRESS')))
        return
      }
      done(() => resolve(mapped))
    })

    const finishBind = () => {
      socket.send(request, params.serverPort, params.serverHost, (err) => {
        if (err) done(() => reject(err))
      })
    }

    if (params.sourceHost !== undefined || params.sourcePort !== undefined) {
      socket.bind(params.sourcePort ?? 0, params.sourceHost, finishBind)
    } else {
      socket.bind(0, finishBind)
    }
  })
}

interface IpRateWindow {
  windowStartMs: number
  count: number
}

/**
 * Self-owned RFC 5389 UDP STUN Binding responder with bounded packet inspection
 * and per-source-IP sliding window rate control.
 */
export class SelfHostedStunServer {
  private readonly options: SelfHostedStunServerOptions
  private readonly maxPacketBytes: number
  private readonly maxRequestsPerSecondPerIp: number
  private readonly maxTrackedIps: number
  private socket: Socket | undefined = undefined
  private isRunning = false
  private readonly ipRateWindows = new Map<string, IpRateWindow>()
  private requestsReceived = 0
  private responsesSent = 0
  private droppedMalformed = 0
  private droppedRateLimited = 0

  constructor(options: SelfHostedStunServerOptions) {
    this.options = options
    this.maxPacketBytes = options.maxPacketBytes ?? 1280
    this.maxRequestsPerSecondPerIp = options.maxRequestsPerSecondPerIp ?? 60
    this.maxTrackedIps = options.maxTrackedIps ?? 4096

    if (!Number.isSafeInteger(this.maxPacketBytes) || this.maxPacketBytes < STUN_HEADER_BYTES) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid STUN maxPacketBytes')
    }
    if (!Number.isSafeInteger(this.maxRequestsPerSecondPerIp) || this.maxRequestsPerSecondPerIp < 1) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid STUN maxRequestsPerSecondPerIp')
    }
    if (!Number.isSafeInteger(this.maxTrackedIps) || this.maxTrackedIps < 1) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', 'invalid STUN maxTrackedIps')
    }
  }

  isListening(): boolean {
    return this.isRunning && this.socket !== undefined
  }

  getBoundAddress(): { host: string; port: number } | undefined {
    if (!this.socket || !this.isRunning) return undefined
    const addr = this.socket.address()
    return { host: addr.address, port: addr.port }
  }

  getStunUrl(): string | undefined {
    const addr = this.getBoundAddress()
    if (!addr) return undefined
    const hostPart = addr.host.includes(':') ? `[${addr.host}]` : addr.host
    return `stun:${hostPart}:${addr.port}`
  }

  getStats(): StunServerStats {
    return {
      requestsReceived: this.requestsReceived,
      responsesSent: this.responsesSent,
      droppedMalformed: this.droppedMalformed,
      droppedRateLimited: this.droppedRateLimited,
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) return

    if (this.options.enabled !== true) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        'self-hosted STUN server is disabled by default; options.enabled must be explicitly true',
      )
    }

    const bindHost = this.options.host?.trim()
    if (!bindHost || isIP(bindHost) === 0) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', `STUN server requires explicit IP address, received '${this.options.host}'`)
    }

    const bindPort = this.options.port ?? 0
    if (!Number.isInteger(bindPort) || bindPort < 0 || bindPort > 65535) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', `invalid STUN port: ${bindPort}`)
    }

    const family = isIP(bindHost) === 6 ? 'udp6' : 'udp4'
    const socket = createSocket(family)

    socket.on('message', (packet, rinfo) => {
      this.handleDatagram(socket, packet, rinfo)
    })

    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(bindPort, bindHost, () => {
        socket.removeListener('error', reject)
        resolve()
      })
    })

    this.socket = socket
    this.isRunning = true
  }

  private consumeRateBudget(remoteAddress: string): boolean {
    const now = Date.now()
    const existing = this.ipRateWindows.get(remoteAddress)
    if (!existing || now - existing.windowStartMs >= 1_000) {
      if (!existing && this.ipRateWindows.size >= this.maxTrackedIps) {
        const oldestKey = this.ipRateWindows.keys().next().value
        if (typeof oldestKey === 'string') {
          this.ipRateWindows.delete(oldestKey)
        }
      } else if (existing) {
        this.ipRateWindows.delete(remoteAddress)
      }
      this.ipRateWindows.set(remoteAddress, { windowStartMs: now, count: 1 })
      return true
    }

    if (existing.count >= this.maxRequestsPerSecondPerIp) {
      return false
    }
    existing.count += 1
    return true
  }

  private handleDatagram(socket: Socket, packet: Buffer, rinfo: RemoteInfo): void {
    this.requestsReceived += 1

    if (packet.length < STUN_HEADER_BYTES || packet.length > this.maxPacketBytes) {
      this.droppedMalformed += 1
      return
    }

    if (!this.consumeRateBudget(rinfo.address)) {
      this.droppedRateLimited += 1
      return
    }

    const msg = parseStunPacket(packet)
    if (!msg || msg.type !== STUN_BINDING_REQUEST) {
      this.droppedMalformed += 1
      return
    }

    try {
      const response = buildStunBindingResponse({
        transactionId: msg.transactionId,
        remoteAddress: rinfo.address,
        remotePort: rinfo.port,
        softwareLabel: this.options.softwareLabel ?? 'dsh-stun',
      })
      socket.send(response, rinfo.port, rinfo.address, (err) => {
        if (!err) {
          this.responsesSent += 1
        }
      })
    } catch {
      this.droppedMalformed += 1
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return
    this.isRunning = false
    const socket = this.socket
    this.socket = undefined
    this.ipRateWindows.clear()
    if (socket) {
      await new Promise<void>((resolve) => {
        socket.close(() => resolve())
      })
    }
  }
}
