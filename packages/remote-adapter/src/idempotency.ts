import { RemoteProtocolError } from './errors.js'

interface Entry<T> {
  readonly fingerprint: string
  readonly value: T
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`
}

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry<unknown>>()

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

    const value = await operation()
    this.entries.set(key, { fingerprint, value })
    return value
  }
}
