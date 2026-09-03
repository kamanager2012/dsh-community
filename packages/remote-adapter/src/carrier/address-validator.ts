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
