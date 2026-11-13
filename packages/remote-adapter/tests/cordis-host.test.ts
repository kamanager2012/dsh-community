import { request as httpRequest } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertOutsideOfficialDshHome,
  BlindRelayServer,
  createBridgeControlServer,
  DSH_REMOTE_DEEP_LINK_PREFIX,
  encodePairingDeepLink,
  FailoverRemoteClient,
  InMemoryHostIdentityStore,
  listOfficialSessionRefsFromRoot,
  OfficialHostCordisBridge,
  parsePairingInput,
  type OfficialAgentContextLike,
  type OfficialAgentHandleLike,
  type OfficialAgentLike,
  type OfficialCordisContextLike,
} from '../src/index.js'

type Listener = (...args: any[]) => unknown

class FakeAgentContext implements OfficialAgentContextLike {
  private readonly listeners = new Map<string, Set<Listener>>()

  on(event: string, listener: Listener): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
    }
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args)
    }
  }
}

class FakeRootContext implements OfficialCordisContextLike {
  private readonly liveAgents = new Map<string, OfficialAgentLike>()
  private readonly waterfalls = new Map<string, Listener[]>()
  readonly persisted = new Map<string, Array<{ seq: number; type: string; data?: unknown }>>()
  public followupHandler:
    | ((agent: FakeAgent, message: Record<string, unknown>, ctx: FakeRootContext) => Promise<void> | void)
    | undefined
  public disposedHandles = 0

  readonly agentDefaultModel = {
    currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
  }

  readonly agents = {
    create: async (options: {
      readonly sessionId: string
      readonly meta?: Record<string, unknown>
      readonly setup?: (agentCtx: OfficialAgentContextLike, agent: OfficialAgentLike) => unknown
    }): Promise<OfficialAgentHandleLike> => {
      const agent = new FakeAgent(options.sessionId, [], this)
      this.liveAgents.set(options.sessionId, agent)
      this.persisted.set(options.sessionId, [])
      options.setup?.(agent.ctx, agent)
      return {
        agent,
        dispose: async () => {
          this.liveAgents.delete(options.sessionId)
          this.disposedHandles += 1
        },
      }
    },
    resume: async (options: {
      readonly resumeSessionId: string
      readonly setup?: (agentCtx: OfficialAgentContextLike, agent: OfficialAgentLike) => unknown
    }): Promise<OfficialAgentHandleLike> => {
      const log = this.persisted.get(options.resumeSessionId) ?? []
      const agent = new FakeAgent(options.resumeSessionId, log, this)
      this.liveAgents.set(options.resumeSessionId, agent)
      options.setup?.(agent.ctx, agent)
      return {
        agent,
        dispose: async () => {
          this.liveAgents.delete(options.resumeSessionId)
          this.disposedHandles += 1
        },
      }
    },
    get: (id: string) => this.liveAgents.get(id),
    list: () => [...this.liveAgents.values()],
  }

  on(event: string, listener: Listener): () => void {
    const arr = this.waterfalls.get(event) ?? []
    arr.push(listener)
    this.waterfalls.set(event, arr)
    return () => {
      const current = this.waterfalls.get(event) ?? []
      this.waterfalls.set(
        event,
        current.filter((item) => item !== listener),
      )
    }
  }

  async dispatchWaterfall<T>(event: string, payload: unknown, fallback: () => Promise<T>): Promise<T> {
    const list = this.waterfalls.get(event) ?? []
    let index = 0
    const next = async (): Promise<T> => {
      const fn = list[index++]
      if (!fn) return fallback()
      return (await fn(payload, next)) as T
    }
    return next()
  }
}

class FakeAgent implements OfficialAgentLike {
  readonly ctx = new FakeAgentContext()
  readonly session: { readonly id: string; readonly log: Array<{ seq: number; type: string; data?: unknown }> }
  readonly followups: Array<Record<string, unknown>> = []

