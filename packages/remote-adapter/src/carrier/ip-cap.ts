import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP, type Socket } from 'node:net'
import { RemoteCryptoError } from '../crypto/errors.js'

const IPV4_MAPPED_PREFIX = 0xffff_0000_0000n
const IPV4_MAX = 0xffff_ffffn
const IPV6_MAX = (1n << 128n) - 1n

interface CanonicalIp {
  readonly family: 4 | 6
  readonly value: bigint
  readonly canonical: string
}

export interface TrustedProxyCidr {
  readonly raw: string
  readonly family: 4 | 6
  readonly network: bigint
  readonly mask: bigint
  readonly prefix: number
}

function parseIpv4ToBigInt(addr: string): bigint | undefined {
  if (isIP(addr) !== 4) return undefined
  const parts = addr.split('.')
  if (parts.length !== 4) return undefined
  let value = 0n
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined
    value = (value << 8n) | BigInt(octet)
  }
  return value
}

function formatCanonicalIpv4(value: bigint): string {
  const b0 = Number((value >> 24n) & 0xffn)
  const b1 = Number((value >> 16n) & 0xffn)
  const b2 = Number((value >> 8n) & 0xffn)
  const b3 = Number(value & 0xffn)
  return `${b0}.${b1}.${b2}.${b3}`
}

function parseIpv6ToBigInt(addr: string): bigint | undefined {
  if (isIP(addr) !== 6) return undefined
  let normalized = addr
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':')
    if (lastColon === -1) return undefined
    const v4 = parseIpv4ToBigInt(normalized.slice(lastColon + 1))
    if (v4 === undefined) return undefined
    const hi = ((v4 >> 16n) & 0xffffn).toString(16)
    const lo = (v4 & 0xffffn).toString(16)
    normalized = `${normalized.slice(0, lastColon + 1)}${hi}:${lo}`
  }

  const parts = normalized.split('::')
  if (parts.length > 2) return undefined
  let groups: string[]
  if (parts.length === 2) {
    const left = parts[0]!.length > 0 ? parts[0]!.split(':') : []
    const right = parts[1]!.length > 0 ? parts[1]!.split(':') : []
    const fill = 8 - left.length - right.length
    if (fill < 1) return undefined
    groups = [...left, ...Array<string>(fill).fill('0'), ...right]
  } else {
    groups = normalized.split(':')
    if (groups.length !== 8) return undefined
  }

  let value = 0n
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined
    const hextet = Number.parseInt(group, 16)
    value = (value << 16n) | BigInt(hextet)
  }
  return value
}

function formatCanonicalIpv6(value: bigint): string {
  const hextets: number[] = []
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    hextets.push(Number((value >> shift) & 0xffffn))
  }

  let bestStart = -1
  let bestLen = 0
  let curStart = -1
  let curLen = 0
  for (let i = 0; i < hextets.length; i += 1) {
    if (hextets[i] === 0) {
      if (curStart === -1) {
        curStart = i
        curLen = 1
      } else {
        curLen += 1
      }
      if (curLen > bestLen) {
        bestStart = curStart
        bestLen = curLen
      }
    } else {
      curStart = -1
      curLen = 0
    }
  }

  if (bestLen < 2) {
    return hextets.map((h) => h.toString(16)).join(':')
  }
  const left = hextets.slice(0, bestStart).map((h) => h.toString(16)).join(':')
  const right = hextets.slice(bestStart + bestLen).map((h) => h.toString(16)).join(':')
  return `${left}::${right}`
}

function parseCanonicalIp(address: string | undefined): CanonicalIp | undefined {
  if (!address) return undefined
  const trimmed = address.trim()
  if (trimmed.length === 0) return undefined

  const v4 = parseIpv4ToBigInt(trimmed)
  if (v4 !== undefined) {
    return { family: 4, value: v4, canonical: formatCanonicalIpv4(v4) }
  }

  const v6 = parseIpv6ToBigInt(trimmed)
  if (v6 !== undefined) {
    if (v6 >= IPV4_MAPPED_PREFIX && v6 <= IPV4_MAPPED_PREFIX + IPV4_MAX) {
      const mappedV4 = v6 & IPV4_MAX
      return { family: 4, value: mappedV4, canonical: formatCanonicalIpv4(mappedV4) }
    }
    return { family: 6, value: v6, canonical: formatCanonicalIpv6(v6) }
  }
  return undefined
}

