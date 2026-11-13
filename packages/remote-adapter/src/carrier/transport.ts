import { RemoteCryptoError } from '../crypto/errors.js'
import { RemoteProtocolError } from '../errors.js'

export type RemoteTransportKind = 'lan' | 'webrtc' | 'relay'

export interface FramedMessageTransportHandlers {
  readonly onMessage: (payload: Uint8Array) => void
  readonly onClose: () => void
  readonly onError: (error: Error) => void
}

/**
 * Minimal byte-frame transport consumed by RemoteServerChannel.
 * Implementations supply WebSocket (LAN/Relay) or WebRTC DataChannel framing
 * while keeping Noise IK and JSON-RPC security logic single-sourced.
 */
export interface FramedMessageTransport {
  readonly kind: RemoteTransportKind
  isWritable(): boolean
  getBufferedBytes(): number
  send(payload: Uint8Array, onFlushed?: () => void): void
  close(code?: number, reason?: string): void
  setHandlers(handlers: FramedMessageTransportHandlers): void
}

export interface FramedClientTransportHandlers {
  readonly onMessage: (payload: Uint8Array) => void
  readonly onClose: (reason?: string) => void
  readonly onError: (error: Error) => void
}

/**
 * Minimal client-side binary frame transport consumed by RemoteClientSession.
 */
export interface FramedClientTransport {
  readonly kind: RemoteTransportKind
  isOpen(): boolean
  connect(handlers: FramedClientTransportHandlers): Promise<void>
  send(payload: Uint8Array): void
  close(): void
}

export interface ReconnectBackoffPolicy {
  readonly initialDelayMs?: number
  readonly maxDelayMs?: number
  readonly multiplier?: number
  readonly maxAttempts?: number
}

export interface ResolvedReconnectBackoffPolicy {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly multiplier: number
  readonly maxAttempts: number
}

const DEFAULT_RECONNECT_POLICY: ResolvedReconnectBackoffPolicy = Object.freeze({
  initialDelayMs: 100,
  maxDelayMs: 2_000,
  multiplier: 2,
  maxAttempts: 5,
})

function positiveFiniteInteger(name: string, value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RemoteProtocolError(
      'INVALID_REQUEST',
      `${name} must be an integer between 1 and ${max}`,
    )
  }
  return value
}

export function resolveReconnectPolicy(
  policy: ReconnectBackoffPolicy | undefined,
): ResolvedReconnectBackoffPolicy {
  const initialDelayMs = positiveFiniteInteger(
    'initialDelayMs',
    policy?.initialDelayMs ?? DEFAULT_RECONNECT_POLICY.initialDelayMs,
    60_000,
  )
  const maxDelayMs = positiveFiniteInteger(
    'maxDelayMs',
    policy?.maxDelayMs ?? DEFAULT_RECONNECT_POLICY.maxDelayMs,
    60_000,
  )
  const maxAttempts = positiveFiniteInteger(
    'maxAttempts',
    policy?.maxAttempts ?? DEFAULT_RECONNECT_POLICY.maxAttempts,
    32,
  )
  const multiplier = policy?.multiplier ?? DEFAULT_RECONNECT_POLICY.multiplier
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10) {
    throw new RemoteProtocolError(
      'INVALID_REQUEST',
      'multiplier must be finite and between 1 and 10',
    )
  }
  if (maxDelayMs < initialDelayMs) {
    throw new RemoteProtocolError(
      'INVALID_REQUEST',
      'maxDelayMs cannot be smaller than initialDelayMs',
    )
  }
  return Object.freeze({ initialDelayMs, maxDelayMs, multiplier, maxAttempts })
}

export function reconnectDelayMs(
  retryIndex: number,
  policy?: ReconnectBackoffPolicy,
): number {
  if (!Number.isSafeInteger(retryIndex) || retryIndex < 1) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'retryIndex must be a positive integer')
  }
  const resolved = resolveReconnectPolicy(policy)
  const raw = resolved.initialDelayMs * Math.pow(resolved.multiplier, retryIndex - 1)
  return Math.min(resolved.maxDelayMs, Math.max(1, Math.round(raw)))
}

export function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

export function normalizeBinaryPayload(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) {
    return data
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  throw new RemoteCryptoError('HANDSHAKE_FAILED', 'transport delivered non-binary payload')
}
