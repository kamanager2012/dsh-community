import { RemoteProtocolError } from './errors.js'

interface Entry<T> {
  readonly fingerprint: string
  readonly value: T
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

  async run<T>(
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
      return existing.value as T
    }

    if (this.entries.size >= this.capacity) {
      throw new RemoteProtocolError(
        'STATE_CAPACITY_EXCEEDED',
        'idempotency capacity is exhausted; fail closed instead of forgetting keys',
      )
    }

    const value = await operation()
    this.entries.set(key, { fingerprint, value })
    return value
  }
}
