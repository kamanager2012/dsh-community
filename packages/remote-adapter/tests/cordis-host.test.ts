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
  public savedImages: Array<{ mediaType: string; bytesLength: number; name?: string }> = []

  readonly agentDefaultModel = {
    currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
  }

  readonly attachments = {
    saveImage: async (input: { readonly mediaType: string; readonly bytes: Uint8Array; readonly name?: string }) => {
      this.savedImages.push({
        mediaType: input.mediaType,
        bytesLength: input.bytes.byteLength,
        ...(input.name !== undefined ? { name: input.name } : {}),
      })
      return { id: `img-${this.savedImages.length}`, mediaType: input.mediaType, bytes: input.bytes.byteLength }
    },
  }

  readonly llm = {
    listProviders: () => [
      { id: 'deepseek-official', name: 'DeepSeek Official' },
    ],
    listModels: async (_provider: string) => [
      { id: 'deepseek-flash', name: 'DeepSeek Chat', description: 'Fast general model', inputModalities: ['text', 'image'] },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', description: 'Reasoning model', inputModalities: ['text'] },
    ],
    resolveModel: async (_provider: string, model: string) => {
      if (model === 'deepseek-reasoner') {
        return {
          inputModalities: ['text'],
          context: { contextWindow: 131_072 },
          reasoning: {
            defaultEffort: 'medium',
            efforts: [
              { id: 'low', name: 'Low', description: 'Fast answers' },
              { id: 'medium', name: 'Medium', description: 'Balanced reasoning' },
              { id: 'high', name: 'High', description: 'Deep reasoning' },
            ],
          },
        }
      }
      return {
        inputModalities: ['text', 'image'],
        context: { contextWindow: 65_536 },
      }
    },
    resolveCallConfig: async (config: { readonly provider: string; readonly model: string }) => {
      if (
        config.provider !== 'deepseek-official' ||
        (config.model !== 'deepseek-flash' && config.model !== 'deepseek-reasoner')
      ) {
        throw new Error(`unknown model ${config.provider}/${config.model}`)
      }
      return config
    },
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
  readonly steers: Array<Record<string, unknown>> = []
  readonly cancellations: Array<{ cause: unknown; options?: unknown }> = []
  private currentModel: { provider: string; model: string; reasoningEffort?: string } = {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  }
  readonly model = {
    current: () => ({ ...this.currentModel }),
    select: (selection: { provider: string; model: string; reasoningEffort?: string }) => {
      this.currentModel = { ...selection }
    },
  }

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

  steer(message: Record<string, unknown>): void {
    this.steers.push(message)
    queueMicrotask(() => {
      void this.root.followupHandler?.(this, message, this.root)
    })
  }

  cancel(cause: unknown, options?: unknown): void {
    this.cancellations.push({ cause, options })
    this.ctx.emit('agent/status', { agent: this, status: 'idle' })
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

  it('supports session.create, turn.abort, prompt steer mode, model.list/select, and agent/status with capability gates', async () => {
    const root = mkTempRoot()
    const dshHome = join(root, 'dsh-home')
    const configDir = join(root, 'remote-cfg')
    const ctx = new FakeRootContext()
    let pendingApprovalOutcome: string | undefined

    ctx.followupHandler = async (agent, message, rootCtx) => {
      agent.ctx.emit('agent/status', { agent, status: 'running' })
      const content = Array.isArray(message.content) ? message.content : []
      const text = String((content[0] as { text?: string } | undefined)?.text ?? '')
      if (text === 'WAIT_APPROVAL') {
        pendingApprovalOutcome = await rootCtx.dispatchWaterfall(
          'approval/request',
          { agent, callId: 'call-abort-1', toolName: 'bash', reason: 'long command' },
          async () => 'allowed-once',
        )
      }
    }

    const bridge = new OfficialHostCordisBridge({
      ctx,
      configDir,
      dshHome,
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
    })
    await bridge.start()

    try {
      const pairing = await bridge.issuePairingDescriptor()
      const parsed = parsePairingInput(pairing.deepLink)
      const clientIdentity = await new InMemoryHostIdentityStore().loadOrCreate()
      const client = new FailoverRemoteClient({
        clientKeyPair: {
          publicKey: clientIdentity.identity.publicKey,
          secretKey: clientIdentity.secretKey,
        },
        hostPublicKey: Uint8Array.from(Buffer.from(parsed.hostPublicKeyHex, 'hex')),
        lan: { endpointUrl: parsed.endpointUrl },
      })

      const streamEvents: Array<{ seq: number; type: string; data?: any }> = []
      client.onEvent((ev: any) => {
        if (ev?.type === 'stream.event' && ev.event) {
          streamEvents.push(ev.event)
        }
      })

      await client.connect()
      const candidate = await client.request('pairing.request', {
        token: parsed.bootstrapToken,
        displayName: 'Pixel Phone',
      })
      await bridge.pairingCoordinator.confirmPairing({
        candidateId: candidate.candidateId,
        grantedCapabilities: ['observe', 'prompt', 'approve', 'answer-question'],
      })
      client.close()
      await client.reconnectWithBackoff({ initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 2 })

      // Idempotent remote session.create
      const created1 = await client.request(
        'session.create',
        { sessionId: 's-remote-new', title: 'Mobile Thread' },
        { idempotencyKey: 'create-key-1' },
      )
      const created2 = await client.request(
        'session.create',
        { sessionId: 's-remote-new', title: 'Mobile Thread' },
        { idempotencyKey: 'create-key-1' },
      )
      expect(created1).toEqual({ id: 's-remote-new', title: 'Mobile Thread' })
      expect(created2).toEqual(created1)

      const sessions = await client.request('session.list')
      expect(sessions.some((s: any) => s.id === 's-remote-new')).toBe(true)

      await client.resumeSession('s-remote-new')

      // Model catalog & switching
      const catalog = await client.request('model.list', { sessionId: 's-remote-new' })
      expect(catalog.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
      expect(catalog.models).toHaveLength(2)

      await expect(
        client.request(
          'model.select',
          {
            sessionId: 's-remote-new',
            provider: 'deepseek-official',
            model: 'does-not-exist',
          },
          { idempotencyKey: 'model-invalid-1' },
        ),
      ).rejects.toThrow(/unknown model/i)

      const selected = await client.request(
        'model.select',
        {
          sessionId: 's-remote-new',
          provider: 'deepseek-official',
          model: 'deepseek-reasoner',
        },
        { idempotencyKey: 'model-valid-1' },
      )
      expect(selected.selection).toEqual({
        provider: 'deepseek-official',
        model: 'deepseek-reasoner',
      })

      // Steer mode hits agent.steer(message)
      await client.request(
        'prompt.submit',
        { sessionId: 's-remote-new', prompt: 'STEER_ME', mode: 'steer' },
        { idempotencyKey: 'steer-1' },
      )
      const fakeAgent = ctx.agents.get('s-remote-new')! as FakeAgent
      expect(fakeAgent.steers).toHaveLength(1)

      // Blocking turn approval -> turn.abort cancels agent & clears pending approval cleanly
      await client.request(
        'prompt.submit',
        { sessionId: 's-remote-new', prompt: 'WAIT_APPROVAL' },
        { idempotencyKey: 'wait-approval-1' },
      )
      await expect
        .poll(() => streamEvents.some((e) => e.type === 'approval.request'))
        .toBe(true)
      expect(streamEvents.some((e) => e.type === 'agent/status' && e.data?.status === 'running')).toBe(true)

      const aborted = await client.request(
        'turn.abort',
        { sessionId: 's-remote-new' },
        { idempotencyKey: 'abort-1' },
      )
      expect(aborted).toEqual({ sessionId: 's-remote-new', aborted: true })
      expect(fakeAgent.cancellations).toEqual([{ cause: { kind: 'user' }, options: undefined }])
      expect(pendingApprovalOutcome).toBe('cancelled')
      await expect
        .poll(() =>
          streamEvents.some(
            (e) => e.type === 'approval.resolved' && e.data?.decision === 'cancelled',
          ) &&
          streamEvents.some((e) => e.type === 'agent/status' && e.data?.status === 'idle'),
        )
        .toBe(true)

      // Read-only observe device must be denied session.create, turn.abort, and model.select
      const observerIdentity = await new InMemoryHostIdentityStore().loadOrCreate()
      const pairingObs = await bridge.issuePairingDescriptor({
        allowedCapabilities: ['observe'],
      })
      const obsParsed = parsePairingInput(pairingObs.deepLink)
      const obsClient = new FailoverRemoteClient({
        clientKeyPair: {
          publicKey: observerIdentity.identity.publicKey,
          secretKey: observerIdentity.secretKey,
        },
        hostPublicKey: Uint8Array.from(Buffer.from(obsParsed.hostPublicKeyHex, 'hex')),
        lan: { endpointUrl: obsParsed.endpointUrl },
      })
      await obsClient.connect()
      const obsCand = await obsClient.request('pairing.request', {
        token: obsParsed.bootstrapToken,
        displayName: 'Read Only Watch',
      })
      await bridge.pairingCoordinator.confirmPairing({
        candidateId: obsCand.candidateId,
        grantedCapabilities: ['observe'],
      })
      obsClient.close()
      await obsClient.reconnectWithBackoff({ initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 2 })

      expect(Array.isArray((await obsClient.request('model.list')).models)).toBe(true)
      await expect(
        obsClient.request(
          'session.create',
          { sessionId: 'forbidden-create' },
          { idempotencyKey: 'obs-create-1' },
        ),
      ).rejects.toThrow()
      await expect(
        obsClient.request(
          'turn.abort',
          { sessionId: 's-remote-new' },
          { idempotencyKey: 'obs-abort-1' },
        ),
      ).rejects.toThrow()
      await expect(
        obsClient.request(
          'model.select',
          {
            sessionId: 's-remote-new',
            provider: 'deepseek-official',
            model: 'deepseek-flash',
          },
          { idempotencyKey: 'obs-model-1' },
        ),
      ).rejects.toThrow()

      client.close()
      obsClient.close()
    } finally {
      await bridge.stop()
    }
  })

  it('supports session.rename, persisted session/title lookup, model reasoningEfforts/vision discovery, and bounded image prompt.submit', async () => {
    const root = mkTempRoot()
    const dshHome = join(root, 'dsh-home')
    const configDir = join(root, 'remote-cfg')
    const persistedSid = 's-persisted-titled'
    mkdirSync(join(dshHome, 'sessions', persistedSid), { recursive: true })
    writeFileSync(
      join(dshHome, 'sessions', persistedSid, 'session.jsonl'),
      [
        JSON.stringify({ id: persistedSid, meta: { cwd: '/workspace/app' } }),
        JSON.stringify({ seq: 1, type: 'session/title', data: { title: 'Persisted Custom Title', source: 'user' } }),
      ].join('\n') + '\n',
      'utf8',
    )

    const ctx = new FakeRootContext()
    const receivedMessages: Record<string, unknown>[] = []
    ctx.followupHandler = (_agent, message) => {
      receivedMessages.push(message)
    }

    const bridge = new OfficialHostCordisBridge({
      ctx,
      configDir,
      dshHome,
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
    })
    await bridge.start()

    try {
      const pairing = await bridge.issuePairingDescriptor()
      const parsed = parsePairingInput(pairing.deepLink)
      const clientIdentity = await new InMemoryHostIdentityStore().loadOrCreate()
      const client = new FailoverRemoteClient({
        clientKeyPair: {
          publicKey: clientIdentity.identity.publicKey,
          secretKey: clientIdentity.secretKey,
        },
        hostPublicKey: Uint8Array.from(Buffer.from(parsed.hostPublicKeyHex, 'hex')),
        lan: { endpointUrl: parsed.endpointUrl },
      })

      const streamEvents: Array<{ seq: number; type: string; data?: any }> = []
      client.onEvent((ev: any) => {
        if (ev?.type === 'stream.event' && ev.event) {
          streamEvents.push(ev.event)
        }
      })

      await client.connect()
      const candidate = await client.request('pairing.request', {
        token: parsed.bootstrapToken,
        displayName: 'Wave2 Phone',
      })
      await bridge.pairingCoordinator.confirmPairing({
        candidateId: candidate.candidateId,
        grantedCapabilities: ['observe', 'prompt', 'approve', 'answer-question'],
      })
      client.close()
      await client.reconnectWithBackoff({ initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 2 })

      const initialSessions = await client.request('session.list')
      expect(initialSessions.find((s: any) => s.id === persistedSid)?.title).toBe('Persisted Custom Title')

      await client.request(
        'session.create',
        { sessionId: 's-wave2-1', title: 'Initial Title' },
        { idempotencyKey: 'wave2-create-1' },
      )
      await client.resumeSession('s-wave2-1')

      const renamed1 = await client.request(
        'session.rename',
        { sessionId: 's-wave2-1', title: 'Refactored Mobile UX' },
        { idempotencyKey: 'wave2-rename-1' },
      )
      const renamed2 = await client.request(
        'session.rename',
        { sessionId: 's-wave2-1', title: 'Refactored Mobile UX' },
        { idempotencyKey: 'wave2-rename-1' },
      )
      expect(renamed1).toEqual({ id: 's-wave2-1', title: 'Refactored Mobile UX' })
      expect(renamed2).toEqual(renamed1)
      await expect
        .poll(() =>
          streamEvents.some(
            (e) => e.type === 'session/title' && e.data?.title === 'Refactored Mobile UX',
          ),
        )
        .toBe(true)

      const sessionsAfterRename = await client.request('session.list')
      expect(sessionsAfterRename.find((s: any) => s.id === 's-wave2-1')?.title).toBe('Refactored Mobile UX')

      const models = await client.request('model.list', { sessionId: 's-wave2-1' })
      const flash = models.models.find((m: any) => m.model === 'deepseek-flash')
      const reasoner = models.models.find((m: any) => m.model === 'deepseek-reasoner')
      expect(flash?.supportsImageInput).toBe(true)
      expect(flash?.contextWindow).toBe(65_536)
      expect(reasoner?.supportsImageInput).toBe(false)
      expect(reasoner?.defaultReasoningEffort).toBe('medium')
      expect(reasoner?.reasoningEfforts?.map((e: any) => e.id)).toEqual(['low', 'medium', 'high'])

      const selectedReasoner = await client.request(
        'model.select',
        {
          sessionId: 's-wave2-1',
          provider: 'deepseek-official',
          model: 'deepseek-reasoner',
          reasoningEffort: 'high',
        },
        { idempotencyKey: 'wave2-select-1' },
      )
      expect(selectedReasoner.selection).toEqual({
        provider: 'deepseek-official',
        model: 'deepseek-reasoner',
        reasoningEffort: 'high',
      })

      // Valid bounded PNG attachment routes through ctx.attachments.saveImage
      const samplePngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
      await client.request(
        'prompt.submit',
        {
          sessionId: 's-wave2-1',
          prompt: 'Describe this screenshot',
          attachments: [
            {
              type: 'image',
              mediaType: 'image/png',
              dataBase64: samplePngBase64,
              name: 'screen.png',
            },
          ],
        },
        { idempotencyKey: 'wave2-img-1' },
      )
      expect(ctx.savedImages).toHaveLength(1)
      expect(ctx.savedImages[0]).toEqual({ mediaType: 'image/png', bytesLength: 8, name: 'screen.png' })
      expect(receivedMessages[0]?.content).toEqual([
        { type: 'text', text: 'Describe this screenshot' },
        { type: 'image', attachment: { id: 'img-1', mediaType: 'image/png', bytes: 8 } },
      ])

      // Oversized (> 32 KiB decoded) and SVG image mediaTypes are rejected fail-closed
      const oversizedB64 = Buffer.alloc(32_769, 0x41).toString('base64')
      await expect(
        client.request(
          'prompt.submit',
          {
            sessionId: 's-wave2-1',
            prompt: 'Too big',
            attachments: [{ type: 'image', mediaType: 'image/png', dataBase64: oversizedB64 }],
          },
          { idempotencyKey: 'wave2-img-oversize' },
        ),
      ).rejects.toThrow()
      await expect(
        client.request(
          'prompt.submit',
          {
            sessionId: 's-wave2-1',
            prompt: 'Bad mime',
            attachments: [{ type: 'image', mediaType: 'image/svg+xml' as any, dataBase64: samplePngBase64 }],
          },
          { idempotencyKey: 'wave2-img-svg' },
        ),
      ).rejects.toThrow()

      // Read-only observe device is denied session.rename
      const obsIdentity = await new InMemoryHostIdentityStore().loadOrCreate()
      const obsPair = await bridge.issuePairingDescriptor({ allowedCapabilities: ['observe'] })
      const obsParsed = parsePairingInput(obsPair.deepLink)
      const obsClient = new FailoverRemoteClient({
        clientKeyPair: { publicKey: obsIdentity.identity.publicKey, secretKey: obsIdentity.secretKey },
        hostPublicKey: Uint8Array.from(Buffer.from(obsParsed.hostPublicKeyHex, 'hex')),
        lan: { endpointUrl: obsParsed.endpointUrl },
      })
      await obsClient.connect()
      const obsCand = await obsClient.request('pairing.request', {
        token: obsParsed.bootstrapToken,
        displayName: 'Observer Watch',
      })
      await bridge.pairingCoordinator.confirmPairing({
        candidateId: obsCand.candidateId,
        grantedCapabilities: ['observe'],
      })
      obsClient.close()
      await obsClient.reconnectWithBackoff({ initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 2 })
      await expect(
        obsClient.request(
          'session.rename',
          { sessionId: 's-wave2-1', title: 'Unauthorized Rename' },
          { idempotencyKey: 'obs-rename-1' },
        ),
      ).rejects.toThrow()

      client.close()
      obsClient.close()
    } finally {
      await bridge.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
