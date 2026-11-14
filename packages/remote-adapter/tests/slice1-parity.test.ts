import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BoundedReplayBuffer,
  FailoverRemoteClient,
  InMemoryHostIdentityStore,
  OfficialHostCordisBridge,
  parsePairingInput,
  type OfficialAgentContextLike,
  type OfficialAgentHandleLike,
  type OfficialAgentLike,
  type OfficialCordisContextLike,
} from '../src/index.js'
import {
  findOfficialSessionTranscriptPath,
  readDecodedOfficialTranscript,
} from '../src/session-transcript.js'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  )
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

class MockAgent {
  readonly id: string
  status: 'idle' | 'running' = 'idle'
  currentModel = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'medium' }
  readonly log: Array<Record<string, unknown>> = []
  readonly listeners = new Map<string, Set<(...args: any[]) => unknown>>()
  readonly root: MockCordisRoot
  nextSeq = 0
  readonly session: { id: string; log: Array<Record<string, unknown>>; append(type: string, data: unknown): unknown }
  readonly model = {
    current: () => this.currentModel,
    select: (sel: { provider: string; model: string; reasoningEffort?: string }) => {
      this.currentModel = {
        provider: sel.provider,
        model: sel.model,
        reasoningEffort: sel.reasoningEffort ?? 'medium',
      }
    },
  }
  readonly ctx: OfficialAgentContextLike = {
    on: (event: string, listener: (...args: any[]) => unknown) => {
      let set = this.listeners.get(event)
      if (!set) {
        set = new Set()
        this.listeners.set(event, set)
      }
      set.add(listener)
      return () => {
        set?.delete(listener)
      }
    },
  }
  onFollowup?: (agent: MockAgent, message: Record<string, unknown>) => Promise<void> | void

  constructor(
    id: string,
    root: MockCordisRoot,
    initialLog: readonly Record<string, unknown>[] = [],
  ) {
    this.id = id
    this.root = root
    for (const ev of initialLog) {
      this.log.push(ev)
      if (typeof ev.seq === 'number' && ev.seq >= this.nextSeq) {
        this.nextSeq = ev.seq + 1
      }
    }
    this.session = {
      id,
      log: this.log,
      append: (type: string, data: unknown) => {
        this.emitOfficial(type, data)
        return { seq: this.nextSeq - 1 }
      },
    }
  }

  emitOfficial(type: string, data: unknown): void {
    const ev = { seq: this.nextSeq++, type, time: Date.now(), data }
    this.log.push(ev)
    for (const fn of this.listeners.get('session/event') ?? []) {
      fn(this.session, ev)
    }
    this.root.emit('session/event', ev)
  }

  emitStatus(status: 'idle' | 'running'): void {
    this.status = status
    for (const fn of this.listeners.get('agent/status') ?? []) {
      fn({ status })
    }
  }

  emitChunk(chunk: string): void {
    for (const fn of this.listeners.get('agent/assistant-stream') ?? []) {
      fn({ frame: { type: 'chunk', chunk } })
    }
  }

  followup(message: Record<string, unknown>): void {
    void this.onFollowup?.(this, message)
  }

  cancel(): void {}
  async whenIdle(): Promise<void> {}
}

class MockCordisRoot implements OfficialCordisContextLike {
  readonly agentMap = new Map<string, MockAgent>()
  readonly rootListeners = new Map<string, Set<(...args: any[]) => unknown>>()
  readonly createdCalls: Array<{ sessionId: string; meta?: Record<string, unknown>; seed?: readonly unknown[]; inheritedEventCount?: number }> = []
  readonly executedCommands: Array<{ agentId: string; line: string }> = []
  onFollowup?: (agent: MockAgent, message: Record<string, unknown>) => Promise<void> | void

