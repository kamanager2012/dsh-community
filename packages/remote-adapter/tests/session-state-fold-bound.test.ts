import { describe, expect, it } from 'vitest'
import {
  computeFingerprint,
  InMemoryHostIdentityStore,
  LAN_CARRIER_BOUNDS,
  REMOTE_PROTOCOL_VERSION,
  RemoteAdapterCore,
  type OfficialRemoteSeams,
  type SessionLiveStateSnapshot,
} from '../src/index.js'
import {
  boundApprovalArgs,
  boundLiveStateSnapshot,
  MAX_APPROVAL_ARGS_BYTES,
  MAX_ATTACH_LIVESTATE_BYTES,
  MAX_ATTACH_RESPONSE_BYTES,
} from '../src/session-state-fold.js'

function hasLoneSurrogates(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1
      } else {
        return true
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

describe('bounded approval inputs and liveState budget in session.attach', () => {
  it('preserves compact args untouched and bounds 70k Write inputs while keeping metadata keys', () => {
    const small = { command: 'pnpm test', cwd: '/repo' }
    expect(boundApprovalArgs(small)).toBe(small)

    const hugeWriteArgs = {
      content: 'x'.repeat(70_000),
      file_path: '/workspace/critical/config.ts',
      mode: 'overwrite',
    }
    const bounded = boundApprovalArgs(hugeWriteArgs) as Record<string, unknown>
    expect(bounded.file_path).toBe('/workspace/critical/config.ts')
    expect(bounded.mode).toBe('overwrite')
    expect(bounded._truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(
      MAX_APPROVAL_ARGS_BYTES,
    )

    const emojiArgs = { content: '🚀'.repeat(25_000), path: 'emoji.txt' }
    const boundedEmoji = boundApprovalArgs(emojiArgs, 2048) as Record<string, unknown>
    const serializedEmoji = JSON.stringify(boundedEmoji)
    expect(Buffer.byteLength(serializedEmoji, 'utf8')).toBeLessThanOrEqual(2048)
    expect(hasLoneSurrogates(String(boundedEmoji.content ?? ''))).toBe(false)
    expect(boundedEmoji.path).toBe('emoji.txt')
  })

  it('bounds liveState snapshots across multiple large pending approvals', () => {
    const oversizedSnapshot: SessionLiveStateSnapshot = {
      status: 'running',
      todos: [],
      pendingApprovals: [
        {
          callId: 'apr-1',
          toolName: 'Write',
          sessionId: 'sess-1',
          args: { file_path: '/tmp/a.txt', content: 'A'.repeat(70_000) },
        },
        {
          callId: 'apr-2',
          toolName: 'Edit',
          sessionId: 'sess-1',
          args: { file_path: '/tmp/b.txt', new_string: 'B'.repeat(70_000) },
        },
      ],
      pendingQuestions: [],
    }

    const bounded = boundLiveStateSnapshot(oversizedSnapshot)
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(
      MAX_ATTACH_LIVESTATE_BYTES,
    )
    expect(bounded.pendingApprovals).toHaveLength(2)
  })

  it('budgets liveState and replay events together inside RemoteAdapterCore.attach under 65536B', async () => {
    const oversizedSnapshot: SessionLiveStateSnapshot = {
      status: 'running',
      todos: [],
      pendingApprovals: [
        {
          callId: 'apr-big',
          toolName: 'Write',
          sessionId: 'sess-attach',
          args: {
            content: 'W'.repeat(70_000),
            file_path: '/workspace/src/big.ts',
          },
        },
        {
          callId: 'apr-big-2',
          toolName: 'Write',
          sessionId: 'sess-attach',
          args: {
            content: 'Z'.repeat(70_000),
            file_path: '/workspace/src/big2.ts',
          },
        },
      ],
      pendingQuestions: [],
    }

    const seams: OfficialRemoteSeams = {
      listSessions: async () => [
        { id: 'sess-attach', title: 'Attach Test', status: 'running', updatedAt: Date.now() },
      ],
      assertSession: async () => {},
      submitPrompt: async () => ({ accepted: true, duplicate: false }),
      respondApproval: async () => ({ ok: true }),
      respondQuestion: async () => ({ ok: true }),
      abortTurn: async () => ({ ok: true }),
      getSessionLiveState: async () => oversizedSnapshot,
    }

    const hostStore = new InMemoryHostIdentityStore()
    const host = await hostStore.loadOrCreate()
    const core = new RemoteAdapterCore(seams, { hostIdentityStore: hostStore })
    const clientPublicKey = new Uint8Array(32).fill(9)
    const deviceId = computeFingerprint(clientPublicKey)
    core.devices.trust(clientPublicKey, ['observe'], {
      trustDomainId: host.identity.trustDomainId,
    })

    const peer = { deviceId, connectionEpoch: 1 }

    // 1. Even with zero events + huge pending approvals, attach fits well inside maxFrameBytes.
    const res0 = await core.handle(peer, {
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'session.attach',
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      connectionEpoch: 1,
      requestSeq: 1,
      params: { sessionId: 'sess-attach' },
    })
    expect(Buffer.byteLength(JSON.stringify(res0), 'utf8')).toBeLessThan(
      LAN_CARRIER_BOUNDS.maxFrameBytes,
    )

    // 2. Append 60 KB of replay events so liveState (~20 KB) + events (60 KB) > MAX_ATTACH_RESPONSE_BYTES.
    for (let i = 1; i <= 12; i += 1) {
      core.onOfficialEvent('sess-attach', {
        seq: i,
        type: 'assistant/message',
        data: { content: `${i}:${'e'.repeat(5_000)}` },
      })
    }

    const resFullAttach = (await core.handle(peer, {
      jsonrpc: '2.0',
      id: 'req-2',
      method: 'session.attach',
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      connectionEpoch: 1,
      requestSeq: 2,
      params: { sessionId: 'sess-attach' },
    })) as { kind: string; events: unknown[]; liveState?: SessionLiveStateSnapshot }

    expect(resFullAttach.kind).toBe('events')
    expect(resFullAttach.liveState?.hasMoreHistory).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(resFullAttach), 'utf8')).toBeLessThanOrEqual(
      MAX_ATTACH_RESPONSE_BYTES + 1024,
    )
    expect(Buffer.byteLength(JSON.stringify(resFullAttach), 'utf8')).toBeLessThan(
      LAN_CARRIER_BOUNDS.maxFrameBytes,
    )

    const resAfterSeq = (await core.handle(peer, {
      jsonrpc: '2.0',
      id: 'req-3',
      method: 'session.attach',
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      connectionEpoch: 1,
      requestSeq: 3,
      params: { sessionId: 'sess-attach', afterSeq: 0 },
    })) as { kind: string; reason?: string; liveState?: SessionLiveStateSnapshot }

    expect(resAfterSeq.kind).toBe('reset')
    expect(resAfterSeq.reason).toBe('window-exceeded')
    expect(Buffer.byteLength(JSON.stringify(resAfterSeq), 'utf8')).toBeLessThan(
      LAN_CARRIER_BOUNDS.maxFrameBytes,
    )
  })
})