  constructor(
    readonly id: string,
    seedLog: Array<{ seq: number; type: string; data?: unknown }>,
    private readonly root: FakeRootContext,
  ) {
    this.session = { id, log: [...seedLog] }
  }

  followup(message: Record<string, unknown>): void {
    this.followups.push(message)
    queueMicrotask(() => {
      void this.root.followupHandler?.(this, message, this.root)
    })
  }

  emitOfficialSessionEvent(type: string, data?: unknown): void {
    const seq = this.session.log.length
    const event = { seq, type, time: Date.now(), ...(data !== undefined ? { data } : {}) }
    this.session.log.push(event)
    this.ctx.emit('session/event', this.session, event)
  }

  emitAssistantDelta(text: string): void {
    this.ctx.emit('agent/assistant-stream', {
      agent: this,
      frame: {
        type: 'chunk',
        turn: 1,
        step: 1,
        index: 0,
        chunk: { type: 'text-delta', text },
      },
    })
  }

  async whenIdle(): Promise<void> {}
}

describe('OfficialHostCordisBridge & Persistent Community Storage', () => {
  const tempRoots: string[] = []

  function mkTempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-r6-cordis-'))
    tempRoots.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enforces storage isolation strictly outside DSH_HOME and lists canonical v0/vN session logs', () => {
    const root = mkTempRoot()
    const dshHome = join(root, '.dsh')
    mkdirSync(join(dshHome, 'sessions', 's-alpha'), { recursive: true })
    mkdirSync(join(dshHome, 'sessions', '--tmp-ws-v4--', 's-v4'), { recursive: true })
    mkdirSync(join(dshHome, 'sessions', 's-ignored'), { recursive: true })

    writeFileSync(
      join(dshHome, 'sessions', 's-alpha', 'session.jsonl'),
      JSON.stringify({ id: 's-alpha', meta: { cwd: '/tmp/ws-alpha' } }) + '\n',
      'utf8',
    )
    writeFileSync(
      join(dshHome, 'sessions', '--tmp-ws-v4--', 's-v4', 'session.v4.jsonl.zstd'),
      'zstd-placeholder',
      'utf8',
    )
    writeFileSync(join(dshHome, 'sessions', 's-ignored', 'notes.txt'), 'not a session', 'utf8')

    expect(() => assertOutsideOfficialDshHome(dshHome, dshHome)).toThrow(/strictly outside/)
    expect(() =>
      assertOutsideOfficialDshHome(join(dshHome, 'community-remote'), dshHome),
    ).toThrow(/strictly outside/)

    const safeDir = assertOutsideOfficialDshHome(join(root, 'community-config', 'remote'), dshHome)
    expect(safeDir).toBe(join(root, 'community-config', 'remote'))

    const refs = listOfficialSessionRefsFromRoot(join(dshHome, 'sessions'))
    expect(refs.map((r) => r.id).sort()).toEqual(['s-alpha', 's-v4'])
    expect(refs.find((r) => r.id === 's-v4')?.title).toBe('--tmp-ws-v4--')
  })

  it('completes pairing via dsh-remote:// deep-link, streams 0-based Cordis events/approvals/questions, survives host restart, and revokes cleanly', async () => {
    const root = mkTempRoot()
    const dshHome = join(root, 'official-dsh-home')
    const configDir = join(root, 'community-remote-config')
    const sessionId = 's-r6-structural-1'
    mkdirSync(join(dshHome, 'sessions', sessionId), { recursive: true })
    writeFileSync(
      join(dshHome, 'sessions', sessionId, 'session.jsonl'),
      JSON.stringify({ id: sessionId, meta: { cwd: root } }) + '\n',
      'utf8',
    )

    const relayServer = new BlindRelayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      maxOpaquePayloadBytes: 65_536,
      maxFramesPerSecond: 200,
    })
    await relayServer.start()
    const relayUrl = relayServer.getEndpointUrl()!
    const relayRoomId = 'room_r6_structural_bridge_01'

    const ctx1 = new FakeRootContext()
    ctx1.persisted.set(sessionId, [
      { seq: 0, type: 'permission/preset', data: { preset: 'workspace-write' } },
    ])

    let approvalCallId = ''
    let questionCallId = ''
    let lastApprovalOutcome = ''
    let lastQuestionAnswer: unknown

    ctx1.followupHandler = async (agent, message, rootCtx) => {
      agent.emitOfficialSessionEvent('user/message', { message })
      agent.emitAssistantDelta('WORKING...')

      const abortCtl = new AbortController()
      lastApprovalOutcome = await rootCtx.dispatchWaterfall(
        'approval/request',
        {
          agent,
          toolName: 'bash',
          callId: 'call_r6_cmd_1',
          reason: 'Inspect workspace via bash',
          signal: abortCtl.signal,
        },
        async () => 'unavailable',
      )

      const qRes = await rootCtx.dispatchWaterfall(
        'user-questions/request',
        {
          agent,
          wait: { callId: 'q_r6_choice_1' },
          questions: [
            {
              id: 'mode',
              question: 'Select target?',
              options: [{ label: 'fast' }, { label: 'thorough' }],
            },
          ],
          signal: abortCtl.signal,
        },
        async () => {
          throw new Error('NO_PROVIDER')
        },
      )
      lastQuestionAnswer = qRes
      agent.emitAssistantDelta('DONE_WITH_APPROVAL')
      agent.emitOfficialSessionEvent('assistant/message', {
        message: { role: 'assistant', content: [{ type: 'text', text: 'DONE_WITH_APPROVAL' }] },
      })
    }

    const bridge1 = new OfficialHostCordisBridge({
      ctx: ctx1,
      configDir,
      dshHome,
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
      relay: { enabled: true, relayUrl, roomId: relayRoomId },
    })
    await bridge1.start()

    // Ensure host-identity.json and trusted-devices.json are outside DSH_HOME with 0600 perms
    expect(statSync(bridge1.stores.hostIdentityPath).mode & 0o777).toBe(0o600)
    const control1 = await createBridgeControlServer(bridge1)
    const issued = await bridge1.issuePairingDescriptor()
    expect(issued.deepLink.startsWith(DSH_REMOTE_DEEP_LINK_PREFIX)).toBe(true)

    const parsedDescriptor = parsePairingInput(issued.deepLink)
    expect(parsedDescriptor.endpointUrl).toBe(issued.descriptor.endpointUrl)
    expect(parsedDescriptor.relayUrl).toBe(relayUrl)
    expect(parsedDescriptor.relayRoomId).toBe(relayRoomId)
    expect(encodePairingDeepLink(parsedDescriptor)).toBe(issued.deepLink)

    const phoneIdentity = await new InMemoryHostIdentityStore().loadOrCreate()
    const phoneKeys = {
      publicKey: phoneIdentity.identity.publicKey,
      secretKey: phoneIdentity.secretKey,
    }
    const client = new FailoverRemoteClient({
      clientKeyPair: phoneKeys,
      hostPublicKey: Uint8Array.from(Buffer.from(parsedDescriptor.hostPublicKeyHex, 'hex')),
      lan: { endpointUrl: parsedDescriptor.endpointUrl },
      relay: { relayUrl, roomId: relayRoomId },
    })

    const receivedEvents: Array<{ seq: number; type: string; data?: any }> = []
    client.onEvent((ev: any) => {
      if (ev?.type === 'stream.event' && ev.event) {
        receivedEvents.push(ev.event)
        if (ev.event.type === 'approval.request') approvalCallId = ev.event.data?.callId ?? ''
        if (ev.event.type === 'question.request') questionCallId = ev.event.data?.questionId ?? ''
      }
    })

    await client.connect()
    const candidate = await client.request('pairing.request', {
      token: parsedDescriptor.bootstrapToken,
      displayName: 'Pixel R6',
    })
    // Verify operator control endpoint rejects unauthenticated confirm
    const unauthRes = await fetch(`${control1.url}/pairing/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidateId: candidate.candidateId }),
    })
    expect(unauthRes.status).toBe(401)

    const confirmRes = await fetch(`${control1.url}/pairing/confirm`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${control1.controlToken}`,
      },
      body: JSON.stringify({ candidateId: candidate.candidateId }),
    })
    expect(confirmRes.status).toBe(200)
    client.close()

    await client.reconnectWithBackoff({ initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 2 })
    const listed = await client.request('session.list')
    expect(listed.some((s: any) => s.id === sessionId)).toBe(true)

    await expect(
      client.request('session.attach', { sessionId: 'does-not-exist' }),
    ).rejects.toThrow(/session not found/)

    const attached = await client.resumeSession(sessionId)
    // Official seq 0 must survive normalization as seq 1
    expect(attached.events.some((e: any) => e.type === 'permission/preset' && e.seq === 1)).toBe(true)

    await client.request(
      'prompt.submit',
      { sessionId, prompt: 'Run safeguarded task' },
      { idempotencyKey: 'r6-cordis-prompt-1' },
    )

    await expect.poll(() => approvalCallId).toBe('call_r6_cmd_1')
    await client.request(
      'approval.respond',
      { callId: approvalCallId, decision: 'approved' },
      { idempotencyKey: 'r6-cordis-approval-1' },
    )

    await expect.poll(() => questionCallId).toBe('q_r6_choice_1')
    await client.request(
      'question.respond',
      { questionId: questionCallId, answer: 'thorough' },
      { idempotencyKey: 'r6-cordis-question-1' },
    )

    await expect.poll(() => lastApprovalOutcome).toBe('allowed-once')
    expect(lastQuestionAnswer).toEqual({
      answers: [{ id: 'mode', selected: ['thorough'] }],
    })
    await expect
      .poll(() => receivedEvents.some((e) => e.type === 'assistant/message'))
      .toBe(true)
    expect(receivedEvents.some((e) => e.type === 'assistant/chunk')).toBe(true)

    // Non-bridged agents must fall through via next() without interception
    const alienOutcome = await ctx1.dispatchWaterfall(
      'approval/request',
      { agent: { id: 'unrelated-agent' }, toolName: 'bash' },
      async () => 'unavailable',
    )
    expect(alienOutcome).toBe('unavailable')

    await control1.close()
    await bridge1.stop()
    client.close()

    // Restart Host reusing same persistent Community configDir + relay
    const ctx2 = new FakeRootContext()
    ctx2.persisted.set(sessionId, [
      { seq: 0, type: 'permission/preset', data: { preset: 'workspace-write' } },
    ])
    const bridge2 = new OfficialHostCordisBridge({
      ctx: ctx2,
      configDir,
      dshHome,
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
      relay: { enabled: true, relayUrl, roomId: relayRoomId },
    })
    await bridge2.start()

    const status2 = await bridge2.getStatus()
    expect(status2.hostFingerprint).toBe(parsedDescriptor.hostFingerprint)
    expect(status2.trustedDevices).toBe(1)

    const phoneAfterRestart = new FailoverRemoteClient({
      clientKeyPair: phoneKeys,
      hostPublicKey: Uint8Array.from(Buffer.from(parsedDescriptor.hostPublicKeyHex, 'hex')),
      priorityOrder: ['lan', 'relay'],
      lan: { endpointUrl: status2.lanEndpointUrl! },
      relay: { relayUrl, roomId: relayRoomId },
    })
    await phoneAfterRestart.connect()
    const sessionsAfterRestart = await phoneAfterRestart.request('session.list')
    expect(sessionsAfterRestart.some((s: any) => s.id === sessionId)).toBe(true)

    // Revoke phone device and confirm fail-closed blocking
    expect(await bridge2.revokeDevice(phoneAfterRestart.deviceId)).toBe(true)
    phoneAfterRestart.close()
    await expect(phoneAfterRestart.connect()).rejects.toThrow()

    await bridge2.stop()
    await relayServer.stop()
  })

  it('fails closed (cancels pending approval) when bridge.stop() executes mid-approval', async () => {
    const root = mkTempRoot()
    const ctx = new FakeRootContext()
    const sessionId = 's-r6-failclosed'
    const bridge = new OfficialHostCordisBridge({
      ctx,
      configDir: join(root, 'remote-cfg'),
      dshHome: join(root, '.dsh'),
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
    })
    await bridge.start()
    await bridge.createSession({ sessionId, cwd: root })

    const agent = ctx.agents.get(sessionId)!
    const outcomePromise = ctx.dispatchWaterfall(
      'approval/request',
      { agent, toolName: 'bash', callId: 'call_stop_midway', reason: 'test' },
      async () => 'unavailable',
    )

    await bridge.stop()
    await expect(outcomePromise).resolves.toBe('cancelled')
  })

  it('emits encrypted peer.revoked before close across LAN and Relay, aborts retry loops, and pushes stream.reset', async () => {
    const root = mkTempRoot()
    const dshHome = join(root, '.dsh')
    const configDir = join(root, 'remote-cfg')
    const relay = new BlindRelayServer({ enabled: true, host: '127.0.0.1', port: 0 })
    await relay.start()
    const relayUrl = relay.getEndpointUrl()!

    const ctx = new FakeRootContext()
    const sessionId = 's-r6-stage2-signals'
    const bridge = new OfficialHostCordisBridge({
      ctx,
      configDir,
      dshHome,
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
      relay: { enabled: true, relayUrl, roomId: 'room-stage2-signals' },
    })
    await bridge.start()
    const control = await createBridgeControlServer(bridge)

    try {
      await bridge.createSession({ sessionId, cwd: root })
      const agent = ctx.agents.get(sessionId)! as FakeAgent
      const status = await bridge.getStatus()
      const issued = await bridge.issuePairingDescriptor()
      const parsed = parsePairingInput(issued.deepLink)

      const makePairedClient = async (
        name: string,
        priorityOrder: readonly ('lan' | 'relay')[],
      ): Promise<FailoverRemoteClient> => {
        const kp = await new InMemoryHostIdentityStore().loadOrCreate()
        const cli = new FailoverRemoteClient({
          clientKeyPair: { publicKey: kp.identity.publicKey, secretKey: kp.secretKey },
          hostPublicKey: Uint8Array.from(Buffer.from(parsed.hostPublicKeyHex, 'hex')),
          priorityOrder,
          lan: { endpointUrl: status.lanEndpointUrl! },
          relay: { relayUrl, roomId: status.relayRoomId! },
        })
        await cli.connect()
        const pairing = await bridge.issuePairingDescriptor()
        const cand = await cli.request('pairing.request', {
          token: pairing.descriptor.bootstrapToken,
          displayName: name,
        })
        await bridge.pairingCoordinator.confirmPairing({
          candidateId: cand.candidateId,
          grantedCapabilities: cand.maxAllowedCapabilities,
        })
        cli.close()
        await cli.connect()
        return cli
      }

      const lanClient = await makePairedClient('LAN Phone', ['lan'])
      const relayClient = await makePairedClient('Relay Tablet', ['relay'])

      const lanFrames: any[] = []
      const relayFrames: any[] = []
      lanClient.onEvent((ev) => lanFrames.push(ev))
      relayClient.onEvent((ev) => relayFrames.push(ev))

      // Attach on LAN and emit one event
      await lanClient.request('session.attach', { sessionId })
      agent.emitAssistantDelta('BEFORE_RESET')
      await new Promise((r) => setTimeout(r, 40))
      expect(
        lanFrames.some(
          (f) => f?.type === 'stream.event' && f?.event?.data?.chunk?.text === 'BEFORE_RESET',
        ),
      ).toBe(true)

      // Trigger stream.reset via operator control server -> verify both LAN and Relay receive it
      const resetRes = await fetch(`${control.url}/sessions/reset`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${control.controlToken}`,
        },
        body: JSON.stringify({ sessionId, reason: 'history-compacted' }),
      })
      expect(resetRes.status).toBe(200)

      await new Promise((r) => setTimeout(r, 50))
      expect(
        lanFrames.some(
          (f) => f?.type === 'stream.reset' && f?.sessionId === sessionId && f?.reason === 'history-compacted',
        ),
      ).toBe(true)
      expect(
        relayFrames.some(
          (f) => f?.type === 'stream.reset' && f?.sessionId === sessionId && f?.reason === 'history-compacted',
        ),
      ).toBe(true)

      // New event after reset still streams monotonically and attach returns window-exceeded/new events cleanly
      agent.emitAssistantDelta('AFTER_RESET')
      await new Promise((r) => setTimeout(r, 40))
      expect(
        lanFrames.some(
          (f) => f?.type === 'stream.event' && f?.event?.data?.chunk?.text === 'AFTER_RESET',
        ),
      ).toBe(true)

      // Live revoke LAN client -> encrypted peer.revoked arrives before socket teardown
      await bridge.revokeDevice(lanClient.deviceId)
      await new Promise((r) => setTimeout(r, 80))
      expect(lanFrames.some((f) => f?.type === 'peer.revoked')).toBe(true)
      expect(lanClient.isRevoked()).toBe(true)
      expect(lanClient.isOpen()).toBe(false)

      // Live revoke Relay client -> encrypted peer.revoked arrives through blind relay before kick
      await bridge.revokeDevice(relayClient.deviceId)
      await new Promise((r) => setTimeout(r, 120))
      expect(relayFrames.some((f) => f?.type === 'peer.revoked')).toBe(true)
      expect(relayClient.isRevoked()).toBe(true)
      expect(relayClient.isOpen()).toBe(false)

      // Offline revoked client reconnectWithBackoff fails fast on attempt 1 without waiting through backoff
      const startedAt = Date.now()
      await expect(
        lanClient.reconnectWithBackoff({
          maxAttempts: 4,
          initialDelayMs: 500,
          maxDelayMs: 1000,
        }),
      ).rejects.toThrow(/revoked/i)
      expect(Date.now() - startedAt).toBeLessThan(400)
      expect(lanClient.getFailoverHistory().filter((h) => h.status === 'failed').length).toBeGreaterThanOrEqual(1)

      lanClient.close()
      relayClient.close()
    } finally {
      await control.close()
      await bridge.stop()
      await relay.stop()
    }
  })

  it('rejects non-loopback Host headers on createBridgeControlServer and reads only 16KiB header slice of JSONL logs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-host-ctrl-sec-'))
    const dshHome = join(root, 'dsh-home')
    const configDir = join(root, 'remote-cfg')
    const hugeDir = join(dshHome, 'sessions', 's-huge')
    mkdirSync(hugeDir, { recursive: true })
    const firstLine = JSON.stringify({ id: 's-huge', meta: { cwd: '/workspace/huge-repo' } })
    writeFileSync(
      join(hugeDir, 'session.jsonl'),
      `${firstLine}\n${'x'.repeat(256 * 1024)}\n`,
      'utf8',
    )

    const ctx = new FakeRootContext()
    const bridge = new OfficialHostCordisBridge({
      ctx,
      configDir,
      dshHome,
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
    })
    await bridge.start()
    const control = await createBridgeControlServer(bridge)

    try {
      const refs = listOfficialSessionRefsFromRoot(join(dshHome, 'sessions'))
      expect(refs).toEqual([{ id: 's-huge', title: '/workspace/huge-repo' }])

      const port = Number(new URL(control.url).port)
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: '/status',
            method: 'GET',
            headers: { Host: 'evil.example:8080' },
          },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.on('error', reject)
        req.end()
      })
      expect(status).toBe(403)
    } finally {
      await control.close()
      await bridge.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