  readonly agents = {
    create: async (options: {
      sessionId: string
      meta?: Record<string, unknown>
      seed?: readonly unknown[]
      inheritedEventCount?: number
      setup?: (agentCtx: OfficialAgentContextLike, agent: OfficialAgentLike) => unknown
    }): Promise<OfficialAgentHandleLike> => {
      this.createdCalls.push({
        sessionId: options.sessionId,
        ...(options.meta !== undefined ? { meta: options.meta } : {}),
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
        ...(options.inheritedEventCount !== undefined ? { inheritedEventCount: options.inheritedEventCount } : {}),
      })
      const seedEvents = Array.isArray(options.seed)
        ? (options.seed as Record<string, unknown>[])
        : []
      const agent = new MockAgent(options.sessionId, this, seedEvents)
      agent.onFollowup = this.onFollowup
      this.agentMap.set(options.sessionId, agent)
      options.setup?.(agent.ctx, agent)
      return {
        agent,
        dispose: async () => {
          this.agentMap.delete(options.sessionId)
        },
      }
    },
    resume: async (options: {
      resumeSessionId: string
      setup?: (agentCtx: OfficialAgentContextLike, agent: OfficialAgentLike) => unknown
    }): Promise<OfficialAgentHandleLike> => {
      const existing = this.agentMap.get(options.resumeSessionId) ?? new MockAgent(options.resumeSessionId, this)
      existing.onFollowup = this.onFollowup
      this.agentMap.set(options.resumeSessionId, existing)
      options.setup?.(existing.ctx, existing)
      return {
        agent: existing,
        dispose: async () => {},
      }
    },
    get: (id: string) => this.agentMap.get(id),
    list: () => [...this.agentMap.values()],
  }

  readonly agentDefaultModel = {
    currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
  }

  readonly commands = {
    list: () => [
      { name: 'compact', description: 'Compact conversation history', inputHint: '[instructions]' },
      { name: 'goal', description: 'Set or clear goal tracking', inputHint: '<goal|clear>' },
    ],
    find: (_agent: OfficialAgentLike, name: string) => {
      return name === 'compact' || name === 'goal' ? { name } : undefined
    },
    execute: async (agent: OfficialAgentLike, line: string) => {
      this.executedCommands.push({ agentId: agent.id, line })
      if (line.startsWith('/compact')) {
        agent.session?.append?.('compaction', { summary: 'Compacted via remote command' })
        return { handled: true, ok: true, commandId: 'compact', output: 'Compacted summary stored.' }
      }
      return true
    },
  }

  readonly skills = {
    list: () => [
      {
        name: 'code-review',
        description: 'Review code diff carefully',
        whenToUse: 'Before opening a PR',
        source: 'builtin',
      },
    ],
  }

  on(event: string, listener: (...args: any[]) => unknown): () => void {
    let set = this.rootListeners.get(event)
    if (!set) {
      set = new Set()
      this.rootListeners.set(event, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
    }
  }

  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.rootListeners.get(event) ?? []) {
      fn(...args)
    }
  }

  async parallel(event: string, ...args: unknown[]): Promise<unknown> {
    const fns = [...(this.rootListeners.get(event) ?? [])]
    let idx = 0
    const next = async (): Promise<unknown> => {
      const fn = fns[idx++]
      if (!fn) return undefined
      return fn(args[0], next)
    }
    return next()
  }

  get(name: string): unknown {
    if (name === 'commands') return this.commands
    if (name === 'skills') return this.skills
    return undefined
  }
}

async function createPairedClient(
  bridge: OfficialHostCordisBridge,
  displayName: string,
  requestedCapabilities?: readonly ('observe' | 'prompt' | 'approve' | 'answer-question')[],
): Promise<FailoverRemoteClient> {
  const issued = await bridge.issuePairingDescriptor(
    requestedCapabilities ? { allowedCapabilities: requestedCapabilities } : undefined,
  )
  const parsed = parsePairingInput(issued.deepLink)
  const id = await new InMemoryHostIdentityStore().loadOrCreate()
  const client = new FailoverRemoteClient({
    clientKeyPair: { publicKey: id.identity.publicKey, secretKey: id.secretKey },
    hostPublicKey: Uint8Array.from(Buffer.from(parsed.hostPublicKeyHex, 'hex')),
    lan: { endpointUrl: parsed.endpointUrl },
  })
  await client.connect()
  await client.request('pairing.request', {
    token: parsed.bootstrapToken,
    displayName,
    ...(requestedCapabilities ? { requestedCapabilities } : {}),
  })
  // Allow autoConfirmCapabilities async listener to commit trust record before reconnect
  await new Promise((r) => setTimeout(r, 40))
  client.close()
  await client.reconnectWithBackoff({ initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 3 })
  return client
}

