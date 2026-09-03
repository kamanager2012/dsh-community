import { describe, expect, it } from 'vitest'
import {
  REMOTE_PROTOCOL_VERSION,
  RemoteAdapterCore,
  RemoteProtocolError,
  computeFingerprint,
  type AuthenticatedPeer,
  type Capability,
  type OfficialRemoteSeams,
  type RemoteMethod,
  type RemoteRequest,
} from '../src/index.ts'

function fakeSeams() {
  const calls = {
    followup: 0,
    approval: 0,
    question: 0,
  }
  const seams: OfficialRemoteSeams = {
    async listSessions() {
      return [{ id: 's1', title: 'one' }]
    },
    async assertSession(sessionId) {
      if (sessionId !== 's1') throw new Error('missing session')
    },
    async followup(sessionId, prompt) {
      calls.followup += 1
      return { sessionId, prompt, turnId: `t${calls.followup}` }
    },
    async respondApproval(callId, decision) {
      calls.approval += 1
      return { callId, decision }
    },
    async respondQuestion(questionId, answer) {
      calls.question += 1
      return { questionId, answer }
    },
  }
  return { seams, calls }
}

function request(
  method: RemoteMethod,
  requestSeq: number,
  params: unknown,
  overrides: Partial<RemoteRequest> = {},
): RemoteRequest {
  return {
    jsonrpc: '2.0',
    id: `r${requestSeq}`,
    method,
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    connectionEpoch: 1,
    requestSeq,
    params,
    ...overrides,
  }
}

const testKey = new Uint8Array(32).fill(0x33)
const peer: AuthenticatedPeer = {
  deviceId: computeFingerprint(testKey),
  connectionEpoch: 1,
}

async function trustPeer(adapter: RemoteAdapterCore, capabilities: readonly Capability[]) {
  const host = await adapter.hostIdentityStore.getPublicIdentity()
  adapter.devices.trust(testKey, capabilities, { trustDomainId: host.trustDomainId })
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise
    throw new Error('expected rejection')
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteProtocolError)
    expect((error as RemoteProtocolError).code).toBe(code)
  }
}