export const DEFAULT_IPV6_RATE_LIMIT_PREFIX = 64

export function validateIpv6PrefixLength(prefix: number): number {
  if (!Number.isInteger(prefix) || prefix < 1 || prefix > 128) {
    throw new RemoteCryptoError(
      'HANDSHAKE_FAILED',
      `ipv6PrefixLength must be an integer between 1 and 128, received '${String(prefix)}'`,
    )
  }
  return prefix
}

function prefixMask(bits: number, prefix: number): bigint {
  if (prefix === 0) return 0n
  const full = bits === 32 ? IPV4_MAX : IPV6_MAX
  return (full << BigInt(bits - prefix)) & full
}

export function normalizeRemoteIp(address: string | undefined): string {
  if (!address) return 'unknown'
  const parsed = parseCanonicalIp(address)
  if (parsed) return parsed.canonical
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

/**
 * Normalizes a client IP into a rate-limiting / connection-cap bucket key.
 * IPv4 (including IPv4-mapped IPv6) stays exact (/32), while IPv6 addresses
 * are aggregated to `ipv6PrefixLength` (default `/64`) to block delegated-prefix bypasses.
 */
export function normalizeIpForRateLimit(
  address: string | undefined,
  ipv6PrefixLength = DEFAULT_IPV6_RATE_LIMIT_PREFIX,
): string {
  const prefixLen = validateIpv6PrefixLength(ipv6PrefixLength)
  if (!address) return 'unknown'
  const parsed = parseCanonicalIp(address)
  if (!parsed) {
    return address.startsWith('::ffff:') ? address.slice(7) : address
  }
  if (parsed.family === 4 || prefixLen === 128) {
    return parsed.canonical
  }
  const mask = prefixMask(128, prefixLen)
  return `${formatCanonicalIpv6(parsed.value & mask)}/${prefixLen}`
}

/**
 * Parses and validates one trusted-proxy IP or CIDR specification.
 * Fails closed on empty tokens, malformed addresses, out-of-range prefixes, and `/0` wildcards.
 */
export function parseTrustedProxyCidr(raw: string): TrustedProxyCidr {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', 'trusted proxy entry must not be empty')
  }
  const slashParts = trimmed.split('/')
  if (slashParts.length > 2) {
    throw new RemoteCryptoError('HANDSHAKE_FAILED', `invalid trusted proxy CIDR: '${raw}'`)
  }
  const ipPart = slashParts[0]!.trim()
  const hasPrefix = slashParts.length === 2
  const prefixRaw = hasPrefix ? slashParts[1]!.trim() : undefined

  const parsePrefix = (maxBits: number): number => {
    if (prefixRaw === undefined) return maxBits
    if (!/^\d+$/.test(prefixRaw)) {
      throw new RemoteCryptoError('HANDSHAKE_FAILED', `invalid trusted proxy CIDR prefix: '${raw}'`)
    }
    const prefix = Number(prefixRaw)
    if (!Number.isInteger(prefix) || prefix < 1 || prefix > maxBits) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        `trusted proxy CIDR prefix must be between 1 and ${maxBits}: '${raw}'`,
      )
    }
    return prefix
  }

  const v4 = parseIpv4ToBigInt(ipPart)
  if (v4 !== undefined) {
    const prefix = parsePrefix(32)
    const mask = prefixMask(32, prefix)
    return {
      raw: trimmed,
      family: 4,
      network: v4 & mask,
      mask,
      prefix,
    }
  }

  const v6 = parseIpv6ToBigInt(ipPart)
  if (v6 !== undefined) {
    const prefix = parsePrefix(128)
    if (v6 >= IPV4_MAPPED_PREFIX && v6 <= IPV4_MAPPED_PREFIX + IPV4_MAX && prefix >= 96) {
      const mappedPrefix = prefix - 96
      if (mappedPrefix < 1) {
        throw new RemoteCryptoError(
          'HANDSHAKE_FAILED',
          `trusted proxy CIDR prefix must not match all IPv4 addresses: '${raw}'`,
        )
      }
      const mappedV4 = v6 & IPV4_MAX
      const mask = prefixMask(32, mappedPrefix)
      return {
        raw: trimmed,
        family: 4,
        network: mappedV4 & mask,
        mask,
        prefix: mappedPrefix,
      }
    }
    const mask = prefixMask(128, prefix)
    return {
      raw: trimmed,
      family: 6,
      network: v6 & mask,
      mask,
      prefix,
    }
  }

  throw new RemoteCryptoError('HANDSHAKE_FAILED', `invalid trusted proxy IP or CIDR: '${raw}'`)
}

