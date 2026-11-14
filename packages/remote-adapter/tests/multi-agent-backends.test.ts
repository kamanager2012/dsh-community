import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AcpAgentBackend,
  ClaudeAgentBackend,
  CodexAgentBackend,
  FailoverRemoteClient,
  InMemoryHostIdentityStore,
  MultiAgentRemoteHost,
  parsePairingInput,
  RemoteCryptoError,
  RemoteProtocolError,
  sanitizeSubprocessEnv,
} from '../src/index.js'

function writeExecutableScript(filePath: string, body: string): string {
  writeFileSync(filePath, `#!/usr/bin/env node\n${body}\n`, { encoding: 'utf8', mode: 0o755 })
  chmodSync(filePath, 0o755)
  return filePath
}

function makeMockCodexScript(dir: string, envDumpPath: string): string {
  return writeExecutableScript(
    join(dir, 'mock-codex.mjs'),
    `
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.118.0-mock\\n')
  process.exit(0)
}

writeFileSync(${JSON.stringify(envDumpPath)}, JSON.stringify(process.env), 'utf8')

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n')
const threads = new Map()
const pendingServer = new Map()
let reqCounter = 100

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { userAgent: 'codex-mock/1.0' } })
    return
  }
  if (msg.method === 'initialized') return
  if (msg.method === 'model/list') {
    send({
      id: msg.id,
      result: {
        data: [
          { id: 'gpt-5.4', model: 'gpt-5.4', displayName: 'GPT-5.4', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }] },
        ],
        nextCursor: null,
      },
    })
    return
  }
  if (msg.method === 'thread/list') {
    send({
      id: msg.id,
      result: {
        data: [...threads.values()].map((t) => ({ id: t.id, cwd: t.cwd, preview: t.preview, name: t.name, updatedAt: t.updatedAt, turns: [] })),
        nextCursor: null,
      },
    })
    return
  }
  if (msg.method === 'thread/start') {
    const id = 'thr-mock-' + Math.random().toString(16).slice(2, 8)
    const thr = { id, cwd: msg.params?.cwd || process.cwd(), preview: '', name: 'Codex Mock Thread', updatedAt: Math.floor(Date.now() / 1000), turns: [] }
    threads.set(id, thr)
    send({ id: msg.id, result: { thread: { ...thr }, model: msg.params?.model || 'gpt-5.4', modelProvider: 'openai' } })
    return
  }
  if (msg.method === 'thread/resume') {
    const thr = threads.get(msg.params?.threadId)
    if (!thr) {
      send({ id: msg.id, error: { code: -32001, message: 'thread not found' } })
      return
    }
    send({ id: msg.id, result: { thread: { ...thr }, model: 'gpt-5.4', modelProvider: 'openai' } })
    return
  }
  if (msg.method === 'thread/read') {
    const thr = threads.get(msg.params?.threadId)
    if (!thr) {
      send({ id: msg.id, error: { code: -32001, message: 'thread not found' } })
      return
    }
    send({ id: msg.id, result: { thread: { ...thr } } })
    return
  }
  if (msg.method === 'thread/name/set') {
    const thr = threads.get(msg.params?.threadId)
    if (thr) thr.name = msg.params?.name
    send({ id: msg.id, result: {} })
    return
  }
  if (msg.method === 'turn/start') {
    const threadId = msg.params.threadId
    const thr = threads.get(threadId)
    const promptText = msg.params.input?.[0]?.text || ''
    const turnId = 'turn-1'
    send({ id: msg.id, result: { turn: { id: turnId, items: [], status: 'inProgress', error: null } } })
    send({ method: 'turn/started', params: { threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } } })
    send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'msg-1', delta: 'Codex heard: ' + promptText } })
    if (promptText.includes('ASK_APPROVAL')) {
      const aprId = ++reqCounter
      pendingServer.set(aprId, { kind: 'approval', threadId, turnId, promptText })
      send({ id: aprId, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'cmd-1', command: 'echo ok', reason: 'Run check' } })
      return
    }
    if (thr) {
      thr.turns.push({
        id: turnId,
        status: 'completed',
        error: null,
        items: [
          { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: promptText, text_elements: [] }] },
          { type: 'agentMessage', id: 'a1', text: 'Codex heard: ' + promptText },
        ],
      })
    }
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, items: [], status: 'completed', error: null } } })
    return
  }
  if (msg.method === 'turn/interrupt') {
    send({ id: msg.id, result: {} })
    send({ method: 'turn/completed', params: { threadId: msg.params.threadId, turn: { id: msg.params.turnId, items: [], status: 'interrupted', error: null } } })
    return
  }
  if (msg.id !== undefined && pendingServer.has(msg.id)) {
    const info = pendingServer.get(msg.id)
    pendingServer.delete(msg.id)
    const decision = msg.result?.decision || 'decline'
    send({ method: 'item/agentMessage/delta', params: { threadId: info.threadId, turnId: info.turnId, itemId: 'msg-2', delta: ' [' + decision + ']' } })
    send({ method: 'turn/completed', params: { threadId: info.threadId, turn: { id: info.turnId, items: [], status: 'completed', error: null } } })
  }
})
`,
  )
}

