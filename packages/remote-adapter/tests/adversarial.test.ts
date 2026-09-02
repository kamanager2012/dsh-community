import { describe, expect, it } from 'vitest'
import {
  REMOTE_PROTOCOL_VERSION,
  RemoteAdapterCore,
  RemoteProtocolError,
  type AuthenticatedPeer,
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

const peer: AuthenticatedPeer = { deviceId: 'phone-1', connectionEpoch: 1 }

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
    adapter.devices.trust(peer.deviceId, ['prompt'])

    const first = await adapter.handle(
      peer,
      request('prompt.submit', 1, { sessionId: 's1', prompt: 'hello' }, {
        idempotencyKey: 'idem-1',
      }),
    )
    const replayPeer = { ...peer, connectionEpoch: 2 }
    const same = await adapter.handle(
      replayPeer,
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
    adapter.devices.trust(peer.deviceId, ['approve'])

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
    adapter.devices.trust(peer.deviceId, ['prompt'])
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
    adapter.devices.trust(peer.deviceId, ['prompt'])
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
    adapter.devices.trust(peer.deviceId, ['observe'])

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
    adapter.devices.trust(peer.deviceId, ['observe'])
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
    adapter.devices.trust(peer.deviceId, ['observe'])
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

  it('rejects replayed request sequence numbers within one authenticated connection', async () => {
    const { seams } = fakeSeams()
    const adapter = new RemoteAdapterCore(seams)
    adapter.devices.trust(peer.deviceId, ['observe'])

    await adapter.handle(peer, request('session.list', 1, {}))
    await expectCode(
      adapter.handle(peer, request('session.list', 1, {})),
      'REQUEST_REPLAY',
    )
  })

  it('allows a new transport epoch without resetting official event sequence or duplicating mutation', async () => {
    const { seams, calls } = fakeSeams()
    const adapter = new RemoteAdapterCore(seams)
    adapter.devices.trust(peer.deviceId, ['prompt', 'observe'])
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
})