export function parseTrustedProxyCidrs(entries?: readonly string[]): readonly TrustedProxyCidr[] {
  if (!entries || entries.length === 0) return []
  return entries.map((entry) => parseTrustedProxyCidr(entry))
}

/**
 * Parses a comma-separated list of trusted proxy IPs or CIDRs (used by CLI flags & env vars).
 * Fails closed on empty items or invalid CIDRs.
 */
export function parseTrustedProxyList(raw: string): string[] {
  const entries = raw.split(',').map((item) => item.trim())
  if (entries.length === 0 || entries.some((item) => item.length === 0)) {
    throw new RemoteCryptoError(
      'HANDSHAKE_FAILED',
      `trusted proxies list must contain comma-separated IPs or CIDRs: '${raw}'`,
    )
  }
  parseTrustedProxyCidrs(entries)
  return entries
}

export function isTrustedProxyIp(
  address: string | undefined,
  trustedProxies: readonly TrustedProxyCidr[],
): boolean {
  if (trustedProxies.length === 0) return false
  const parsed = parseCanonicalIp(address)
  if (!parsed) return false
  for (const cidr of trustedProxies) {
    if (cidr.family === parsed.family && (parsed.value & cidr.mask) === cidr.network) {
      return true
    }
  }
  return false
}

function parseForwardedIpToken(rawToken: string): string | undefined {
  let token = rawToken.trim()
  if (token.length === 0) return undefined
  if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) {
    token = token.slice(1, -1).trim()
  }
  if (token.startsWith('[')) {
    const closeBracket = token.indexOf(']')
    if (closeBracket === -1) return undefined
    const host = token.slice(1, closeBracket)
    const rest = token.slice(closeBracket + 1)
    if (rest.length > 0) {
      const portMatch = /^:(\d{1,5})$/.exec(rest)
      if (!portMatch) return undefined
      const port = Number(portMatch[1])
      if (!Number.isInteger(port) || port < 0 || port > 65535) return undefined
    }
    if (isIP(host) !== 6) return undefined
    return parseCanonicalIp(host)?.canonical
  }

  const direct = parseCanonicalIp(token)
  if (direct) return direct.canonical

  const v4WithPort = /^([^:]+):(\d{1,5})$/.exec(token)
  if (v4WithPort) {
    const port = Number(v4WithPort[2])
    if (Number.isInteger(port) && port >= 0 && port <= 65535 && isIP(v4WithPort[1]!) === 4) {
      return parseCanonicalIp(v4WithPort[1]!)?.canonical
    }
  }
  return undefined
}

function splitCommaRespectingQuotes(raw: string): string[] {
  const parts: string[] = []
  let current = ''
  let inQuotes = false
  let escaped = false
  for (const ch of raw) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\' && inQuotes) {
      current += ch
      escaped = true
      continue
    }
    if (ch === '"') {
      inQuotes = !inQuotes
      current += ch
      continue
    }
    if (ch === ',' && !inQuotes) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

function joinHeaderValue(raw: string | readonly string[] | undefined): string | undefined {
  if (raw === undefined) return undefined
  const joined = Array.isArray(raw) ? raw.join(',') : String(raw)
  return joined.trim().length > 0 ? joined : undefined
}

function resolveForwardedHopChain(
  tokens: readonly (string | undefined)[],
  peerIp: string,
  trustedProxies: readonly TrustedProxyCidr[],
): string {
  let lastTrustedIp: string | undefined
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const hopIp = tokens[i]
    if (!hopIp) {
      return peerIp
    }
    if (isTrustedProxyIp(hopIp, trustedProxies)) {
      lastTrustedIp = hopIp
      continue
    }
    return hopIp
  }
  return lastTrustedIp ?? peerIp
}