function makeMockClaudeScript(dir: string, envDumpPath: string): string {
  return writeExecutableScript(
    join(dir, 'mock-claude.mjs'),
    `
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.argv.includes('--version')) {
  process.stdout.write('2.1.325-mock (Claude Code)\\n')
  process.exit(0)
}

writeFileSync(${JSON.stringify(envDumpPath)}, JSON.stringify(process.env), 'utf8')

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n')
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
let sawPerm = false

rl.on('line', (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.type === 'user') {
    const text = typeof msg.message?.content === 'string'
      ? msg.message.content
      : (msg.message?.content?.[0]?.text || '')
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Claude saw: ' + text } } })
    if (text.includes('ASK_QUESTION') && !sawPerm) {
      sawPerm = true
      emit({
        type: 'control_request',
        request_id: 'creq-q-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          input: { questions: [{ id: 'q1', header: 'Env', question: 'Which env?', options: [{ label: 'prod' }, { label: 'dev' }] }] },
        },
      })
      return
    }
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Claude saw: ' + text }] } })
    emit({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: {} })
    return
  }
  if (msg.type === 'control_response') {
    const answerText = JSON.stringify(msg.response?.response?.updatedInput?.answers || {})
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' answered:' + answerText } } })
    emit({ type: 'result', subtype: 'success' })
  }
})
`,
  )
}

function makeMockOpenCodeScript(dir: string): string {
  return writeExecutableScript(
    join(dir, 'mock-opencode.mjs'),
    `
import { createInterface } from 'node:readline'

if (process.argv.includes('--version')) {
  process.stdout.write('2.3.0-mock\\n')
  process.exit(0)
}

const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\\n')
const sessions = new Map([['oc-preexisting', { sessionId: 'oc-preexisting', cwd: process.cwd(), title: 'Existing OpenCode', updatedAt: new Date().toISOString() }]])
let permReqId = 500
const pending = new Map()

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') {
    send({
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'OpenCode', version: '2.3.0-mock' },
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
      },
    })
    return
  }
  if (msg.method === 'session/list') {
    send({ id: msg.id, result: { sessions: [...sessions.values()], nextCursor: null } })
    return
  }
  if (msg.method === 'session/new') {
    const sessionId = 'oc-' + Math.random().toString(16).slice(2, 8)
    sessions.set(sessionId, { sessionId, cwd: msg.params?.cwd || process.cwd(), title: 'Fresh OpenCode', updatedAt: new Date().toISOString() })
    send({ id: msg.id, result: { sessionId, models: { availableModels: [{ modelId: 'opencode/big-pickle', name: 'Big Pickle' }] } } })
    return
  }
  if (msg.method === 'session/load') {
    const s = sessions.get(msg.params?.sessionId)
    if (!s) {
      send({ id: msg.id, error: { code: -32001, message: 'session missing' } })
      return
    }
    send({ id: msg.id, result: {} })
    return
  }
  if (msg.method === 'session/prompt') {
    const sessionId = msg.params.sessionId
    const promptText = msg.params.prompt?.[0]?.text || ''
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OpenCode reply: ' + promptText } } } })
    if (promptText.includes('TEST_FS_ESCAPE')) {
      const fsReqId = ++permReqId
      pending.set(fsReqId, { kind: 'fs', promptRpcId: msg.id, sessionId })
      send({ id: fsReqId, method: 'fs/read_text_file', params: { sessionId, path: '/etc/passwd' } })
      return
    }
    send({ id: msg.id, result: { stopReason: 'end_turn' } })
    return
  }
  if (msg.method === 'session/cancel') {
    send({ id: msg.id, result: {} })
    return
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const info = pending.get(msg.id)
    pending.delete(msg.id)
    send({
      method: 'session/update',
      params: {
        sessionId: info.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: msg.error ? ' fs-blocked' : ' fs-allowed' },
        },
      },
    })
    send({ id: info.promptRpcId, result: { stopReason: 'end_turn' } })
  }
})
`,
  )
}

