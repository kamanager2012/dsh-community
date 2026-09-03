import { RemoteCryptoError } from '../crypto/errors.js'

export const LAN_CARRIER_BOUNDS = Object.freeze({
  /**
   * Maximum permitted binary frame size (64 KiB).
   * Oversized frames are rejected immediately before reading/allocating payload memory.
   */
  maxFrameBytes: 65_536,

  /**
   * Maximum permitted handshake message size (1 KiB).
   * Noise IK messages are ~32 to 128 bytes.
   */
  maxHandshakeBytes: 1_024,

  /**
   * Maximum concurrent transport connections accepted by the host.
   */
  maxConcurrentConnections: 32,

  /**
   * Maximum inbound queue depth per connection.
   */
  maxInboundQueue: 16,

  /**
   * Maximum outbound queue depth per connection (high-water mark).
   * If a slow client fails to drain and outbound queue exceeds this, the connection is terminated.
   */
  maxOutboundQueue: 32,

  /**
   * Maximum buffered write bytes in the socket before slow-client disconnect.
   */
  maxBufferedEventBytes: 262_144, // 256 KiB

  /**
   * Handshake timeout in milliseconds.
   * If Noise handshake does not complete within this window, connection is terminated fail-closed.
   */
  handshakeTimeoutMs: 5_000, // 5s

  /**
   * Idle timeout in milliseconds.
   * If an active connection has no activity for this window, connection is closed cleanly.
   */
  idleTimeoutMs: 60_000, // 60s
})

export type LanCarrierBounds = {
  maxFrameBytes: number
  maxHandshakeBytes: number
  maxConcurrentConnections: number
  maxInboundQueue: number
  maxOutboundQueue: number
  maxBufferedEventBytes: number
  handshakeTimeoutMs: number
  idleTimeoutMs: number
}

const BOUNDS_KEYS = [
  'maxFrameBytes',
  'maxHandshakeBytes',
  'maxConcurrentConnections',
  'maxInboundQueue',
  'maxOutboundQueue',
  'maxBufferedEventBytes',
  'handshakeTimeoutMs',
  'idleTimeoutMs',
] as const

export function validateLanCarrierBounds(overrides?: Partial<LanCarrierBounds>): LanCarrierBounds {
  const merged: Record<string, number> = { ...LAN_CARRIER_BOUNDS }

  if (overrides) {
    for (const key of Object.keys(overrides)) {
      if (!BOUNDS_KEYS.includes(key as (typeof BOUNDS_KEYS)[number])) {
        throw new RemoteCryptoError('HANDSHAKE_FAILED', `unknown bounds property: ${key}`)
      }
    }

    for (const key of BOUNDS_KEYS) {
      const val = overrides[key]
      if (val !== undefined) {
        if (
          typeof val !== 'number' ||
          !Number.isFinite(val) ||
          !Number.isSafeInteger(val) ||
          val <= 0
        ) {
          throw new RemoteCryptoError(
            'HANDSHAKE_FAILED',
            `bounds.${key} must be a positive finite integer, received ${val}`,
          )
        }
        merged[key] = val
      }
    }
  }

  if (merged.maxHandshakeBytes! > merged.maxFrameBytes!) {
    throw new RemoteCryptoError(
      'HANDSHAKE_FAILED',
      `maxHandshakeBytes (${merged.maxHandshakeBytes}) cannot exceed maxFrameBytes (${merged.maxFrameBytes})`,
    )
  }

  if (merged.maxFrameBytes! > merged.maxBufferedEventBytes!) {
    throw new RemoteCryptoError(
      'HANDSHAKE_FAILED',
      `maxFrameBytes (${merged.maxFrameBytes}) cannot exceed maxBufferedEventBytes (${merged.maxBufferedEventBytes})`,
    )
  }

  return Object.freeze(merged as unknown as LanCarrierBounds)
}