describe('R1 remote protocol adversarial matrix', () => {
  it('deduplicates the same prompt submission but rejects payload collisions', async () => {
    const { seams, calls } = fakeSeams()
    const adapter = new RemoteAdapterCore(seams)
    await trustPeer(adapter, ['prompt'])

    const first = await adapter.handle(
      peer,
      request('prompt.submit', 1, { sessionId: 's1', prompt: 'hello' }, {
        idempotencyKey: 'idem-1',
      }),
    )
    const reconnect = { ...peer, connectionEpoch: 2 }
    const same = await adapter.handle(
      reconnect,
      request('prompt.submit', 1, { sessionId: 's1', prompt: 'hello' }, {
        connectionEpoch: 2,
        idempotencyKey: 'idem-1',
      }),
    )
    expect(same).toEqual(first)
    expect(calls.followup).toBe(1)

    await expectCode(
      adapter.handle(
        { ...peer, connectionEpoch: 3 },
        request('prompt.submit', 1, { sessionId: 's1', prompt: 'changed' }, {
          connectionEpoch: 3,
          idempotencyKey: 'idem-1',
        }),
      ),
      'IDEMPOTENCY_CONFLICT',
    )
    expect(calls.followup).toBe(1)
  })

  it('makes approval terminal state monotonic', async () => {
    const { seams, calls } = fakeSeams()
    const adapter = new RemoteAdapterCore(seams)
    await trustPeer(adapter, ['approve'])

    await adapter.handle(
      peer,
      request('approval.respond', 1, { callId: 'c1', decision: 'approved' }, {
        idempotencyKey: 'approve-1',
      }),
    )

    await expectCode(
      adapter.handle(
        peer,
        request('approval.respond', 2, { callId: 'c1', decision: 'rejected' }, {
          idempotencyKey: 'approve-2',
        }),
      ),
      'ALREADY_RESOLVED',
    )
    expect(calls.approval).toBe(1)
  })

  it('rejects a stale connection epoch without revoking pairing', async () => {
    const { seams, calls } = fakeSeams()
    const adapter = new RemoteAdapterCore(seams)
    await trustPeer(adapter, ['prompt'])
    const current = { ...peer, connectionEpoch: 2 }

    await expectCode(
      adapter.handle(
        current,
        request('prompt.submit', 1, { sessionId: 's1', prompt: 'late' }, {
          connectionEpoch: 1,
          idempotencyKey: 'late',
        }),
      ),
      'EPOCH_STALE',
    )
    expect(calls.followup).toBe(0)
  })

  it('rejects a revoked device before touching official seams', async () => {
    const { seams, calls } = fakeSeams()
    const adapter = new RemoteAdapterCore(seams)
    await trustPeer(adapter, ['prompt'])
    adapter.devices.revoke(peer.deviceId)

    await expectCode(
      adapter.handle(
        peer,
        request('prompt.submit', 1, { sessionId: 's1', prompt: 'nope' }, {
          idempotencyKey: 'revoked',
        }),
      ),
      'DEVICE_REVOKED',
    )
    expect(calls.followup).toBe(0)
  })

  it('enforces least-privilege capabilities before official seams', async () => {
    const { seams, calls } = fakeSeams()
    const adapter = new RemoteAdapterCore(seams)
    await trustPeer(adapter, ['observe'])

    await expectCode(
      adapter.handle(
        peer,
        request('prompt.submit', 1, { sessionId: 's1', prompt: 'nope' }, {
          idempotencyKey: 'denied',
        }),
      ),
      'CAPABILITY_DENIED',
    )
    expect(calls.followup).toBe(0)
  })

  it('replays the retained official event suffix after reconnect', async () => {
    const { seams } = fakeSeams()
    const adapter = new RemoteAdapterCore(seams, { replayCapacity: 500 })
    await trustPeer(adapter, ['observe'])
    for (let seq = 43; seq <= 50; seq += 1) {
      adapter.onOfficialEvent('s1', { seq, type: 'test/event' })
    }

    const result = await adapter.handle(
      peer,
      request('session.attach', 1, { sessionId: 's1', afterSeq: 42 }),
    )
    expect(result).toMatchObject({ kind: 'events' })
    expect((result as { events: { seq: number }[] }).events.map((event) => event.seq))
      .toEqual([43, 44, 45, 46, 47, 48, 49, 50])
  })

  it('fails closed to resync when the bounded replay window was exceeded', async () => {
    const { seams } = fakeSeams()
    const adapter = new RemoteAdapterCore(seams, { replayCapacity: 5 })
    await trustPeer(adapter, ['observe'])
    for (let seq = 43; seq <= 50; seq += 1) {
      adapter.onOfficialEvent('s1', { seq, type: 'test/event' })
    }

    const result = await adapter.handle(
      peer,
      request('session.attach', 1, { sessionId: 's1', afterSeq: 42 }),
    )
    expect(result).toEqual({
      kind: 'reset',
      reason: 'window-exceeded',
      oldestSeq: 46,
      latestSeq: 50,
    })
  })

  it('resets when a resume point references a replay window that is not resident', async () => {
    const { seams } = fakeSeams()
    const adapter = new RemoteAdapterCore(seams)
    await trustPeer(adapter, ['observe'])

    const result = await adapter.handle(
      peer,
      request('session.attach', 1, { sessionId: 's1', afterSeq: 42 }),
    )
    expect(result).toEqual({
      kind: 'reset',
      reason: 'window-unavailable',
    })
  })

  it('bounds replay memory across sessions with LRU eviction', async () => {
    const { seams } = fakeSeams()
    seams.assertSession = async () => {}
    const adapter = new RemoteAdapterCore(seams, { maxReplaySessions: 1 })
    await trustPeer(adapter, ['observe'])

    adapter.onOfficialEvent('s1', { seq: 1, type: 'test/event' })
    adapter.onOfficialEvent('s2', { seq: 1, type: 'test/event' })

    const result = await adapter.handle(
      peer,
      request('session.attach', 1, { sessionId: 's1', afterSeq: 1 }),
    )
    expect(result).toEqual({
      kind: 'reset',
      reason: 'window-unavailable',
    })
  })

  it('bounds replay memory by serialized event bytes, not only event count', async () => {
    const { seams } = fakeSeams()
    const adapter = new RemoteAdapterCore(seams, {
      replayCapacity: 500,
      replayByteCapacity: 64,
    })
    await trustPeer(adapter, ['observe'])

    adapter.onOfficialEvent('s1', {
      seq: 1,
      type: 'test/event',
      data: 'x'.repeat(256),
    })

    const result = await adapter.handle(
      peer,
      request('session.attach', 1, { sessionId: 's1', afterSeq: 0 }),
    )
    expect(result).toEqual({
      kind: 'reset',
      reason: 'window-exceeded',
      oldestSeq: 1,
      latestSeq: 1,
    })
  })

  it('rejects replayed request sequence numbers within one authenticated connection', async () => {
    const { seams } = fakeSeams()
    const adapter = new RemoteAdapterCore(seams)
    await trustPeer(adapter, ['observe'])

    await adapter.handle(peer, request('session.list', 1, {}))
    await expectCode(
      adapter.handle(peer, request('session.list', 1, {})),
      'REQUEST_REPLAY',
    )
  })

  it('allows a new transport epoch without resetting official event sequence or duplicating mutation', async () => {
    const { seams, calls } = fakeSeams()
    const adapter = new RemoteAdapterCore(seams)
    await trustPeer(adapter, ['prompt', 'observe'])
    adapter.onOfficialEvent('s1', { seq: 50, type: 'test/event' })

    await adapter.handle(
      peer,
      request('prompt.submit', 1, { sessionId: 's1', prompt: 'handover' }, {
        idempotencyKey: 'handover-1',
      }),
    )

    const relayPeer = { ...peer, connectionEpoch: 2 }
    await adapter.handle(
      relayPeer,
      request('prompt.submit', 1, { sessionId: 's1', prompt: 'handover' }, {
        connectionEpoch: 2,
        idempotencyKey: 'handover-1',
      }),
    )
    adapter.onOfficialEvent('s1', { seq: 51, type: 'test/event' })

    const result = await adapter.handle(
      relayPeer,
      request('session.attach', 2, { sessionId: 's1', afterSeq: 50 }, {
        connectionEpoch: 2,
      }),
    )

    expect(calls.followup).toBe(1)
    expect((result as { events: { seq: number }[] }).events.map((event) => event.seq))
      .toEqual([51])
  })

  it('single-flights concurrent retries with the same idempotency key', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { seams, calls } = fakeSeams()
    const baseFollowup = seams.followup
    seams.followup = async (sessionId, prompt) => {
      await gate
      return baseFollowup(sessionId, prompt)
    }

    const adapter = new RemoteAdapterCore(seams)
    await trustPeer(adapter, ['prompt'])

    const first = adapter.handle(
      peer,
      request('prompt.submit', 1, { sessionId: 's1', prompt: 'same' }, {
        idempotencyKey: 'concurrent-1',
      }),
    )
    const reconnect = { ...peer, connectionEpoch: 2 }
    const second = adapter.handle(
      reconnect,
      request('prompt.submit', 1, { sessionId: 's1', prompt: 'same' }, {
        connectionEpoch: 2,
        idempotencyKey: 'concurrent-1',
      }),
    )

    await Promise.resolve()
    expect(calls.followup).toBe(0)
    release()

    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(calls.followup).toBe(1)
  })

  it('claims an approval before the official seam so concurrent conflicting decisions cannot pass', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { seams, calls } = fakeSeams()
    const baseApproval = seams.respondApproval
    seams.respondApproval = async (callId, decision) => {
      await gate
      return baseApproval(callId, decision)
    }

    const adapter = new RemoteAdapterCore(seams)
    await trustPeer(adapter, ['approve'])

    const first = adapter.handle(
      peer,
      request('approval.respond', 1, { callId: 'c-race', decision: 'approved' }, {
        idempotencyKey: 'approval-race-1',
      }),
    )

    await expectCode(
      adapter.handle(
        peer,
        request('approval.respond', 2, { callId: 'c-race', decision: 'rejected' }, {
          idempotencyKey: 'approval-race-2',
        }),
      ),
      'ALREADY_RESOLVED',
    )

    expect(calls.approval).toBe(0)
    release()
    await first
    expect(calls.approval).toBe(1)
  })

  it('does not retain unbounded stream ACK state and validates the referenced session', async () => {
    const { seams } = fakeSeams()
    const adapter = new RemoteAdapterCore(seams)
    await trustPeer(adapter, ['observe'])

    await expect(adapter.handle(
      peer,
      request('stream.ack', 1, { sessionId: 's1', seq: 50 }),
    )).resolves.toEqual({ ok: true, seq: 50 })

    await expect(adapter.handle(
      peer,
      request('stream.ack', 2, { sessionId: 'missing', seq: 51 }),
    )).rejects.toThrow('missing session')
  })

  it('runtime-validates untrusted JSON before it can reach official seams', async () => {
    const { seams, calls } = fakeSeams()
    const adapter = new RemoteAdapterCore(seams)
    await trustPeer(adapter, ['prompt'])

    await expectCode(
      adapter.handle(peer, {
        ...request('prompt.submit', 1, { sessionId: 's1' }, {
          idempotencyKey: 'bad-shape',
        }),
      }),
      'INVALID_REQUEST',
    )
    expect(calls.followup).toBe(0)
  })

  it('fails closed instead of evicting old idempotency keys when memory is full', async () => {
    const { seams, calls } = fakeSeams()
    const adapter = new RemoteAdapterCore(seams, { idempotencyCapacity: 1 })
    await trustPeer(adapter, ['prompt'])

    await adapter.handle(
      peer,
      request('prompt.submit', 1, { sessionId: 's1', prompt: 'first' }, {
        idempotencyKey: 'first',
      }),
    )
    await expectCode(
      adapter.handle(
        peer,
        request('prompt.submit', 2, { sessionId: 's1', prompt: 'second' }, {
          idempotencyKey: 'second',
        }),
      ),
      'STATE_CAPACITY_EXCEEDED',
    )

    expect(calls.followup).toBe(1)
  })
})