describe('multi-agent control plane backends and standalone host', () => {
  const tempDirs: string[] = []
  const activeClosers: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    while (activeClosers.length > 0) {
      const fn = activeClosers.pop()!
      await Promise.resolve(fn()).catch(() => {})
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('scrubs host remote tokens from child environments', () => {
    const cleaned = sanitizeSubprocessEnv({
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: 'sk-user-keep',
      DSH_REMOTE_CONTROL_TOKEN: 'secret-control',
      DSH_REMOTE_RELAY_HOST_SECRET: 'secret-relay',
      DSH_REMOTE_RELAY_CLIENT_TOKEN: 'secret-relay-client',
      DSH_REMOTE_SIGNALING_HOST_SECRET: 'secret-sig',
      DSH_REMOTE_SIGNALING_JOIN_TOKEN: 'secret-join',
    })
    expect(cleaned.PATH).toBe('/usr/bin')
    expect(cleaned.DEEPSEEK_API_KEY).toBe('sk-user-keep')
    expect(cleaned.DSH_REMOTE_CONTROL_TOKEN).toBeUndefined()
    expect(cleaned.DSH_REMOTE_RELAY_HOST_SECRET).toBeUndefined()
    expect(cleaned.DSH_REMOTE_RELAY_CLIENT_TOKEN).toBeUndefined()
    expect(cleaned.DSH_REMOTE_SIGNALING_HOST_SECRET).toBeUndefined()
    expect(cleaned.DSH_REMOTE_SIGNALING_JOIN_TOKEN).toBeUndefined()
  })

  it('multiplexes Codex, Claude Code, OpenCode ACP, and Git review over E2EE Noise IK + HTTP control server without DEEPSEEK_API_KEY', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-multi-agent-e2e-'))
    tempDirs.push(root)

    const binDir = join(root, 'bin')
    const repoDir = join(root, 'workspace')
    const projectsDir = join(root, 'claude-projects', 'proj-1')
    const dshHome = join(root, 'dsh-home')
    const configDir = join(root, 'remote-config')
    mkdirSync(binDir, { recursive: true })
    mkdirSync(repoDir, { recursive: true })
    mkdirSync(projectsDir, { recursive: true })
    mkdirSync(dshHome, { recursive: true })

    // Init real git repo in workspace for git status/diff tests
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe' })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'pipe' })
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'pipe' })
    writeFileSync(join(repoDir, 'hello.ts'), 'export const hello = "v1"\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' })
    writeFileSync(join(repoDir, 'hello.ts'), 'export const hello = "v2"\n', 'utf8')

    // Pre-existing Claude session JSONL on disk
    const claudeDiskId = 'claude-disk-111'
    writeFileSync(
      join(projectsDir, `${claudeDiskId}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          sessionId: claudeDiskId,
          cwd: repoDir,
          timestamp: '2026-11-14T10:00:00.000Z',
          message: { role: 'user', content: 'Review hello.ts changes' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: claudeDiskId,
          cwd: repoDir,
          timestamp: '2026-11-14T10:00:02.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Found v2 change in hello.ts' }] },
        }),
      ].join('\n') + '\n',
      'utf8',
    )

    const codexEnvDump = join(root, 'codex-env.json')
    const claudeEnvDump = join(root, 'claude-env.json')
    const codexBin = makeMockCodexScript(binDir, codexEnvDump)
    const claudeBin = makeMockClaudeScript(binDir, claudeEnvDump)
    const opencodeBin = makeMockOpenCodeScript(binDir)

    const mockHostEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DEEPSEEK_API_KEY: '',
      DSH_REMOTE_CONTROL_TOKEN: 'host-top-secret-token',
      DSH_REMOTE_RELAY_HOST_SECRET: 'host-relay-secret',
    }

    const codexBackend = new CodexAgentBackend({
      command: codexBin,
      args: [],
      defaultCwd: repoDir,
      env: mockHostEnv,
    })
    const claudeBackend = new ClaudeAgentBackend({
      command: claudeBin,
      defaultCwd: repoDir,
      projectsDir: join(root, 'claude-projects'),
      env: mockHostEnv,
    })
    const opencodeBackend = new AcpAgentBackend({
      engineId: 'opencode',
      displayName: 'OpenCode (ACP)',
      command: opencodeBin,
      args: [],
      defaultCwd: repoDir,
      env: mockHostEnv,
    })

    const host = new MultiAgentRemoteHost({
      backends: [codexBackend, claudeBackend, opencodeBackend],
      defaultEngine: 'codex',
      configDir,
      dshHome,
      cwd: repoDir,
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
      env: mockHostEnv,
    })
    await host.start()
    activeClosers.push(() => host.stop())

    const control = await host.createControlServer({ controlToken: 'test-ctrl-token' })
    activeClosers.push(() => control.close())

    // HTTP Control Server exposes /engines and /git/status and /git/diff
    const enginesHttpRes = await fetch(`${control.url}/engines`, {
      headers: { authorization: `Bearer ${control.controlToken}` },
    })
    expect(enginesHttpRes.status).toBe(200)
    const enginesHttpJson = (await enginesHttpRes.json()) as { engines: Array<{ id: string; available: boolean }> }
    expect(enginesHttpJson.engines.map((e) => e.id)).toEqual(['codex', 'claude', 'opencode'])
    expect(enginesHttpJson.engines.every((e) => e.available)).toBe(true)

    // Pair full-capability client + observe-only client over Noise IK LAN
    const issueRes = await host.issuePairingDescriptor()
    const parsedLink = parsePairingInput(issueRes.deepLink)

    const fullId = await new InMemoryHostIdentityStore().loadOrCreate()
    const fullClient = new FailoverRemoteClient({
      clientKeyPair: { publicKey: fullId.identity.publicKey, secretKey: fullId.secretKey },
      hostPublicKey: Uint8Array.from(Buffer.from(parsedLink.hostPublicKeyHex, 'hex')),
      lan: { endpointUrl: parsedLink.endpointUrl },
    })
    activeClosers.push(() => fullClient.close())

    const eventsBySession = new Map<string, Array<{ seq: number; type: string; data?: any }>>()
    fullClient.onEvent((ev: any) => {
      if (ev?.type === 'stream.event' && typeof ev.sessionId === 'string' && ev.event) {
        const list = eventsBySession.get(ev.sessionId) ?? []
        list.push(ev.event)
        eventsBySession.set(ev.sessionId, list)
      }
    })

    await fullClient.connect()
    const cand1 = await fullClient.request('pairing.request', {
      token: parsedLink.bootstrapToken,
      displayName: 'Test Operator',
    })
    await host.pairingCoordinator.confirmPairing({
      candidateId: cand1.candidateId,
      grantedCapabilities: ['observe', 'prompt', 'approve', 'answer-question'],
    })
    fullClient.close()
    await fullClient.reconnectWithBackoff({ initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 2 })

    // Pair second device with strictly ['observe']
    const obsIssue = await host.issuePairingDescriptor({ allowedCapabilities: ['observe'] })
    const obsLink = parsePairingInput(obsIssue.deepLink)
    const obsId = await new InMemoryHostIdentityStore().loadOrCreate()
    const obsClient = new FailoverRemoteClient({
      clientKeyPair: { publicKey: obsId.identity.publicKey, secretKey: obsId.secretKey },
      hostPublicKey: Uint8Array.from(Buffer.from(obsLink.hostPublicKeyHex, 'hex')),
      lan: { endpointUrl: obsLink.endpointUrl },
    })
    activeClosers.push(() => obsClient.close())
    await obsClient.connect()
    const cand2 = await obsClient.request('pairing.request', {
      token: obsLink.bootstrapToken,
      displayName: 'Read Only Reviewer',
      requestedCapabilities: ['observe'],
    })
    await host.pairingCoordinator.confirmPairing({
      candidateId: cand2.candidateId,
      grantedCapabilities: ['observe'],
    })
    obsClient.close()
    await obsClient.reconnectWithBackoff({ initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 2 })

    // 1. E2EE engine.list & initial multi-engine session.list discovery
    const listedEngines = await fullClient.listEngines()
    expect(listedEngines.map((e) => e.id)).toEqual(['codex', 'claude', 'opencode'])

    const initialSessions = await fullClient.request('session.list')
    const claudeDiscovered = initialSessions.find((s) => s.id === `claude--${claudeDiskId}`)
    expect(claudeDiscovered?.engine).toBe('claude')
    expect(initialSessions.some((s) => s.id === 'opencode--oc-preexisting' && s.engine === 'opencode')).toBe(true)

    // Claude history & search work against disk JSONL
    const claudeHist = await fullClient.request('session.history', { sessionId: `claude--${claudeDiskId}` })
    expect(claudeHist.events.length).toBeGreaterThanOrEqual(2)
    const claudeSearch = await fullClient.request('session.search', { query: 'hello.ts' })
    expect(claudeSearch.hits.some((h) => h.sessionId === `claude--${claudeDiskId}`)).toBe(true)

    // 2. Create and run Codex session with live approval
    const codexSess = await fullClient.createSession({ engine: 'codex', cwd: repoDir, title: 'Codex Session' })
    expect(codexSess.engine).toBe('codex')
    expect(codexSess.id.startsWith('codex--')).toBe(true)
    await fullClient.request('session.attach', { sessionId: codexSess.id })
    await fullClient.request(
      'prompt.submit',
      { sessionId: codexSess.id, prompt: 'ASK_APPROVAL run check' },
      { idempotencyKey: 'codex-followup-1' },
    )

    // Wait for approval.request event over E2EE stream
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 3000
      const timer = setInterval(() => {
        const list = eventsBySession.get(codexSess.id) ?? []
        if (list.some((e) => e.type === 'approval.request')) {
          clearInterval(timer)
          resolve()
        } else if (Date.now() > deadline) {
          clearInterval(timer)
          reject(new Error('timed out waiting for codex approval.request'))
        }
      }, 20)
    })

    const codexEventsBefore = eventsBySession.get(codexSess.id) ?? []
    const aprEvent = codexEventsBefore.find((e) => e.type === 'approval.request')!
    await fullClient.request(
      'approval.respond',
      { callId: aprEvent.data.callId, decision: 'approved' },
      { idempotencyKey: 'codex-apr-1' },
    )

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 3000
      const timer = setInterval(() => {
        const list = eventsBySession.get(codexSess.id) ?? []
        if (list.some((e) => e.type === 'assistant/chunk' && String(e.data?.text ?? '').includes('[accept]'))) {
          clearInterval(timer)
          resolve()
        } else if (Date.now() > deadline) {
          clearInterval(timer)
          reject(new Error('timed out waiting for codex post-approval output'))
        }
      }, 20)
    })

    // 3. Claude Code spawned worker + AskUserQuestion control_request roundtrip
    const claudeSess = await fullClient.createSession({ engine: 'claude', cwd: repoDir, title: 'Claude Session' })
    expect(claudeSess.engine).toBe('claude')
    await fullClient.request('session.attach', { sessionId: claudeSess.id })
    await fullClient.request(
      'prompt.submit',
      { sessionId: claudeSess.id, prompt: 'ASK_QUESTION deploy' },
      { idempotencyKey: 'claude-followup-1' },
    )

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 3000
      const timer = setInterval(() => {
        const list = eventsBySession.get(claudeSess.id) ?? []
        if (list.some((e) => e.type === 'question.request')) {
          clearInterval(timer)
          resolve()
        } else if (Date.now() > deadline) {
          clearInterval(timer)
          reject(new Error('timed out waiting for claude question.request'))
        }
      }, 20)
    })
    const qEvent = (eventsBySession.get(claudeSess.id) ?? []).find((e) => e.type === 'question.request')!
    await fullClient.request(
      'question.respond',
      {
        questionId: qEvent.data.questionId,
        answer: { answers: [{ id: 'q1', selected: ['prod'] }] },
      },
      { idempotencyKey: 'claude-q-1' },
    )

    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 3000
      const timer = setInterval(() => {
        const list = eventsBySession.get(claudeSess.id) ?? []
        if (list.some((e) => e.type === 'assistant/chunk' && String(e.data?.text ?? '').includes('answered:'))) {
          clearInterval(timer)
          resolve()
        } else if (Date.now() > deadline) {
          clearInterval(timer)
          reject(new Error('timed out waiting for claude post-question output'))
        }
      }, 20)
    })

    // 4. OpenCode ACP session + fs/read_text_file escape blocked
    const ocSess = await fullClient.createSession({ engine: 'opencode', cwd: repoDir })
    expect(ocSess.engine).toBe('opencode')
    await fullClient.request('session.attach', { sessionId: ocSess.id })
    await fullClient.request(
      'prompt.submit',
      { sessionId: ocSess.id, prompt: 'TEST_FS_ESCAPE' },
      { idempotencyKey: 'oc-followup-1' },
    )
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 3000
      const timer = setInterval(() => {
        const list = eventsBySession.get(ocSess.id) ?? []
        if (list.some((e) => e.type === 'assistant/chunk' && String(e.data?.text ?? '').includes('fs-blocked'))) {
          clearInterval(timer)
          resolve()
        } else if (Date.now() > deadline) {
          clearInterval(timer)
          reject(new Error('timed out waiting for opencode fs-blocked confirmation'))
        }
      }, 20)
    })

    // 5. Observe-only client CAN inspect git status/diff and engines, CANNOT prompt or createSession
    const obsStatus = await obsClient.getWorkspaceGitStatus(codexSess.id)
    expect(obsStatus.files.some((f) => f.path === 'hello.ts' && f.unstaged)).toBe(true)
    const obsDiff = await obsClient.getWorkspaceGitDiff({ sessionId: codexSess.id, path: 'hello.ts' })
    expect(obsDiff.diff).toContain('+export const hello = "v2"')

    await expect(
      obsClient.createSession({ engine: 'codex', cwd: repoDir }),
    ).rejects.toSatisfy((err: unknown) => err instanceof RemoteProtocolError && err.code === 'CAPABILITY_DENIED')
    await expect(
      obsClient.request('prompt.submit', { sessionId: codexSess.id, prompt: 'blocked' }, { idempotencyKey: 'obs-deny-1' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof RemoteProtocolError && err.code === 'CAPABILITY_DENIED')

    // Rejects path traversal via E2EE RPC too
    await expect(
      obsClient.getWorkspaceGitDiff({ sessionId: codexSess.id, path: '../etc/passwd' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof RemoteProtocolError && err.code === 'INVALID_REQUEST')

    // 6. Control server /git/status works over authenticated localhost HTTP
    const gitHttpRes = await fetch(
      `${control.url}/git/status?sessionId=${encodeURIComponent(codexSess.id)}`,
      { headers: { authorization: `Bearer ${control.controlToken}` } },
    )
    expect(gitHttpRes.status).toBe(200)
    const gitHttpJson = (await gitHttpRes.json()) as { files: Array<{ path: string }> }
    expect(gitHttpJson.files.some((f) => f.path === 'hello.ts')).toBe(true)

    // 7. Verify spawned Codex & Claude child envs never received host control/relay secrets
    const dumpedCodexEnv = JSON.parse(await import('node:fs').then((m) => m.readFileSync(codexEnvDump, 'utf8')))
    const dumpedClaudeEnv = JSON.parse(await import('node:fs').then((m) => m.readFileSync(claudeEnvDump, 'utf8')))
    expect(dumpedCodexEnv.DSH_REMOTE_CONTROL_TOKEN).toBeUndefined()
    expect(dumpedCodexEnv.DSH_REMOTE_RELAY_HOST_SECRET).toBeUndefined()
    expect(dumpedClaudeEnv.DSH_REMOTE_CONTROL_TOKEN).toBeUndefined()
    expect(dumpedClaudeEnv.DSH_REMOTE_RELAY_HOST_SECRET).toBeUndefined()
  })
})
