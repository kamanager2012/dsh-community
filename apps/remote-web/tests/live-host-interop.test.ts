import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Duplex } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BlindRelayServer,
  MultiAgentRemoteHost,
  type ManagedAgentBackend,
  type OfficialSessionEvent,
} from '@dsh-community/remote-adapter'
import { RemoteWebKeyStore } from '../src/client/keystore.ts'
import { consumePairFragmentFromLocation, parsePairingInput } from '../src/client/pairing.ts'
import { RemoteRpcError, RemoteWebClient } from '../src/client/remote-client.ts'
import { SessionTimelineState } from '../src/client/timeline.ts'
import type { TrustedHostProfile } from '../src/client/types.ts'
import { utf8Decode } from '../src/crypto/bytes.ts'

const cleanupCallbacks: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanupCallbacks.length > 0) {
    const fn = cleanupCallbacks.pop()
    if (fn) {
      await fn()
    }
  }
})

function createMockMultiAgentBackend(workspaceRoot: string): {
  backend: ManagedAgentBackend
  emit: (sessionId: string, events: readonly OfficialSessionEvent[]) => void
  approvalsSeen: Array<{ callId: string; decision: string }>
  questionsSeen: Array<{ questionId: string; answer: unknown }>
} {
  let seqCounter = 10
  const listeners = new Set<(sessionId: string, events: readonly OfficialSessionEvent[]) => void>()
  const sessions = new Map<string, { id: string; title: string; engine: string; cwd: string }>([
    [
      'claude--s1',
      {
        id: 'claude--s1',
        title: 'Refactor Auth Module',
        engine: 'claude',
        cwd: workspaceRoot,
      },
    ],
  ])
  const approvalsSeen: Array<{ callId: string; decision: string }> = []
  const questionsSeen: Array<{ questionId: string; answer: unknown }> = []

  const emit = (sessionId: string, events: readonly OfficialSessionEvent[]): void => {
    for (const l of listeners) {
      l(sessionId, events)
    }
  }

  const backend: ManagedAgentBackend = {
    engineId: 'claude',
    displayName: 'Claude Code',
    probe: async () => ({
      id: 'claude',
      displayName: 'Claude Code',
      available: true,
      running: true,
      capabilities: {
        createSession: true,
        listSessions: true,
        history: true,
        abortTurn: true,
        approvals: true,
        questions: true,
        streaming: true,
        models: true,
        gitReview: true,
      },
    }),
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listSessions: async () =>
      [...sessions.values()].map((s) => ({
        id: s.id,
        engine: 'claude',
        title: s.title,
        status: 'idle' as const,
        cwd: s.cwd,
        workspace: {
          repoRoot: workspaceRoot,
          branch: 'feat/remote-web',
          dirty: true,
          changedFiles: 1,
        },
      })),
    assertSession: async (sessionId) => {
      if (!sessions.has(sessionId)) {
        throw new Error(`Unknown session ${sessionId}`)
      }
    },
    createSession: async (opts) => {
      const id = `claude--created-${sessions.size + 1}`
      const created = {
        id,
        title: opts?.title ?? 'New Browser Session',
        engine: 'claude',
        cwd: opts?.cwd ?? workspaceRoot,
      }
      sessions.set(id, created)
      return {
        id,
        engine: 'claude',
        title: created.title,
        status: 'idle',
        cwd: created.cwd,
      }
    },
    followup: async (sessionId, prompt) => {
      const s1 = ++seqCounter
      const s2 = ++seqCounter
      const s3 = ++seqCounter
      const s4 = ++seqCounter
      setTimeout(() => {
        emit(sessionId, [
          { seq: s1, type: 'turn/start', data: {} },
          { seq: s2, type: 'assistant/chunk', data: { delta: 'Reviewing ' } },
          {
            seq: s3,
            type: 'assistant/message',
            data: { message: { content: `Reviewing **${prompt}** complete.` } },
          },
          { seq: s4, type: 'turn/end', data: { reason: { kind: 'completed' } } },
        ])
      }, 10)
      return { accepted: true }
    },
    respondApproval: async (callId, decision) => {
      approvalsSeen.push({ callId, decision })
      emit('claude--s1', [{ seq: ++seqCounter, type: 'approval.resolved', data: { callId, decision } }])
      return { ok: true }
    },
    respondQuestion: async (questionId, answer) => {
      questionsSeen.push({ questionId, answer })
      emit('claude--s1', [{ seq: ++seqCounter, type: 'question.resolved', data: { questionId, answer } }])
      return { ok: true }
    },
    getWorkspaceGitStatus: async ({ sessionId }) => ({
      sessionId,
      repoRoot: workspaceRoot,
      branch: 'feat/remote-web',
      ahead: 1,
      behind: 0,
      clean: false,
      files: [
        {
          path: 'src/index.ts',
          indexStatus: 'M',
          worktreeStatus: ' ',
          staged: true,
          unstaged: false,
          untracked: false,
        },
      ],
      truncated: false,
    }),
    getWorkspaceGitDiff: async ({ sessionId, staged }) => ({
      sessionId,
      repoRoot: workspaceRoot,
      branch: 'feat/remote-web',
      staged: Boolean(staged),
      diff: 'diff --git a/src/index.ts b/src/index.ts\n@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2\n',
      bytes: 79,
      truncated: false,
    }),
    listWorkspaceFiles: async ({ sessionId, query }) => {
      const all = ['README.md', 'src/index.ts', 'src/client/timeline.ts']
      const filtered = query ? all.filter((f) => f.toLowerCase().includes(query.toLowerCase())) : all
      return {
        sessionId,
        root: workspaceRoot,
        files: filtered,
        totalMatched: filtered.length,
        truncated: false,
      }
    },
    listModels: async () => ({
      current: { provider: 'anthropic', model: 'sonnet' },
      models: [{ provider: 'anthropic', model: 'opus', name: 'Claude Opus' }],
    }),
    selectModel: async (_sessionId, selection) => ({ ok: true, selection }),
    listCommands: async () => [{ name: 'compact', description: 'Compact session context' }],
    executeCommand: async (_sessionId, command) => ({ ok: true, output: `Ran ${command}` }),
  }

  return { backend, emit, approvalsSeen, questionsSeen }
}

