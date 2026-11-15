import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { RemoteCryptoError } from '../crypto/errors.js'

function isIPv4PrivateOrLocal(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10))
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false
  }

  const [b0, b1] = parts

  // Loopback: 127.0.0.0/8
  if (b0 === 127) return true

  // RFC 1918 Private:
  // 10.0.0.0/8
  if (b0 === 10) return true
  // 172.16.0.0/12
  if (b0 === 172 && b1 !== undefined && b1 >= 16 && b1 <= 31) return true
  // 192.168.0.0/16
  if (b0 === 192 && b1 === 168) return true

  // Link-local: 169.254.0.0/16
  if (b0 === 169 && b1 === 254) return true

  return false
}

function isIPv6PrivateOrLocal(ip: string): boolean {
  const normalized = ip.toLowerCase().trim()

  // Loopback: ::1 or 0:0:0:0:0:0:0:1
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true

  // ULA (Unique Local Address, RFC 4193): fc00::/7 (fc.. or fd..)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true

  // Link-local: fe80::/10 (fe8, fe9, fea, feb)
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true
  }

  return false
}

export function isLanOrLocalAddress(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) return isIPv4PrivateOrLocal(ip)
  if (version === 6) return isIPv6PrivateOrLocal(ip)
  return false
}

function expandIPv6Words(raw: string): number[] | undefined {
  const zoneIdx = raw.indexOf('%')
  const ip = zoneIdx >= 0 ? raw.slice(0, zoneIdx) : raw
  if (isIP(ip) !== 6) return undefined

  const halves = ip.toLowerCase().split('::')
  if (halves.length > 2) return undefined

  const parseSegment = (seg: string): number[] | undefined => {
    if (seg === '') return []
    const parts = seg.split(':')
    const out: number[] = []
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!
      if (part.includes('.')) {
        if (i !== parts.length - 1 || isIP(part) !== 4) return undefined
        const octets = part.split('.').map((o) => Number.parseInt(o, 10))
        if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
          return undefined
        }
        out.push(((octets[0]! << 8) | octets[1]!) >>> 0, ((octets[2]! << 8) | octets[3]!) >>> 0)
      } else {
        if (!/^[0-9a-f]{1,4}$/u.test(part)) return undefined
        out.push(Number.parseInt(part, 16))
      }
    }
    return out
  }

  const head = parseSegment(halves[0] ?? '')
  const tail = halves.length === 2 ? parseSegment(halves[1] ?? '') : []
  if (!head || !tail) return undefined

  if (halves.length === 1) {
    return head.length === 8 ? head : undefined
  }
  const missing = 8 - (head.length + tail.length)
  if (missing < 1) return undefined
  return [...head, ...Array<number>(missing).fill(0), ...tail]
}

export function isWildcardBindAddress(host: string): boolean {
  const trimmed = host.trim()
  if (trimmed === '0.0.0.0') return true
  const words = expandIPv6Words(trimmed)
  return words !== undefined && words.every((w) => w === 0)
}

export function isLoopbackBindAddress(host: string): boolean {
  const trimmed = host.trim()
  const version = isIP(trimmed)
  if (version === 4) {
    return Number.parseInt(trimmed.split('.')[0] ?? '', 10) === 127
  }
  if (version === 6) {
    const words = expandIPv6Words(trimmed)
    if (!words) return false
    const isNativeLoopback =
      words[0] === 0 &&
      words[1] === 0 &&
      words[2] === 0 &&
      words[3] === 0 &&
      words[4] === 0 &&
      words[5] === 0 &&
      words[6] === 0 &&
      words[7] === 1
    if (isNativeLoopback) return true

    // IPv4-mapped IPv6 loopback (::ffff:127.0.0.0/8)
    const isV4Mapped =
      words[0] === 0 &&
      words[1] === 0 &&
      words[2] === 0 &&
      words[3] === 0 &&
      words[4] === 0 &&
      words[5] === 0xffff
    if (isV4Mapped && ((words[6]! >> 8) & 0xff) === 127) {
      return true
    }
  }
  return false
}

export function assertCarrierAuthForBindHost(
  bindHost: string,
  hostAuthSecret: string | undefined,
  serviceName: string,
): void {
  if (isLoopbackBindAddress(bindHost)) {
    return
  }
  if (typeof hostAuthSecret !== 'string' || hostAuthSecret.trim().length === 0) {
    throw new RemoteCryptoError(
      'HANDSHAKE_FAILED',
      `${serviceName} requires non-empty hostAuthSecret when binding to non-loopback or wildcard address '${bindHost}'`,
    )
  }
}

export function getLocalInterfaceAddresses(): Set<string> {
  const addrs = new Set<string>()
  const interfaces = networkInterfaces()
  for (const netList of Object.values(interfaces)) {
    if (!netList) continue
    for (const net of netList) {
      if (net.address) {
        addrs.add(net.address.toLowerCase().trim())
      }
    }
  }
  return addrs
}

export function validateLanBindingAddress(
  host: string | undefined,
  options?: { skipInterfaceCheckForTesting?: boolean | undefined },
): string {
  if (!host || typeof host !== 'string' || host.trim().length === 0) {
    throw new RemoteCryptoError(
      'HANDSHAKE_FAILED',
      'host binding address must be explicitly provided; wildcard default is forbidden',
    )
  }

  const trimmed = host.trim()
  const lower = trimmed.toLowerCase()

  // 1. Permanently reject wildcards
  if (
    lower === '0.0.0.0' ||
    lower === '::' ||
    lower === '0:0:0:0:0:0:0:0' ||
    lower === '*' ||
    lower === 'all'
  ) {
    throw new RemoteCryptoError(
      'HANDSHAKE_FAILED',
      `binding to wildcard or public default address '${host}' is strictly forbidden`,
    )
  }

  // 2. Must be an IP address (reject hostnames like 'localhost', 'example.com')
  const ipVersion = isIP(trimmed)
  if (ipVersion === 0) {
    throw new RemoteCryptoError(
      'HANDSHAKE_FAILED',
      `host '${host}' is not a valid IP address; hostnames are forbidden in R2B LAN binding`,
    )
  }

  // 3. Policy check: must be private / loopback / link-local / ULA
  if (!isLanOrLocalAddress(trimmed)) {
    throw new RemoteCryptoError(
      'HANDSHAKE_FAILED',
      `host '${host}' is a public or global-unicast address; R2B strictly permits LAN/private/loopback only`,
    )
  }

  // 4. Must exist on a local interface of the host machine
  if (!options?.skipInterfaceCheckForTesting) {
    const localAddrs = getLocalInterfaceAddresses()
    if (!localAddrs.has(lower)) {
      throw new RemoteCryptoError(
        'HANDSHAKE_FAILED',
        `host '${host}' is not assigned to any local network interface on this machine`,
      )
    }
  }

  return trimmed
}
