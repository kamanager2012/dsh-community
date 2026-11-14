import type { Socket } from 'node:net'

export function normalizeRemoteIp(address: string | undefined): string {
  if (!address) return 'unknown'
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

/**
 * Bounded per-IP socket tracker shared across standalone relay/signaling listeners
 * and the unified HTTP/WebSocket gateway to enforce `maxConnectionsPerIp`.
 */
export class PerIpConnectionTracker {
  private readonly socketIps = new Map<Socket, string>()
  private readonly counts = new Map<string, number>()

  constructor(private readonly maxPerIp: number) {}

  get totalTracked(): number {
    return this.socketIps.size
  }

  has(socket: Socket): boolean {
    return this.socketIps.has(socket)
  }

  tryAcquire(socket: Socket): boolean {
    if (this.socketIps.has(socket)) return true
    const ip = normalizeRemoteIp(socket.remoteAddress)
    const count = this.counts.get(ip) ?? 0
    if (count >= this.maxPerIp) {
      return false
    }
    this.socketIps.set(socket, ip)
    this.counts.set(ip, count + 1)
    socket.once('close', () => {
      this.release(socket)
    })
    return true
  }

  release(socket: Socket): void {
    const trackedIp = this.socketIps.get(socket)
    if (trackedIp === undefined) return
    this.socketIps.delete(socket)
    const remaining = (this.counts.get(trackedIp) ?? 1) - 1
    if (remaining <= 0) {
      this.counts.delete(trackedIp)
    } else {
      this.counts.set(trackedIp, remaining)
    }
  }
}