function extractRfcForwardedForTokens(raw: string): readonly (string | undefined)[] {
  return splitCommaRespectingQuotes(raw).map((element) => {
    const params = element.split(';')
    for (const param of params) {
      const trimmed = param.trim()
      if (/^for=/i.test(trimmed)) {
        return parseForwardedIpToken(trimmed.slice(4))
      }
    }
    return undefined
  })
}

/**
 * Resolves the effective client IP for an HTTP request or WebSocket upgrade.
 * Fails closed: forwarding headers are ignored unless `trustedProxies` is non-empty AND
 * `socketRemoteAddress` matches it, in which case chains are stripped right-to-left.
 */
export function resolveClientIpFromRequest(
  req: Pick<IncomingMessage, 'headers'>,
  socketRemoteAddress: string | undefined,
  trustedProxies: readonly TrustedProxyCidr[],
): string {
  const peerIp = normalizeRemoteIp(socketRemoteAddress)
  if (trustedProxies.length === 0 || !isTrustedProxyIp(peerIp, trustedProxies)) {
    return peerIp
  }

  const xff = joinHeaderValue(req.headers['x-forwarded-for'])
  if (xff !== undefined) {
    const tokens = xff.split(',').map((part) => parseForwardedIpToken(part))
    return resolveForwardedHopChain(tokens, peerIp, trustedProxies)
  }

  const forwarded = joinHeaderValue(req.headers['forwarded'])
  if (forwarded !== undefined) {
    return resolveForwardedHopChain(extractRfcForwardedForTokens(forwarded), peerIp, trustedProxies)
  }

  const xRealIp = joinHeaderValue(req.headers['x-real-ip'])
  if (xRealIp !== undefined) {
    const tokens = xRealIp.split(',').map((part) => parseForwardedIpToken(part))
    return resolveForwardedHopChain(tokens, peerIp, trustedProxies)
  }

  const cfIp = joinHeaderValue(req.headers['cf-connecting-ip'])
  if (cfIp !== undefined) {
    const tokens = cfIp.split(',').map((part) => parseForwardedIpToken(part))
    return resolveForwardedHopChain(tokens, peerIp, trustedProxies)
  }

  return peerIp
}

/**
 * Bounded per-IP/prefix concurrent socket / HTTP request tracker shared across standalone
 * relay/signaling listeners and the unified HTTP/WebSocket gateway to enforce `maxConnectionsPerIp`.
 * IPv6 addresses are aggregated by configurable prefix (`DEFAULT_IPV6_RATE_LIMIT_PREFIX = 64`).
 */
export class PerIpConnectionTracker {
  private readonly leaseIps = new Map<object, string>()
  private readonly counts = new Map<string, number>()
  readonly ipv6PrefixLength: number

  constructor(
    private readonly maxPerIp: number,
    ipv6PrefixLength = DEFAULT_IPV6_RATE_LIMIT_PREFIX,
  ) {
    this.ipv6PrefixLength = validateIpv6PrefixLength(ipv6PrefixLength)
  }

  get totalTracked(): number {
    return this.leaseIps.size
  }

  has(socketOrReq: object): boolean {
    return this.leaseIps.has(socketOrReq)
  }

  bucketKey(ip: string | undefined): string {
    return normalizeIpForRateLimit(ip, this.ipv6PrefixLength)
  }

  countForIp(ip: string): number {
    return this.counts.get(this.bucketKey(ip)) ?? 0
  }

  isAtCap(ip: string | undefined): boolean {
    return (this.counts.get(this.bucketKey(ip)) ?? 0) >= this.maxPerIp
  }

  tryAcquire(socket: Socket, explicitClientIp?: string): boolean {
    if (this.leaseIps.has(socket)) return true
    const key = this.bucketKey(explicitClientIp !== undefined ? explicitClientIp : socket.remoteAddress)
    const count = this.counts.get(key) ?? 0
    if (count >= this.maxPerIp) {
      return false
    }
    this.leaseIps.set(socket, key)
    this.counts.set(key, count + 1)
    socket.once('close', () => {
      this.release(socket)
    })
    return true
  }

  tryAcquireHttpRequest(req: IncomingMessage, res: ServerResponse, explicitClientIp?: string): boolean {
    if (this.leaseIps.has(req)) return true
    const key = this.bucketKey(explicitClientIp !== undefined ? explicitClientIp : req.socket.remoteAddress)
    const count = this.counts.get(key) ?? 0
    if (count >= this.maxPerIp) {
      return false
    }
    this.leaseIps.set(req, key)
    this.counts.set(key, count + 1)
    const cleanup = (): void => {
      this.release(req)
    }
    res.once('finish', cleanup)
    res.once('close', cleanup)
    return true
  }

