import { RemoteProtocolError } from './errors.js'

interface Entry<T> {
  readonly fingerprint: string
  readonly promise: Promise<T>
}

function canonical(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined'
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`
}

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry<unknown>>()

  constructor(readonly capacity = 4096) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('capacity must be a positive integer')
    }
  }

  get size(): number {
    return this.entries.size
  }

  run<T>(
    scope: string,
    idempotencyKey: string,
    payload: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${scope}:${idempotencyKey}`
    const fingerprint = canonical(payload)
    const existing = this.entries.get(key)
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new RemoteProtocolError(
          'IDEMPOTENCY_CONFLICT',
          'idempotency key was reused with a different payload',
        )
      }
      return existing.promise as Promise<T>
    }

    if (this.entries.size >= this.capacity) {
      throw new RemoteProtocolError(
        'STATE_CAPACITY_EXCEEDED',
        'idempotency capacity is exhausted; fail closed instead of forgetting keys',
      )
    }

    // Reserve the key before invoking the official seam. This provides
    // single-flight semantics for concurrent retries and keeps the settled
    // outcome (including rejection) so an uncertain side effect is never
    // replayed under the same key.
    const promise = Promise.resolve().then(operation)
    this.entries.set(key, { fingerprint, promise })
    return promise
  }
}