describe('remote-web live E2EE host interoperability', () => {
  it('pairs via #pair= URL fragment scrub, exchanges Noise IK RPCs, streams events, handles approvals/questions/diff, and enforces revocation & epoch anti-rollback', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-rweb-lan-'))
    cleanupCallbacks.push(() => rmSync(tmpDir, { recursive: true, force: true }))

    const mock = createMockMultiAgentBackend(tmpDir)
    const host = new MultiAgentRemoteHost({
      dshHome: join(tmpDir, 'dsh-home'),
      configDir: join(tmpDir, 'remote-config'),
      cwd: tmpDir,
      backends: [mock.backend],
      autoConfirmCapabilities: [
        'observe',
        'prompt',
        'approve',
        'answer-question',
        'session.manage',
        'command.execute',
      ],
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
    })
    await host.start()
    cleanupCallbacks.push(() => host.stop())

    const issued = await host.issuePairingDescriptor({
      allowedCapabilities: [
        'observe',
        'prompt',
        'approve',
        'answer-question',
        'session.manage',
        'command.execute',
      ],
    })
    const base64Fragment = new URL(issued.deepLink).searchParams.get('data')!

    // Verify URL #pair= extraction + history.replaceState token scrubbing
    let replacedUrl = ''
    const extracted = consumePairFragmentFromLocation({
      location: {
        pathname: '/app/',
        search: '?tab=remote',
        hash: `#pair=${base64Fragment}&view=chat`,
      } as Location,
      history: {
        replaceState: (_s, _t, url) => {
          replacedUrl = String(url ?? '')
        },
      } as History,
    })
    expect(extracted).toBe(base64Fragment)
    expect(replacedUrl).toBe('/app/?tab=remote#view=chat')
    expect(replacedUrl).not.toContain('pair=')
    expect(replacedUrl).not.toContain(issued.descriptor.bootstrapToken)

    const parsed = await parsePairingInput(extracted!)
    const keyStore = new RemoteWebKeyStore(false)
    const client = new RemoteWebClient(keyStore)
    cleanupCallbacks.push(() => client.disconnect())

    const timeline = new SessionTimelineState('claude--s1')
    const eventsReceived: OfficialSessionEvent[] = []
    client.onNotification((notif) => {
      if (notif.type === 'stream.event' && notif.sessionId === 'claude--s1') {
        eventsReceived.push(notif.event)
        timeline.applyEvent(notif.event)
      }
    })

    const savedProfile = await client.connectWithPairing(parsed, {
      displayName: 'Safari Vitest Peer',
      autoPairPollIntervalMs: 30,
    })
    expect(savedProfile.hostFingerprint).toBe(issued.descriptor.hostFingerprint)
    expect(client.getStatus()).toBe('active')
    expect(client.getActiveTransportKind()).toBe('lan')
    expect(await client.ping()).toBe(true)

    const engines = await client.listEngines()
    expect(engines.some((e) => e.id === 'claude')).toBe(true)

    const sessions = await client.listSessions()
    expect(sessions.map((s) => s.id)).toContain('claude--s1')

    await client.attachSession('claude--s1')
    await client.submitPrompt('claude--s1', 'check remote web')

    await expect.poll(() => timeline.items.length, { timeout: 3000 }).toBeGreaterThanOrEqual(1)
    expect(timeline.items.some((it) => it.kind === 'assistant' && it.markdownText.includes('check remote web'))).toBe(true)

    // Test approval + question live roundtrip
    mock.emit('claude--s1', [
      { seq: 50, type: 'approval.request', data: { callId: 'c1', toolName: 'bash', reason: 'Run tests' } },
      { seq: 51, type: 'question.request', data: { questionId: 'q1', questions: [{ question: 'Deploy target?' }] } },
    ])
    await expect.poll(() => timeline.pendingApprovals.length, { timeout: 3000 }).toBe(1)
    await expect.poll(() => timeline.pendingQuestions.length, { timeout: 3000 }).toBe(1)

    await client.respondApproval('c1', 'approved')
    await client.respondQuestion('q1', 'staging')
    expect(mock.approvalsSeen).toEqual([{ callId: 'c1', decision: 'approved' }])
    expect(mock.questionsSeen).toEqual([{ questionId: 'q1', answer: 'staging' }])

    // Test Workspace Git Status + Diff
    const gitStatus = await client.getWorkspaceGitStatus('claude--s1')
    expect(gitStatus.branch).toBe('feat/remote-web')
    expect(gitStatus.files[0]?.path).toBe('src/index.ts')
    const gitDiff = await client.getWorkspaceGitDiff('claude--s1', { staged: true })
    expect(gitDiff.diff).toContain('+const a = 2')
    const wsFiles = await client.listWorkspaceFiles('claude--s1', { query: 'timeline' })
    expect(wsFiles.files).toEqual(['src/client/timeline.ts'])

    // Test Create Session
    const created = await client.createSession({ engine: 'claude', title: 'Browser Spawned' })
    expect(created.title).toBe('Browser Spawned')

    // Test Epoch Rollback Protection on BOTH saved host profile AND crafted pairing link
    client.disconnect()
    await keyStore.updateHostEpoch(savedProfile.hostFingerprint, savedProfile.lastEpoch + 500)
    const elevatedProfile = (await keyStore.getTrustedHost(savedProfile.hostFingerprint))!
    await expect(client.connectToProfile(elevatedProfile, { allowEpochReset: false })).rejects.toMatchObject({
      code: 'EPOCH_DOWNGRADE',
    })

    // Crafted pairing link for already-trusted fingerprint when host returns ACTIVE at lower epoch MUST fail closed
    const reissuedLower = await host.issuePairingDescriptor()
    await expect(
      client.connectWithPairing({
        ...reissuedLower.descriptor,
        endpointUrl: 'ws://127.0.0.1:1',
      }),
    ).rejects.toThrow()
    const unchangedHost = (await keyStore.getTrustedHost(savedProfile.hostFingerprint))!
    expect(unchangedHost.lastEpoch).toBe(savedProfile.lastEpoch + 500)
    expect(unchangedHost.endpointUrl).toBe(elevatedProfile.endpointUrl)

    await expect(client.connectWithPairing(reissuedLower.descriptor)).rejects.toMatchObject({
      code: 'EPOCH_DOWNGRADE',
    })
    expect((await keyStore.getTrustedHost(savedProfile.hostFingerprint))?.lastEpoch).toBe(
      savedProfile.lastEpoch + 500,
    )

    // Explicit user confirmation of epoch reset succeeds cleanly AND persists refreshed endpoints
    const refreshedEndpoint = `${reissuedLower.descriptor.endpointUrl}/?repaired=1`
    const savedAfterRepair = await client.connectWithPairing(
      {
        ...reissuedLower.descriptor,
        endpointUrl: refreshedEndpoint,
        relayUrl: 'ws://127.0.0.1:9998',
      },
      { allowEpochReset: true },
    )
    expect(client.getStatus()).toBe('active')
    expect(savedAfterRepair.endpointUrl).toBe(refreshedEndpoint)
    expect(savedAfterRepair.relayUrl).toBe('ws://127.0.0.1:9998')
    const persistedAfterRepair = await keyStore.getTrustedHost(savedProfile.hostFingerprint)
    expect(persistedAfterRepair?.endpointUrl).toBe(refreshedEndpoint)
    expect(persistedAfterRepair?.relayUrl).toBe('ws://127.0.0.1:9998')

    // Host revocation fails closed and delivers peer.revoked notification
    const identity = await keyStore.getOrCreateClientKeyPair()
    let revokedNotif = false
    client.onNotification((n) => {
      if (n.type === 'peer.revoked') revokedNotif = true
    })
    await host.revokeDevice(identity.fingerprint)
    await expect.poll(() => client.getStatus(), { timeout: 3000 }).toBe('revoked')
    expect(revokedNotif).toBe(true)
    await expect(client.ping()).rejects.toThrow(RemoteRpcError)
  })

  it('falls back transparently from unreachable LAN to blind WebSocket relay while keeping plaintext hidden from the relay', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-rweb-relay-'))
    cleanupCallbacks.push(() => rmSync(tmpDir, { recursive: true, force: true }))

    const observedRelayBytes: Uint8Array[] = []
    const relay = new BlindRelayServer({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      hostAuthSecret: 'relay-host-secret',
      onBlindFrame: (obs) => observedRelayBytes.push(new Uint8Array(obs.payload)),
    })
    await relay.start()
    cleanupCallbacks.push(() => relay.stop())

    const relayUrl = relay.getEndpointUrl()!
    const mock = createMockMultiAgentBackend(tmpDir)
    const host = new MultiAgentRemoteHost({
      dshHome: join(tmpDir, 'dsh-home'),
      configDir: join(tmpDir, 'remote-config'),
      cwd: tmpDir,
      backends: [mock.backend],
      autoConfirmCapabilities: ['observe', 'prompt'],
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
      relay: {
        enabled: true,
        relayUrl,
        hostAuthSecret: 'relay-host-secret',
      },
    })
    await host.start()
    cleanupCallbacks.push(() => host.stop())

    const issued = await host.issuePairingDescriptor()
    // Point endpointUrl at an unreachable port so failover exercises Blind Relay WebSocket
    const unreachableLanDescriptor = {
      ...issued.descriptor,
      endpointUrl: 'ws://127.0.0.1:1',
    }

    const client = new RemoteWebClient(new RemoteWebKeyStore(false))
    cleanupCallbacks.push(() => client.disconnect())

    const profile = await client.connectWithPairing(unreachableLanDescriptor, {
      handshakeTimeoutMs: 2_000,
      autoPairPollIntervalMs: 30,
    })
    expect(profile.relayUrl).toBe(relayUrl)
    expect(client.getStatus()).toBe('active')
    expect(client.getActiveTransportKind()).toBe('relay')

    const secretMarker = 'TOP_SECRET_E2EE_RELAY_PAYLOAD_9911'
    await client.attachSession('claude--s1')
    await client.submitPrompt('claude--s1', secretMarker)

    expect(observedRelayBytes.length).toBeGreaterThan(0)
    const joinedAscii = observedRelayBytes.map((b) => utf8Decode(b)).join('')
    expect(joinedAscii).not.toContain(secretMarker)
    expect(joinedAscii).not.toContain('prompt.submit')
  })

  it('clears allowEpochReset before automatic reconnects and supports flat model.select + command.execute over E2EE', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-rweb-recon-'))
    cleanupCallbacks.push(() => rmSync(tmpDir, { recursive: true, force: true }))

    const mock = createMockMultiAgentBackend(tmpDir)
    const host = new MultiAgentRemoteHost({
      dshHome: join(tmpDir, 'dsh-home'),
      configDir: join(tmpDir, 'remote-config'),
      cwd: tmpDir,
      backends: [mock.backend],
      autoConfirmCapabilities: [
        'observe',
        'prompt',
        'approve',
        'answer-question',
        'session.manage',
        'command.execute',
      ],
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
    })
    await host.start()
    cleanupCallbacks.push(() => host.stop())

    const issued = await host.issuePairingDescriptor({
      allowedCapabilities: [
        'observe',
        'prompt',
        'approve',
        'answer-question',
        'session.manage',
        'command.execute',
      ],
    })
    const keyStore = new RemoteWebKeyStore(false)
    const client = new RemoteWebClient(keyStore)
    cleanupCallbacks.push(() => client.disconnect())

    const saved = await client.connectWithPairing(issued.descriptor, {
      displayName: 'Epoch Regression Peer',
      autoPairPollIntervalMs: 30,
    })

    // Verify flat model.select & command.execute contracts against MultiAgentRemoteHost core parser
    await expect(
      client.selectModel('claude--s1', { provider: 'anthropic', model: 'opus' }),
    ).resolves.toMatchObject({ ok: true, selection: { provider: 'anthropic', model: 'opus' } })
    await expect(client.executeCommand('claude--s1', '/compact')).resolves.toMatchObject({
      ok: true,
      output: 'Ran /compact',
    })

    // Advance persisted epoch above host's epoch; then trigger an unexpected drop to verify automatic
    // reconnect does NOT reuse allowEpochReset from initial pairing and instead emits epoch_mismatch.
    await keyStore.updateHostEpoch(saved.hostFingerprint, saved.lastEpoch + 250)
    const statusSeen: string[] = []
    client.onStatus((s) => statusSeen.push(s.status))
    ;(client as unknown as { handleUnexpectedDrop(r: string): void }).handleUnexpectedDrop('simulated socket drop')

    await expect.poll(() => statusSeen.includes('epoch_mismatch'), { timeout: 5_000 }).toBe(true)
    const persisted = await keyStore.getTrustedHost(saved.hostFingerprint)
    expect(persisted?.lastEpoch).toBe(saved.lastEpoch + 250)
  })

  it('cancels superseded connection attempts without tearing down replacement transport or publishing stale errors', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-rweb-superseded-'))
    cleanupCallbacks.push(() => rmSync(tmpDir, { recursive: true, force: true }))

    // Create a zero-dependency silent WS upgrade blackhole that stalls before Noise handshake response
    const openSockets = new Set<Duplex>()
    const stalledHttp = createServer()
    stalledHttp.on('upgrade', (req, socket) => {
      const wsKey = String(req.headers['sec-websocket-key'] ?? '')
      const accept = createHash('sha1')
        .update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64')
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
      openSockets.add(socket)
      socket.on('close', () => openSockets.delete(socket))
      socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => stalledHttp.listen(0, '127.0.0.1', () => resolve()))
    const stalledAddr = stalledHttp.address() as { port: number }
    cleanupCallbacks.push(async () => {
      for (const sock of openSockets) sock.destroy()
      await new Promise<void>((resolve) => stalledHttp.close(() => resolve()))
    })

    const stalledHostPubHex = '2a'.repeat(32)
    const stalledHostFp = 'bb'.repeat(32)

    const mock = createMockMultiAgentBackend(tmpDir)
    const liveHost = new MultiAgentRemoteHost({
      dshHome: join(tmpDir, 'dsh-home'),
      configDir: join(tmpDir, 'remote-config'),
      cwd: tmpDir,
      backends: [mock.backend],
      autoConfirmCapabilities: ['observe'],
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
    })
    await liveHost.start()
    cleanupCallbacks.push(() => liveHost.stop())

    const issuedLive = await liveHost.issuePairingDescriptor()
    const nowMs = Date.now()
    const stalledProfile: TrustedHostProfile = {
      hostFingerprint: stalledHostFp,
      hostPublicKeyHex: stalledHostPubHex,
      label: 'Stalled Host',
      endpointUrl: `ws://127.0.0.1:${stalledAddr.port}`,
      lastEpoch: 0,
      pairedAt: nowMs,
      lastConnectedAt: nowMs,
    }

    const client = new RemoteWebClient(new RemoteWebKeyStore(false))
    cleanupCallbacks.push(() => client.disconnect())

    const statuses: string[] = []
    client.onStatus((evt) => {
      if (evt.status === 'error') {
        statuses.push(`${evt.host?.hostFingerprint}:${evt.detail}`)
      }
    })

    const staleAttempt = client
      .connectToProfile(stalledProfile, { handshakeTimeoutMs: 120 })
      .catch((err) => err)

    await new Promise((r) => setTimeout(r, 20))
    const liveSaved = await client.connectWithPairing(issuedLive.descriptor, {
      handshakeTimeoutMs: 2_000,
      autoPairPollIntervalMs: 30,
    })
    expect(client.getStatus()).toBe('active')

    // Wait well past the stale handshake timeout (120ms) to ensure old timers/catches stay silent
    const staleOutcome = await staleAttempt
    await new Promise((r) => setTimeout(r, 180))

    expect(staleOutcome).toBeInstanceOf(RemoteRpcError)
    expect((staleOutcome as RemoteRpcError).code).toBe('CANCELLED')
    expect(client.getStatus()).toBe('active')
    expect(client.getActiveHost()?.hostFingerprint).toBe(liveSaved.hostFingerprint)
    expect(statuses).toEqual([])
    await expect(client.listSessions()).resolves.toMatchObject([{ id: 'claude--s1' }])
  })

  it('rejects crafted pairing links whose host returns an epoch equal to stored lastEpoch unless explicitly reset', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-rweb-eq-epoch-'))
    cleanupCallbacks.push(() => rmSync(tmpDir, { recursive: true, force: true }))
    const dshHome = join(tmpDir, 'dsh-home')
    const configDir = join(tmpDir, 'remote-config')

    const mock = createMockMultiAgentBackend(tmpDir)
    const host = new MultiAgentRemoteHost({
      dshHome,
      configDir,
      cwd: tmpDir,
      backends: [mock.backend],
      autoConfirmCapabilities: ['observe', 'prompt'],
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
    })
    await host.start()
    cleanupCallbacks.push(() => host.stop())

    const keyStore = new RemoteWebKeyStore(false)
    const client = new RemoteWebClient(keyStore)
    cleanupCallbacks.push(() => client.disconnect())

    const issued = await host.issuePairingDescriptor()
    const saved = await client.connectWithPairing(issued.descriptor, {
      displayName: 'Equal Epoch Peer',
      autoPairPollIntervalMs: 30,
    })
    expect(saved.lastEpoch).toBeGreaterThanOrEqual(2)
    client.disconnect()
    await host.stop()

    // Spin up a stale host clone with identical static key & trusted device record; its allocator
    // advances through 1..saved.lastEpoch, reaching exact epoch equality with stored lastEpoch.
    const cloneHost = new MultiAgentRemoteHost({
      dshHome,
      configDir,
      cwd: tmpDir,
      backends: [mock.backend],
      autoConfirmCapabilities: ['observe', 'prompt'],
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
    })
    await cloneHost.start()
    cleanupCallbacks.push(() => cloneHost.stop())

    const cloneIssued = await cloneHost.issuePairingDescriptor()
    for (let step = 1; step <= saved.lastEpoch; step += 1) {
      await expect(client.connectWithPairing(cloneIssued.descriptor)).rejects.toMatchObject({
        code: 'EPOCH_DOWNGRADE',
      })
    }
    expect((await keyStore.getTrustedHost(saved.hostFingerprint))?.lastEpoch).toBe(saved.lastEpoch)
    expect((await keyStore.getTrustedHost(saved.hostFingerprint))?.endpointUrl).toBe(saved.endpointUrl)
  })
})