  release(key: object): void {
    const trackedIp = this.leaseIps.get(key)
    if (trackedIp === undefined) return
    this.leaseIps.delete(key)
    const remaining = (this.counts.get(trackedIp) ?? 1) - 1
    if (remaining <= 0) {
      this.counts.delete(trackedIp)
    } else {
      this.counts.set(trackedIp, remaining)
    }
  }
}

export interface ProxyAwareHttpConnectionGuardOptions {
  readonly maxConnections: number
  readonly maxConnectionsPerIp: number
  readonly registerTimeoutMs: number
  readonly ipv6PrefixLength?: number | undefined
  readonly maxPreAuthConnectionsPerWindow?: number | undefined
  readonly preAuthRateWindowMs?: number | undefined
  readonly trustedProxies?: readonly string[] | undefined
  readonly onPerIpRejected: () => void
  readonly onPreAuthRateRejected?: (() => void) | undefined
}

/**
 * Shared connection admission, pre-handshake timeout, IPv6-prefix-aggregated per-bucket cap,
 * and global pre-auth admission rate guard used by BlindGatewayServer, BlindRelayServer, and
 * SelfHostedSignalingServer.
 */
export class ProxyAwareHttpConnectionGuard {
  readonly trustedProxies: readonly TrustedProxyCidr[]
  readonly ipTracker: PerIpConnectionTracker
  private readonly maxConnections: number
  private readonly registerTimeoutMs: number
  private readonly maxPreAuthConnectionsPerWindow: number
  private readonly preAuthRateWindowMs: number
  private readonly onPerIpRejected: () => void
  private readonly onPreAuthRateRejected: (() => void) | undefined
  private readonly openSockets = new Set<Socket>()
  private readonly pendingHandshakeTimers = new Map<Socket, ReturnType<typeof setTimeout>>()
  private readonly preAuthChargedSockets = new WeakSet<Socket>()
  private preAuthTimestamps: number[] = []
  private preAuthHead = 0

