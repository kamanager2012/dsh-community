/**
 * Bounded resource limits and configuration defaults for R2B LAN WebSocket Carrier.
 * All limits are finite, positive integers, checked before allocation or parsing.
 */

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

export type LanCarrierBounds = typeof LAN_CARRIER_BOUNDS
