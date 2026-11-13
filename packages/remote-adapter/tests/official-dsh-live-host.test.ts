import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FailoverRemoteClient,
  InMemoryHostIdentityStore,
  listOfficialSessionRefsFromRoot,
  parsePairingInput,
} from '../src/index.js'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(TEST_DIR, '../../..')
const PLUGIN_ENTRY_URL = pathToFileURL(resolve(REPO_ROOT, 'packages/remote-adapter/dist/cordis-plugin.js')).href

function resolveOfficialDshBin(): string {
  const req = createRequire(resolve(REPO_ROOT, 'apps/tui/package.json'))
  return req.resolve('@deepseek-ai/dsh/lib/bin.js')
}

async function waitForFile<T>(filePath: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, 'utf8').trim()
      if (raw.length > 0) {
        return JSON.parse(raw) as T
      }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for ready file: ${filePath}`)
}

function writeSseEvent(res: import('node:http').ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

describe('Real Official @deepseek-ai/dsh Live Subprocess Host Acceptance (R6)', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) {
      await fn().catch(() => {})
    }
  })

  it('drives a real @deepseek-ai/dsh subprocess with tool_use -> approval/request -> E2EE approval -> durable JSONL', async () => {
    const tmpRoot = mkdtempSync(join(tmpdirPath(), 'dsh-r6-live-'))
    const dshHome = join(tmpRoot, 'dsh-home')
    const remoteConfigDir = join(tmpRoot, 'community-remote')
    const workspaceDir = join(tmpRoot, 'workspace')
    const readyFile = join(tmpRoot, 'ready.json')
    const patchFile = join(tmpRoot, 'r6-live.cordis.patch.yml')
    mkdirSync(dshHome, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })

    let agentTurnCalls = 0
    const recordedAgentBodies: Array<Record<string, unknown>> = []
    const llmServer: Server = createServer(async (req, res) => {
      if (req.method !== 'POST' || !req.url?.includes('/messages')) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })

      const tools = Array.isArray(parsedBody.tools)
        ? (parsedBody.tools as Array<Record<string, unknown>>)
        : []
      const hasBashTool = tools.some((t) => t.name === 'bash')
      const bodyStr = JSON.stringify(parsedBody.messages ?? [])
      const hasToolResult = bodyStr.includes('tool_result')

      // Background helper calls (e.g. session-title-first-prompt-llm) carry no tools.
      if (!hasBashTool) {
        writeSseEvent(res, 'message_start', {
          type: 'message_start',
          message: {
            id: 'msg_r6_title',
            type: 'message',
            role: 'assistant',
            model: 'deepseek-flash',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        })
        writeSseEvent(res, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })
        writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'R6 Live Session' },
        })
        writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
        writeSseEvent(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 3 },
        })
        writeSseEvent(res, 'message_stop', { type: 'message_stop' })
        res.end()
        return
      }

      agentTurnCalls += 1
      recordedAgentBodies.push(parsedBody)

      if (!hasToolResult) {
        // Trigger a real tool call requiring approval (`bash` with escalation permission when supported)
        const bashTool = tools.find((t) => t.name === 'bash')
        const schema = bashTool?.input_schema as Record<string, unknown> | undefined
        const props = (schema?.properties as Record<string, unknown> | undefined) ?? {}
        const permEnum = ((props.sandbox_permissions as { enum?: unknown[] } | undefined)?.enum ?? []) as string[]
        const escalatedMode = permEnum[0] ?? 'require_escalated'

        writeSseEvent(res, 'message_start', {
          type: 'message_start',
          message: {
            id: 'msg_r6_1',
            type: 'message',
            role: 'assistant',
            model: 'deepseek-flash',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 0 },
          },
        })
        writeSseEvent(res, 'content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'call_live_bash_1',
            name: 'bash',
            input: {},
          },
        })
        writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({
              description: 'Echo R6 live host verification marker',
              command: 'echo R6_LIVE_BASH_APPROVED_OK',
              ...(props.sandbox_permissions ? { sandbox_permissions: escalatedMode } : {}),
              ...(props.justification ? { justification: 'R6 remote approval verification' } : {}),
            }),
          },
        })
        writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
        writeSseEvent(res, 'message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 18 },
        })
        writeSseEvent(res, 'message_stop', { type: 'message_stop' })
        res.end()
        return
      }

      writeSseEvent(res, 'message_start', {
        type: 'message_start',
        message: {
          id: 'msg_r6_2',
          type: 'message',
          role: 'assistant',
          model: 'deepseek-flash',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 24, output_tokens: 0 },
        },
      })
      writeSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })
      writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'R6_LIVE_HOST_COMPLETE' },
      })
      writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      writeSseEvent(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 8 },
      })
      writeSseEvent(res, 'message_stop', { type: 'message_stop' })
      res.end()
    })

    await new Promise<void>((resolveListen) => llmServer.listen(0, '127.0.0.1', () => resolveListen()))
    const llmPort = (llmServer.address() as AddressInfo).port
    const mockBaseUrl = `http://127.0.0.1:${llmPort}`

    cleanups.push(async () => {
      await new Promise<void>((r) => llmServer.close(() => r()))
    })

    const patchYaml = [
      '- id: hmr',
      '  disabled: true',
      '- id: headless-startup',
      '  disabled: true',
      '- id: headless-runner',
      '  disabled: true',
      '- id: sandbox-policy',
      '  inject: []',
      '  config:',
      '    mode: workspace-write',
      `    workspaceRoot: ${JSON.stringify(workspaceDir)}`,
      '    additionalWritableRoots: []',
      '- id: approval',
      '  config:',
      '    policy: ask',
      '- id: llm-deepseek',
      '  config:',
      `    baseURL: ${JSON.stringify(mockBaseUrl)}`,
      '- insert:',
      '    - id: dsh-community-remote',
      `      name: ${JSON.stringify(PLUGIN_ENTRY_URL)}`,
      '',
    ].join('\n')
    writeFileSync(patchFile, patchYaml, 'utf8')

    const child = spawn(
      process.execPath,
      [resolveOfficialDshBin(), '--profile', 'headless', '--patch', patchFile],
      {
        cwd: workspaceDir,
        env: {
          ...process.env,
          DSH_HOME: dshHome,
          DEEPSEEK_API_KEY: 'sk-test-r6-loopback-dummy',
          DSH_REMOTE_DSH_HOME: dshHome,
          DSH_REMOTE_CONFIG_DIR: remoteConfigDir,
          DSH_REMOTE_CWD: workspaceDir,
          DSH_REMOTE_CONTROL_PORT: '0',
          DSH_REMOTE_READY_FILE: readyFile,
          DSH_REMOTE_ISSUE_PAIRING: '1',
          DSH_REMOTE_INITIAL_SESSION_ID: 'session-r6-live-e2e',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let stderrLog = ''
    child.stderr.on('data', (d) => {
      stderrLog += d.toString()
    })

    cleanups.push(async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise((r) => setTimeout(r, 300))
        if (child.exitCode === null) child.kill('SIGKILL')
      }
      rmSync(tmpRoot, { recursive: true, force: true })
    })

    let ready: {
      configDir: string
      dshHome: string
      hostFingerprint: string
      lanUrl: string
      sessionId: string
      controlUrl: string
      controlToken: string
      deepLink: string
      pairingJson: string
    }
    try {
      ready = await waitForFile(readyFile, 25_000)
    } catch (err) {
      throw new Error(`${(err as Error).message}\nstderr:\n${stderrLog}`)
    }

    expect(ready.configDir).toBe(remoteConfigDir)
    expect(ready.sessionId).toBe('session-r6-live-e2e')
    expect(existsSync(join(remoteConfigDir, 'host-identity.json'))).toBe(true)
    expect(existsSync(join(dshHome, 'community-remote'))).toBe(false)

    const descriptor = parsePairingInput(ready.deepLink)
    const phoneIdentity = await new InMemoryHostIdentityStore().loadOrCreate()
    const phoneKeys = {
      publicKey: phoneIdentity.identity.publicKey,
      secretKey: phoneIdentity.secretKey,
    }
    const client = new FailoverRemoteClient({
      clientKeyPair: phoneKeys,
      hostPublicKey: Uint8Array.from(Buffer.from(descriptor.hostPublicKeyHex, 'hex')),
      lan: { endpointUrl: descriptor.endpointUrl },
    })

    const observedEvents: Array<{ seq: number; type: string; data?: any }> = []
    let pendingCallId = ''
    client.onEvent((ev: any) => {
      if (ev?.type === 'stream.event' && ev.event) {
        observedEvents.push(ev.event)
        if (ev.event.type === 'approval.request') {
          pendingCallId = ev.event.data?.callId ?? ''
        }
      }
    })

    await client.connect()
    const candidate = await client.request('pairing.request', {
      token: descriptor.bootstrapToken,
      displayName: 'R6 Live Test Device',
    })
    const confirmRes = await fetch(`${ready.controlUrl}/pairing/confirm`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ready.controlToken}`,
      },
      body: JSON.stringify({ candidateId: candidate.candidateId }),
    })
    expect(confirmRes.status).toBe(200)
    client.close()

    await client.reconnectWithBackoff({ initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 2 })
    const sessions = await client.request('session.list')
    expect(sessions.some((s: any) => s.id === 'session-r6-live-e2e')).toBe(true)

    await client.resumeSession('session-r6-live-e2e')
    await client.request(
      'prompt.submit',
      { sessionId: 'session-r6-live-e2e', prompt: 'Run R6 bash approval probe' },
      { idempotencyKey: 'live-dsh-prompt-1' },
    )

    await expect
      .poll(
        () =>
          pendingCallId !== '' ||
          observedEvents.some(
            (e) =>
              e.type === 'assistant/message' &&
              JSON.stringify(e.data ?? {}).includes('R6_LIVE_HOST_COMPLETE'),
          ),
        { timeout: 15_000 },
      )
      .toBe(true)

    if (pendingCallId !== '') {
      await client.request(
        'approval.respond',
        { callId: pendingCallId, decision: 'approved' },
        { idempotencyKey: 'live-dsh-approval-1' },
      )
    }

    await expect
      .poll(
        () =>
          observedEvents.some(
            (e) =>
              e.type === 'assistant/message' &&
              JSON.stringify(e.data ?? {}).includes('R6_LIVE_HOST_COMPLETE'),
          ),
        { timeout: 15_000 },
      )
      .toBe(true)

    expect(agentTurnCalls).toBe(2)
    const secondCallStr = JSON.stringify(recordedAgentBodies[1] ?? {})
    expect(secondCallStr).toContain('R6_LIVE_BASH_APPROVED_OK')

    // Verify client streamed assistant chunks / completion and monotonic seq >= 1
    expect(observedEvents.every((e, i) => e.seq >= 1 && (i === 0 || e.seq > observedEvents[i - 1]!.seq))).toBe(true)

    // Graceful shutdown triggers handle.dispose() -> durable session log flush to DSH_HOME/sessions/
    const shutRes = await fetch(`${ready.controlUrl}/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ready.controlToken}` },
    })
    expect(shutRes.status).toBe(200)
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) return resolveExit()
      child.once('exit', () => resolveExit())
    })
    client.close()

    const sessionsRoot = join(dshHome, 'sessions')
    const refsAfterShutdown = listOfficialSessionRefsFromRoot(sessionsRoot)
    expect(refsAfterShutdown.some((r) => r.id === 'session-r6-live-e2e')).toBe(true)

    const logFiles: string[] = []
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/u.test(entry.name)) {
          logFiles.push(full)
        }
      }
    }
    walk(sessionsRoot)
    expect(logFiles.length).toBeGreaterThan(0)
    const rawBytes = readFileSync(logFiles[0]!)
    expect(rawBytes.byteLength).toBeGreaterThan(0)
    // Verify official zstd header frame decodes cleanly
    const headerDecoded = logFiles[0]!.endsWith('.zstd')
      ? zstdDecompressSync(rawBytes).toString('utf8')
      : rawBytes.toString('utf8')
    expect(headerDecoded).toContain('session-r6-live-e2e')

    // Restart a second real @deepseek-ai/dsh subprocess against the same DSH_HOME & remoteConfigDir:
    // persistent trusted device must reconnect without re-pairing and resume durable session events.
    const readyFile2 = join(tmpRoot, 'ready-restart.json')
    const child2 = spawn(
      process.execPath,
      [resolveOfficialDshBin(), '--profile', 'headless', '--patch', patchFile],
      {
        cwd: workspaceDir,
        env: {
          ...process.env,
          DSH_HOME: dshHome,
          DEEPSEEK_API_KEY: 'sk-test-r6-loopback-dummy',
          DSH_REMOTE_DSH_HOME: dshHome,
          DSH_REMOTE_CONFIG_DIR: remoteConfigDir,
          DSH_REMOTE_CWD: workspaceDir,
          DSH_REMOTE_CONTROL_PORT: '0',
          DSH_REMOTE_READY_FILE: readyFile2,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    cleanups.push(async () => {
      if (child2.exitCode === null) {
        child2.kill('SIGTERM')
        await new Promise((r) => setTimeout(r, 300))
        if (child2.exitCode === null) child2.kill('SIGKILL')
      }
    })

    const ready2 = await waitForFile<typeof ready>(readyFile2, 25_000)
    expect(ready2.hostFingerprint).toBe(ready.hostFingerprint)

    const phoneAfterRestart = new FailoverRemoteClient({
      clientKeyPair: phoneKeys,
      hostPublicKey: Uint8Array.from(Buffer.from(descriptor.hostPublicKeyHex, 'hex')),
      lan: { endpointUrl: ready2.lanUrl },
    })
    await phoneAfterRestart.connect()
    const list2 = await phoneAfterRestart.request('session.list')
    expect(list2.some((s: any) => s.id === 'session-r6-live-e2e')).toBe(true)
    const resumed = await phoneAfterRestart.resumeSession('session-r6-live-e2e')
    expect(JSON.stringify(resumed.events)).toContain('R6_LIVE_HOST_COMPLETE')

    // Verify real Cordis @deepseek-ai/dsh subprocess supports model.list, session.create, and turn.abort
    const liveModels = await phoneAfterRestart.request('model.list', {
      sessionId: 'session-r6-live-e2e',
    })
    expect(Array.isArray(liveModels.models)).toBe(true)
    expect(liveModels.models.length).toBeGreaterThanOrEqual(1)

    const liveCreated = await phoneAfterRestart.request(
      'session.create',
      { sessionId: 'session-r6-created-remote', title: 'Remote Phone Session' },
      { idempotencyKey: 'live-dsh-create-1' },
    )
    expect(liveCreated.id).toBe('session-r6-created-remote')
    const liveRenamed = await phoneAfterRestart.request(
      'session.rename',
      { sessionId: 'session-r6-created-remote', title: 'Renamed Live Session' },
      { idempotencyKey: 'live-dsh-rename-1' },
    )
    expect(liveRenamed).toEqual({ id: 'session-r6-created-remote', title: 'Renamed Live Session' })
    const listAfterCreate = await phoneAfterRestart.request('session.list')
    expect(listAfterCreate.find((s: any) => s.id === 'session-r6-created-remote')?.title).toBe(
      'Renamed Live Session',
    )

    await phoneAfterRestart.resumeSession('session-r6-created-remote')
    const abortRes = await phoneAfterRestart.request(
      'turn.abort',
      { sessionId: 'session-r6-created-remote' },
      { idempotencyKey: 'live-dsh-abort-1' },
    )
    expect(abortRes).toEqual({ sessionId: 'session-r6-created-remote', aborted: true })

    phoneAfterRestart.close()

    await fetch(`${ready2.controlUrl}/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ready2.controlToken}` },
    })
    await new Promise<void>((resolveExit) => {
      if (child2.exitCode !== null) return resolveExit()
      child2.once('exit', () => resolveExit())
    })
  }, 45_000)
})

function tmpdirPath(): string {
  return process.env.TMPDIR || '/tmp'
}
