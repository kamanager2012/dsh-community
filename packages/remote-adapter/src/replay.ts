import type { OfficialSessionEvent } from './protocol.js'

export type ReplayResult =
  | { readonly kind: 'events'; readonly events: readonly OfficialSessionEvent[] }
  | {
      readonly kind: 'reset'
      readonly reason: 'window-exceeded'
      readonly oldestSeq: number
      readonly latestSeq: number
    }

export class BoundedReplayBuffer {
  private readonly events: OfficialSessionEvent[] = []

  constructor(readonly capacity = 500) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('capacity must be a positive integer')
    }
  }

  append(event: OfficialSessionEvent): void {
    const latest = this.events.at(-1)
    if (latest && event.seq <= latest.seq) {
      throw new Error('official event sequence must increase monotonically')
    }
    this.events.push(event)
    while (this.events.length > this.capacity) this.events.shift()
  }

  resume(afterSeq?: number): ReplayResult {
    if (this.events.length === 0) return { kind: 'events', events: [] }
    if (afterSeq === undefined) {
      return { kind: 'events', events: [...this.events] }
    }

    const oldestSeq = this.events[0]!.seq
    const latestSeq = this.events.at(-1)!.seq
    if (afterSeq < oldestSeq - 1) {
      return { kind: 'reset', reason: 'window-exceeded', oldestSeq, latestSeq }
    }

    return {
      kind: 'events',
      events: this.events.filter((event) => event.seq > afterSeq),
    }
  }
}