describe('Slice 1 dsh-Go parity optimizations in remote-adapter', () => {
  it('compacts superseded assistant chunks on finalization and pins unresolved approvals during chunk flood', () => {
    const buf = new BoundedReplayBuffer(20, 256 * 1024)

    buf.append({ seq: 1, type: 'turn/start', data: {} })
    buf.append({ seq: 2, type: 'user/message', data: { message: { role: 'user', content: 'Fix bug' } } })
    buf.append({ seq: 3, type: 'approval.request', data: { callId: 'call_pinned_1', toolName: 'bash' } })

    for (let seq = 4; seq <= 80; seq += 1) {
      buf.append({ seq, type: 'assistant/chunk', data: { chunk: `token-${seq} ` } })
    }

    // Durable turn/start, user/message, and pinned approval MUST survive 77 streaming chunks
    // during live attach (`afterSeq = undefined`), while `afterSeq = 0` mid-turn accurately
    // reports `reset` due to unfinalized mid-stream chunk evictions until `assistant/message` arrives.
    const liveAttachMidTurn = buf.resume(undefined)
    expect(liveAttachMidTurn.kind).toBe('events')
    if (liveAttachMidTurn.kind === 'events') {
      const types = liveAttachMidTurn.events.map((e) => `${e.seq}:${e.type}`)
      expect(types).toContain('1:turn/start')
      expect(types).toContain('2:user/message')
      expect(types).toContain('3:approval.request')
    }
    expect(buf.resume(0).kind).toBe('reset')

    // Finalize assistant/message -> all superseded assistant/chunk events should be pruned
    // and incremental resume after seq 1 recovers cleanly without reset!
    buf.append({
      seq: 81,
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Done!' }] } },
    })

    const afterFinalize = buf.resume(1)
    expect(afterFinalize.kind).toBe('events')
    if (afterFinalize.kind === 'events') {
      expect(afterFinalize.events.some((e) => e.type === 'assistant/chunk')).toBe(false)
      expect(afterFinalize.events.map((e) => e.seq)).toEqual([2, 3, 81])
    }

    // Resolving approval unpins it cleanly
    buf.append({ seq: 82, type: 'approval.resolved', data: { callId: 'call_pinned_1', decision: 'approved' } })
    buf.append({ seq: 83, type: 'turn/end', data: {} })
    expect(buf.getLatestSeq()).toBe(83)
  })

  it('decodes .v4.jsonl.zstd transcripts, enriches session.list, hydrates cold attach liveState, paginates session.history within byte bounds, and searches content', async () => {
    const root = makeTempDir('dsh-slice1-zstd')
    const configDir = join(root, 'community-config')
    const dshHome = join(root, 'dsh-home')
    const sid = 'session-zstd-history'
    const sessionDir = join(dshHome, 'sessions', '--workspace-app--', sid)
    mkdirSync(sessionDir, { recursive: true })

    const jsonlLines: string[] = [
      JSON.stringify({ id: sid, meta: { cwd: '/workspace/app' } }),
      JSON.stringify({ seq: 0, type: 'session/title', data: { title: 'Release Blocker Audit', source: 'user' } }),
      JSON.stringify({ seq: 1, type: 'session.model', data: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' } }),
    ]
    let seq = 2
    for (let turn = 1; turn <= 12; turn += 1) {
      jsonlLines.push(JSON.stringify({ seq: seq++, type: 'turn/start', data: {} }))
      jsonlLines.push(JSON.stringify({
        seq: seq++,
        type: 'user/message',
        data: { message: { role: 'user', content: `Turn ${turn}: investigate latency spike in module_${turn}` } },
      }))
      jsonlLines.push(JSON.stringify({
        seq: seq++,
        type: 'todo/write',
        data: { todos: [{ id: `t-${turn}`, content: `Check module_${turn}`, status: 'completed' }] },
      }))
      if (turn === 10) {
        // Large event payload (18 KiB) to exercise 44 KiB page byte budget on session.history
        jsonlLines.push(JSON.stringify({
          seq: seq++,
          type: 'tool/result',
          data: { callId: 'big-read', output: 'X'.repeat(18_000) },
        }))
      }
      jsonlLines.push(JSON.stringify({
        seq: seq++,
        type: 'step/end',
        data: { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 } },
      }))
      jsonlLines.push(JSON.stringify({
        seq: seq++,
        type: 'assistant/message',
        data: { message: { role: 'assistant', content: [{ type: 'text', text: `Resolved module_${turn} root cause cleanly.` }] } },
      }))
      jsonlLines.push(JSON.stringify({ seq: seq++, type: 'turn/end', data: {} }))
    }

    writeFileSync(
      join(sessionDir, 'session.v4.jsonl.zstd'),
      zstdCompressSync(Buffer.from(jsonlLines.join('\n') + '\n', 'utf8')),
    )

    const ctx = new MockCordisRoot()
    const bridge = new OfficialHostCordisBridge({
      ctx,
      configDir,
      dshHome,
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
      autoConfirmCapabilities: ['observe', 'prompt', 'approve', 'answer-question'],
    })
    await bridge.start()

    try {
      let step = 'pair'
      try {
        const client = await createPairedClient(bridge, 'Android Zstd Client')

        // 1. session.list exposes zstd-decoded human title, cwd, preview, model
        step = 'session.list'
        const listed = await client.request('session.list')
        const entry = listed.find((s: any) => s.id === sid)
        expect(entry).toBeDefined()
        expect(entry.title).toBe('Release Blocker Audit')
        expect(entry.cwd).toBe('/workspace/app')
        expect(entry.model).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' })
        expect(entry.preview).toContain('Resolved module_12 root cause cleanly.')

        // 2. Cold attach hydrates durable events + folded liveState
        step = 'session.attach'
        const attached = await client.request('session.attach', { sessionId: sid })
        expect(attached.kind).toBe('events')
        expect(attached.events.length).toBeGreaterThan(20)
        expect(attached.liveState).toBeDefined()
        expect(attached.liveState.title).toBe('Release Blocker Audit')
        expect(attached.liveState.status).toBe('idle')
        expect(attached.liveState.todos).toEqual([
          { id: 't-12', content: 'Check module_12', status: 'completed' },
        ])
        expect(attached.liveState.usage.inputTokens).toBe(1200)
        expect(attached.liveState.usage.outputTokens).toBe(600)
        expect(attached.liveState.usage.cacheReadTokens).toBe(240)
        expect(attached.liveState.turnCount).toBe(12)

        // 3. session.history backwards pagination with turn window and byte cap
        step = 'session.history page1'
        const page1 = await client.request('session.history', { sessionId: sid, limit: 10, minTurns: 2 })
        expect(page1.events.length).toBeGreaterThanOrEqual(4)
        expect(page1.hasMore).toBe(true)
        expect(page1.oldestSeq).toBe(page1.events[0].seq)

        step = 'session.history page2'
        const page2 = await client.request('session.history', {
          sessionId: sid,
          beforeSeq: page1.oldestSeq,
          limit: 15,
        })
        expect(page2.events.length).toBeGreaterThan(0)
        expect(page2.latestSeq).toBeLessThan(page1.oldestSeq)
        expect(Buffer.byteLength(JSON.stringify(page2), 'utf8')).toBeLessThan(64 * 1024)

        // 4. session.search across transcripts
        step = 'session.search'
        const searchRes = await client.request('session.search', { query: 'module_4' })
        expect(searchRes.query).toBe('module_4')
        expect(searchRes.hits.length).toBeGreaterThanOrEqual(2)
        expect(searchRes.hits[0].sessionId).toBe(sid)
        expect(searchRes.hits[0].title).toBe('Release Blocker Audit')

        client.close()
      } catch (err) {
        throw new Error(`[at step: ${step}] ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      await bridge.stop()
    }
  })

  it('surfaces active turn, pending approvals/questions, todos, commands, skills, fork, RBAC, and transport RTT', async () => {
    const root = makeTempDir('dsh-slice1-live')
    const configDir = join(root, 'community-config')
    const dshHome = join(root, 'dsh-home')
    mkdirSync(join(dshHome, 'sessions'), { recursive: true })

    const ctx = new MockCordisRoot()
    let pendingTestRelease: (() => void) | undefined
    ctx.onFollowup = async (agent) => {
      agent.emitStatus('running')
      agent.emitOfficial('turn/start', {})
      agent.emitOfficial('user/message', { message: { role: 'user', content: 'Deploy patch' } })
      agent.emitOfficial('todo/write', {
        todos: [
          { id: '1', content: 'Run tests', status: 'completed' },
          { id: '2', content: 'Ask operator approval', status: 'in_progress' },
        ],
      })
      agent.emitOfficial('step/end', { usage: { inputTokens: 420, outputTokens: 88 } })

      const approvalPromise = ctx.parallel(
        'approval/request',
        { agent, callId: 'call_live_exec_1', toolName: 'bash', reason: 'Run deploy script' },
        async () => 'cancelled',
      )
      const questionPromise = ctx
        .parallel(
          'user-questions/request',
          {
            agent,
            wait: { callId: 'q_live_env_1' },
            questions: [{ id: 'env', question: 'Which environment?', options: [{ label: 'staging' }] }],
          },
          async () => {
            throw new Error('NO_PROVIDER')
          },
        )
        .catch(() => {})
      pendingTestRelease = async () => {
        await approvalPromise
        await questionPromise
        agent.emitOfficial('assistant/message', {
          message: { role: 'assistant', content: [{ type: 'text', text: 'Deployed cleanly.' }] },
        })
        agent.emitOfficial('turn/end', {})
        agent.emitStatus('idle')
      }
    }

    const bridge = new OfficialHostCordisBridge({
      ctx,
      configDir,
      dshHome,
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
      autoConfirmCapabilities: ['observe', 'prompt', 'approve', 'answer-question'],
    })
    await bridge.start()

    try {
      const fullClient = await createPairedClient(bridge, 'Primary Controller', [
        'observe',
        'prompt',
        'approve',
        'answer-question',
      ])
      const readOnlyClient = await createPairedClient(bridge, 'Observer Tablet', ['observe'])

      // RTT & transport diagnostics check
      const pingInfo = await fullClient.pingWithLatency()
      expect(pingInfo.ok).toBe(true)
      expect(pingInfo.rttMs).toBeGreaterThanOrEqual(0)
      const diag = fullClient.getConnectionDiagnostics()
      expect(diag.connected).toBe(true)
      expect(diag.activeTransport).toBe('lan')
      expect(diag.lastRttMs).toBe(pingInfo.rttMs)
      expect(diag.connectionEpoch).toBeGreaterThanOrEqual(1)

      await fullClient.request(
        'session.create',
        { sessionId: 'live-parity-1', title: 'LiveOps Session' },
        { idempotencyKey: 'create-live-1' },
      )
      await fullClient.request(
        'prompt.submit',
        { sessionId: 'live-parity-1', prompt: 'Deploy patch' },
        { idempotencyKey: 'prompt-live-1' },
      )
      await new Promise((r) => setTimeout(r, 40))

      // Late attach by Observer Tablet mid-turn MUST receive liveState with active status, pending approvals/questions, todos & usage
      const lateAttach = await readOnlyClient.request('session.attach', { sessionId: 'live-parity-1' })
      expect(lateAttach.liveState.status).toBe('running')
      expect(lateAttach.liveState.pendingApprovals).toEqual([
        {
          callId: 'call_live_exec_1',
          toolName: 'bash',
          reason: 'Run deploy script',
          sessionId: 'live-parity-1',
        },
      ])
      expect(lateAttach.liveState.pendingQuestions).toHaveLength(1)
      expect(lateAttach.liveState.pendingQuestions[0].questionId).toBe('q_live_env_1')
      expect(lateAttach.liveState.pendingQuestions[0].prompt).toBe('Which environment?')
      expect(lateAttach.liveState.todos).toHaveLength(2)
      expect(lateAttach.liveState.usage.inputTokens).toBe(420)
      expect(lateAttach.liveState.usage.outputTokens).toBe(88)

      // Observer can read commands & skills, but CANNOT fork or execute commands
      const cmds = await readOnlyClient.request('command.list', { sessionId: 'live-parity-1' })
      expect(cmds.commands.map((c: any) => c.name)).toEqual(['compact', 'goal'])
      const skills = await readOnlyClient.request('skill.list', { sessionId: 'live-parity-1' })
      expect(skills.skills.map((s: any) => s.name)).toEqual(['code-review'])

      await expect(
        readOnlyClient.request(
          'session.fork',
          { sessionId: 'live-parity-1' },
          { idempotencyKey: 'ro-fork-1' },
        ),
      ).rejects.toThrow(/CAPABILITY_DENIED/)
      await expect(
        readOnlyClient.request(
          'command.execute',
          { sessionId: 'live-parity-1', command: '/compact' },
          { idempotencyKey: 'ro-cmd-1' },
        ),
      ).rejects.toThrow(/CAPABILITY_DENIED/)

      // Execute command & fork via full-capability client
      const cmdRes = await fullClient.request(
        'command.execute',
        { sessionId: 'live-parity-1', command: '/compact summarize turn' },
        { idempotencyKey: 'cmd-compact-1' },
      )
      expect(cmdRes.ok).toBe(true)
      expect(cmdRes.commandId).toBe('compact')
      expect(ctx.executedCommands).toEqual([
        { agentId: 'live-parity-1', line: '/compact summarize turn' },
      ])

      const forked = await fullClient.request(
        'session.fork',
        { sessionId: 'live-parity-1', atSeq: 3, title: 'Branch Experiment' },
        { idempotencyKey: 'fork-live-1' },
      )
      expect(forked.title).toBe('Branch Experiment')
      const createCall = ctx.createdCalls.find((c) => c.sessionId === forked.id)
      expect(createCall?.meta?.parentSession).toBe('live-parity-1')
      expect(createCall?.meta?.isSeeded).toBe(true)
      expect(createCall?.inheritedEventCount).toBe(3)

      // Resolve pending approval & question -> liveState clears cleanly
      await fullClient.request(
        'approval.respond',
        { callId: 'call_live_exec_1', decision: 'approved' },
        { idempotencyKey: 'approve-live-1' },
      )
      await fullClient.request(
        'question.respond',
        { questionId: 'q_live_env_1', answer: { answers: [{ id: 'env', selected: ['staging'] }] } },
        { idempotencyKey: 'answer-live-1' },
      )
      await pendingTestRelease?.()

      const settledAttach = await readOnlyClient.request('session.attach', { sessionId: 'live-parity-1' })
      expect(settledAttach.liveState.status).toBe('idle')
      expect(settledAttach.liveState.pendingApprovals).toEqual([])
      expect(settledAttach.liveState.pendingQuestions).toEqual([])

      // Path-traversal sessionId rejected fail-closed both at protocol parser and transcript helper
      const liveSessionsRoot = join(dshHome, 'sessions')
      expect(findOfficialSessionTranscriptPath(liveSessionsRoot, '../etc')).toBeUndefined()
      expect(findOfficialSessionTranscriptPath(liveSessionsRoot, 'nested/evil')).toBeUndefined()
      expect(findOfficialSessionTranscriptPath(liveSessionsRoot, 'a\\b')).toBeUndefined()
      await expect(
        readOnlyClient.request('session.attach', { sessionId: '../secret' }),
      ).rejects.toThrow(/INVALID_REQUEST/)
      await expect(
        readOnlyClient.request('session.history', { sessionId: 'a/b' }),
      ).rejects.toThrow(/INVALID_REQUEST/)
      await expect(
        fullClient.request(
          'session.fork',
          { sessionId: '../secret' },
          { idempotencyKey: 'bad-fork-1' },
        ),
      ).rejects.toThrow(/INVALID_REQUEST/)

      fullClient.close()
      readOnlyClient.close()
    } finally {
      await bridge.stop()
    }
  })

  it('bounds zstd decompression bombs, large session.list payloads, and oversized incremental attach deltas', async () => {
    const tmpRoot = makeTempDir('dsh-slice1-hardening')
    const sessionsRoot = join(tmpRoot, 'sessions')
    const bombDir = join(sessionsRoot, 'bomb-sess')
    mkdirSync(bombDir, { recursive: true })
    const bombFile = join(bombDir, 'session.v4.jsonl.zstd')
    writeFileSync(bombFile, zstdCompressSync(Buffer.alloc(65 * 1024 * 1024, 'x')))
    expect(readDecodedOfficialTranscript(bombFile)).toBeUndefined()

    const listRoot = join(tmpRoot, 'many-sessions')
    const ctx = new MockCordisRoot()
    const persistedRefs = Array.from({ length: 160 }, (_, idx) => {
      const id = `persisted-many-${idx}`
      const dir = join(listRoot, id)
      mkdirSync(dir, { recursive: true })
      const longMsg = `Preview_${idx}_` + 'Z'.repeat(300)
      writeFileSync(
        join(dir, 'session.jsonl'),
        [
          JSON.stringify({ id, meta: { cwd: `/workspace/very/long/project/path/for/session/${idx}` } }),
          JSON.stringify({ seq: 0, type: 'assistant/message', data: { message: { content: longMsg } } }),
        ].join('\n') + '\n',
        'utf8',
      )
      return { id, title: `Project_${idx}`, updatedAtMs: 1_700_000_000_000 + idx }
    })

    const bridge = new OfficialHostCordisBridge({
      ctx: ctx as unknown as OfficialCordisContextLike,
      dshHome: join(tmpRoot, 'dsh-home'),
      sessionRoot: listRoot,
      configDir: join(tmpRoot, 'community-remote'),
      listPersistedSessions: () => persistedRefs,
      autoConfirmCapabilities: ['observe', 'answer-question'],
      listen: { host: '127.0.0.1', port: 0 },
    })

    try {
      await bridge.start()

      // Inject 12 big live events (> 44 KiB total) while keeping them inside BoundedReplayBuffer (2 MiB)
      const bigSession = await bridge.createSession({ sessionId: 'big-delta-sess', title: 'Big Delta' })
      expect(bigSession.id).toBe('big-delta-sess')
      const bigAgent = ctx.agents.get(bigSession.id)!
      for (let i = 0; i < 12; i += 1) {
        bigAgent.emitOfficial('user/message', {
          message: { role: 'user', content: `chunk-${i}-` + 'M'.repeat(5_000) },
        })
      }

      const client = await createPairedClient(bridge, 'Hardening Device', ['observe'])
      const list = await client.request('session.list')
      expect(Buffer.byteLength(JSON.stringify(list), 'utf8')).toBeLessThanOrEqual(44 * 1024)
      expect(list.some((s: any) => s.id === 'big-delta-sess')).toBe(true)

      const incAttach = await client.request('session.attach', {
        sessionId: 'big-delta-sess',
        afterSeq: 0,
      })
      expect(incAttach.kind).toBe('reset')
      expect(incAttach.reason).toBe('window-exceeded')
      expect(incAttach.liveState).toBeDefined()

      // Explicit question decline/cancellation settles as ASK_CANCELLED and clears pendingQuestions
      let rejectedErr: Error | undefined
      const qPromise = ctx
        .parallel(
          'user-questions/request',
          {
            agent: bigAgent,
            wait: { callId: 'q_decline_1' },
            questions: [{ id: 'confirm', question: 'Proceed?' }],
          },
          async () => {
            throw new Error('NO_PROVIDER')
          },
        )
        .catch((err: unknown) => {
          rejectedErr = err as Error
        })
      const fullClient2 = await createPairedClient(bridge, 'Question Canceller', ['observe', 'answer-question'])
      await fullClient2.request(
        'question.respond',
        { questionId: 'q_decline_1', answer: { cancelled: true } },
        { idempotencyKey: 'decline-q-1' },
      )
      await qPromise
      expect(rejectedErr?.message).toContain('ASK_CANCELLED')
      const afterDecline = await client.request('session.attach', { sessionId: 'big-delta-sess' })
      expect(afterDecline.liveState?.pendingQuestions ?? []).toEqual([])
      fullClient2.close()
      client.close()
    } finally {
      await bridge.stop()
    }
  })
})
