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
  pinned: boolean
}

const encoder = new TextEncoder()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEphemeralChunkEvent(event: OfficialSessionEvent): boolean {
  return event.type === 'assistant/chunk'
}

function interactionKeyForRequest(event: OfficialSessionEvent): string | undefined {
  if (!isRecord(event.data)) return undefined
  if (event.type === 'approval.request' && typeof event.data.callId === 'string') {
    return `approval:${event.data.callId}`
  }
  if (event.type === 'question.request' && typeof event.data.questionId === 'string') {
    return `question:${event.data.questionId}`
  }
  return undefined
}

function interactionKeyForResolution(event: OfficialSessionEvent): string | undefined {
  if (!isRecord(event.data)) return undefined
  if (event.type === 'approval.resolved' && typeof event.data.callId === 'string') {
    return `approval:${event.data.callId}`
  }
  if (event.type === 'question.resolved' && typeof event.data.questionId === 'string') {
    return `question:${event.data.questionId}`
  }
  return undefined
}

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
  private durableMinimumResumeSeq = 0
  private ephemeralMinimumResumeSeq = 0

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

  getLatestSeq(): number {
    return this.latestSeq
  }

  getOldestSeq(): number | undefined {
    return this.entries[0]?.event.seq
  }

  size(): number {
    return this.entries.length
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
      this.durableMinimumResumeSeq = Math.max(0, event.seq - 1)
    }
    this.latestSeq = event.seq

    if (bytes > this.byteCapacity) {
      this.entries.length = 0
      this.totalBytes = 0
      this.durableMinimumResumeSeq = event.seq
      this.ephemeralMinimumResumeSeq = 0
      return
    }

    // Durable assistant finalization or turn end supersedes prior ephemeral token deltas,
    // preventing high-volume streaming chunks from starving durable session history.
    if (event.type === 'assistant/message' || event.type === 'turn/end') {
      this.pruneSupersededChunks(event.seq)
      this.ephemeralMinimumResumeSeq = 0
    }

    const resolvedKey = interactionKeyForResolution(event)
    if (resolvedKey !== undefined || event.type === 'turn/end') {
      for (const entry of this.entries) {
        if (!entry.pinned) continue
        if (event.type === 'turn/end' || interactionKeyForRequest(entry.event) === resolvedKey) {
          entry.pinned = false
        }
      }
    }

    const pinned = interactionKeyForRequest(event) !== undefined
    this.entries.push({ event, bytes, pinned })
    this.totalBytes += bytes

    while (
      this.entries.length > this.capacity
      || this.totalBytes > this.byteCapacity
    ) {
      const evictIndex = this.selectEvictionIndex()
      if (evictIndex < 0) break
      const [removed] = this.entries.splice(evictIndex, 1)
      if (!removed) break
      this.totalBytes -= removed.bytes
      if (isEphemeralChunkEvent(removed.event)) {
        this.ephemeralMinimumResumeSeq = Math.max(
          this.ephemeralMinimumResumeSeq,
          removed.event.seq,
        )
      } else {
        this.durableMinimumResumeSeq = Math.max(
          this.durableMinimumResumeSeq,
          removed.event.seq,
        )
      }
    }
  }

  private pruneSupersededChunks(beforeSeq: number): void {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i]!
      if (entry.event.seq < beforeSeq && isEphemeralChunkEvent(entry.event)) {
        this.entries.splice(i, 1)
        this.totalBytes -= entry.bytes
      }
    }
  }

  private selectEvictionIndex(): number {
    const chunkIdx = this.entries.findIndex((entry) => isEphemeralChunkEvent(entry.event))
    if (chunkIdx >= 0) return chunkIdx
    const unpinnedIdx = this.entries.findIndex((entry) => !entry.pinned)
    if (unpinnedIdx >= 0) return unpinnedIdx
    return this.entries.length > 0 ? 0 : -1
  }

  resume(afterSeq?: number): ReplayResult {
    if (afterSeq === undefined) {
      return {
        kind: 'events',
        events: this.entries.map(({ event }) => event),
      }
    }

    const minimumResumeSeq = Math.max(
      this.durableMinimumResumeSeq,
      this.ephemeralMinimumResumeSeq,
    )
    if (afterSeq < minimumResumeSeq) {
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
