import type { OfficialSessionEvent } from './protocol.js'

export type ReplayResult =
  | { readonly kind: 'events'; readonly events: readonly OfficialSessionEvent[] }
  | {
      readonly kind: 'reset'
      readonly reason: 'window-exceeded'
      readonly oldestSeq: number
      readonly latestSeq: number
    }
  | {
      readonly kind: 'reset'
      readonly reason: 'window-unavailable'
    }

interface BufferedEvent {
  readonly event: OfficialSessionEvent
  readonly bytes: number
}

const encoder = new TextEncoder()

function eventBytes(event: OfficialSessionEvent): number {
  const serialized = JSON.stringify(event)
  if (serialized === undefined) {
    throw new Error('official event must be JSON-serializable')
  }
  return encoder.encode(serialized).byteLength
}

export class BoundedReplayBuffer {
  private readonly entries: BufferedEvent[] = []
  private totalBytes = 0
  private latestSeq = 0
  private minimumResumeSeq = 0

  constructor(
    readonly capacity = 500,
    readonly byteCapacity = 2 * 1024 * 1024,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('capacity must be a positive integer')
    }
    if (!Number.isInteger(byteCapacity) || byteCapacity < 1) {
      throw new Error('byteCapacity must be a positive integer')
    }
  }

  append(event: OfficialSessionEvent): void {
    if (!Number.isSafeInteger(event.seq) || event.seq < 1) {
      throw new Error('official event sequence must be a positive integer')
    }
    if (this.latestSeq !== 0 && event.seq <= this.latestSeq) {
      throw new Error('official event sequence must increase monotonically')
    }

    const bytes = eventBytes(event)
    if (this.latestSeq === 0) {
      this.minimumResumeSeq = Math.max(0, event.seq - 1)
    }
    this.latestSeq = event.seq

    if (bytes > this.byteCapacity) {
      this.entries.length = 0
      this.totalBytes = 0
      this.minimumResumeSeq = event.seq
      return
    }

    this.entries.push({ event, bytes })
    this.totalBytes += bytes

    while (
      this.entries.length > this.capacity
      || this.totalBytes > this.byteCapacity
    ) {
      const removed = this.entries.shift()
      if (!removed) break
      this.totalBytes -= removed.bytes
      this.minimumResumeSeq = Math.max(
        this.minimumResumeSeq,
        removed.event.seq,
      )
    }
  }

  resume(afterSeq?: number): ReplayResult {
    if (afterSeq === undefined) {
      return {
        kind: 'events',
        events: this.entries.map(({ event }) => event),
      }
    }

    if (afterSeq < this.minimumResumeSeq) {
      const oldestSeq = this.entries[0]?.event.seq ?? this.latestSeq
      return {
        kind: 'reset',
        reason: 'window-exceeded',
        oldestSeq,
        latestSeq: this.latestSeq,
      }
    }

    return {
      kind: 'events',
      events: this.entries
        .map(({ event }) => event)
        .filter((event) => event.seq > afterSeq),
    }
  }
}