  constructor(options: ProxyAwareHttpConnectionGuardOptions) {
    this.trustedProxies = parseTrustedProxyCidrs(options.trustedProxies)
    this.maxConnections = options.maxConnections
    this.registerTimeoutMs = options.registerTimeoutMs
    this.maxPreAuthConnectionsPerWindow =
      options.maxPreAuthConnectionsPerWindow ?? Math.max(32, Math.floor(options.maxConnections / 2))
    if (!Number.isInteger(this.maxPreAuthConnectionsPerWindow) || this.maxPreAuthConnectionsPerWindow < 1) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        `maxPreAuthConnectionsPerWindow must be a positive integer, received '${String(this.maxPreAuthConnectionsPerWindow)}'`,
      )
    }
    this.preAuthRateWindowMs = options.preAuthRateWindowMs ?? 5_000
    if (!Number.isInteger(this.preAuthRateWindowMs) || this.preAuthRateWindowMs < 1) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        `preAuthRateWindowMs must be a positive integer, received '${String(this.preAuthRateWindowMs)}'`,
      )
    }
    this.onPerIpRejected = options.onPerIpRejected
    this.onPreAuthRateRejected = options.onPreAuthRateRejected
    this.ipTracker = new PerIpConnectionTracker(options.maxConnectionsPerIp, options.ipv6PrefixLength)
  }

  get openSocketCount(): number {
    return this.openSockets.size
  }

  private tryConsumeGlobalPreAuthBudget(): boolean {
    const now = Date.now()
    const cutoff = now - this.preAuthRateWindowMs
    while (
      this.preAuthHead < this.preAuthTimestamps.length &&
      this.preAuthTimestamps[this.preAuthHead]! <= cutoff
    ) {
      this.preAuthHead += 1
    }
    if (this.preAuthHead > 1024 && this.preAuthHead * 2 >= this.preAuthTimestamps.length) {
      this.preAuthTimestamps = this.preAuthTimestamps.slice(this.preAuthHead)
      this.preAuthHead = 0
    }
    if (this.preAuthTimestamps.length - this.preAuthHead >= this.maxPreAuthConnectionsPerWindow) {
      return false
    }
    this.preAuthTimestamps.push(now)
    return true
  }

  isTrustedProxySocket(socket: Pick<Socket, 'remoteAddress'>): boolean {
    return isTrustedProxyIp(normalizeRemoteIp(socket.remoteAddress), this.trustedProxies)
  }

  clearPendingTimer(socket: Socket): void {
    const timer = this.pendingHandshakeTimers.get(socket)
    if (timer) {
      clearTimeout(timer)
      this.pendingHandshakeTimers.delete(socket)
    }
  }

  handleConnection(socket: Socket): boolean {
    if (this.openSockets.size >= this.maxConnections) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
      socket.destroy()
      return false
    }

    if (!this.isTrustedProxySocket(socket)) {
      if (this.ipTracker.isAtCap(socket.remoteAddress)) {
        this.onPerIpRejected()
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
        socket.destroy()
        return false
      }
      if (!this.tryConsumeGlobalPreAuthBudget()) {
        this.onPreAuthRateRejected?.()
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
        socket.destroy()
        return false
      }
      this.preAuthChargedSockets.add(socket)
      if (!this.ipTracker.tryAcquire(socket)) {
        this.onPerIpRejected()
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
        socket.destroy()
        return false
      }
    }

    this.openSockets.add(socket)
    const timer = setTimeout(() => {
      this.pendingHandshakeTimers.delete(socket)
      socket.destroy()
    }, this.registerTimeoutMs)
    this.pendingHandshakeTimers.set(socket, timer)

    const onError = (): void => {
      this.clearPendingTimer(socket)
    }
    socket.once('close', () => {
      this.clearPendingTimer(socket)
      this.openSockets.delete(socket)
    })
    socket.once('error', onError)
    return true
  }

  handleHttpRequest(req: IncomingMessage, res: ServerResponse): boolean {
    this.clearPendingTimer(req.socket)
    if (this.ipTracker.has(req.socket)) {
      return true
    }

    const clientIp = resolveClientIpFromRequest(req, req.socket.remoteAddress, this.trustedProxies)
    if (this.ipTracker.isAtCap(clientIp)) {
      this.onPerIpRejected()
      res.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      })
      res.end('{"error":"too many requests"}')
      return false
    }
    if (!this.tryConsumeGlobalPreAuthBudget()) {
      this.onPreAuthRateRejected?.()
      res.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      })
      res.end('{"error":"too many pre-auth requests"}')
      return false
    }
    if (!this.ipTracker.tryAcquireHttpRequest(req, res, clientIp)) {
      this.onPerIpRejected()
      res.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      })
      res.end('{"error":"too many requests"}')
      return false
    }
    return true
  }

  acquireUpgrade(req: IncomingMessage, socket: Socket, preResolvedClientIp?: string): string | undefined {
    this.clearPendingTimer(socket)
    const clientIp =
      preResolvedClientIp ??
      resolveClientIpFromRequest(req, socket.remoteAddress, this.trustedProxies)

    if (!this.ipTracker.has(socket)) {
      const openCapExceeded = !this.openSockets.has(socket) && this.openSockets.size >= this.maxConnections
      if (openCapExceeded || this.ipTracker.totalTracked >= this.maxConnections) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
        socket.destroy()
        return undefined
      }
      if (this.ipTracker.isAtCap(clientIp)) {
        this.onPerIpRejected()
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
        socket.destroy()
        return undefined
      }
      if (preResolvedClientIp === undefined && !this.preAuthChargedSockets.has(socket)) {
        if (!this.tryConsumeGlobalPreAuthBudget()) {
          this.onPreAuthRateRejected?.()
          socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
          socket.destroy()
          return undefined
        }
        this.preAuthChargedSockets.add(socket)
      }
      if (!this.ipTracker.tryAcquire(socket, clientIp)) {
        this.onPerIpRejected()
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
        socket.destroy()
        return undefined
      }
    }

    return clientIp
  }

  destroyPendingAndReset(): void {
    for (const [socket, timer] of this.pendingHandshakeTimers.entries()) {
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {}
    }
    this.pendingHandshakeTimers.clear()
    this.openSockets.clear()
    this.preAuthTimestamps = []
    this.preAuthHead = 0
  }
}
