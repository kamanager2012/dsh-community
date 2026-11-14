import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FailoverRemoteClient,
  HostLanCarrier,
  InMemoryDeviceTrustStore,
  InMemoryHostIdentityStore,
  MAX_FAILOVER_HISTORY,
  OfficialHostCordisBridge,
  PairingCoordinator,
  PairingTokenRegistry,
  RemoteAdapterCore,
  RemoteProtocolError,
  WORKSPACE_UPLOAD_SUBDIR,
  WorkspaceUploadManager,
  decodeStrictUploadChunkBase64,
  extractCodePointSnippet,
  extractPreviewTextFromEvent,
  findOfficialSessionTranscriptPath,
  parsePairingInput,
  sanitizeDiagnosticMessage,
  sanitizeLoneSurrogates,
  searchSessionCollections,
  shouldAllowIceCandidate,
  truncateByCodePoints,
  validateSafeUploadFilename,
  type OfficialAgentContextLike,
  type OfficialAgentLike,
  type OfficialCordisContextLike,
  type OfficialRemoteSeams,
} from '../src/index.js'

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

async function allocateClosedPort(): Promise<number> {
  const srv = createNetServer()
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()))
  const addr = srv.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  await new Promise<void>((resolve) => srv.close(() => resolve()))
  return port
}

class MinimalCordisRoot implements OfficialCordisContextLike {
  readonly sessionMap = new Map<string, OfficialAgentLike>()
  readonly rootListeners = new Map<string, Set<(...args: any[]) => unknown>>()
  readonly agents = {
    list: () => [...this.sessionMap.values()],
    get: (id: string) => this.sessionMap.get(id),
    create: async () => {
      throw new Error('create unused')
    },
    resume: async () => {
      throw new Error('resume unused')
    },
  }

  on(event: string, listener: (...args: any[]) => unknown): () => void {
    let set = this.rootListeners.get(event)
    if (!set) {
      set = new Set()
      this.rootListeners.set(event, set)
    }
    set.add(listener)
    return () => set?.delete(listener)
  }

  async parallel(): Promise<unknown> {
    return undefined
  }
}

function makeMockAgent(id: string, initialLog: Array<Record<string, unknown>> = []): OfficialAgentLike {
  const listeners = new Map<string, Set<(...args: any[]) => unknown>>()
  const ctx: OfficialAgentContextLike = {
    on(event: string, listener: (...args: any[]) => unknown) {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(listener)
      return () => set?.delete(listener)
    },
  }
  return {
    id,
    ctx,
    status: 'idle',
    session: {
      id,
      log: initialLog,
    },
    async whenIdle() {},
    async followup() {},
    async abort() {},
  }
}

async function pairClientToBridge(
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
  await new Promise((r) => setTimeout(r, 40))
  client.close()
  await client.reconnectWithBackoff({ initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 3 })
  return client
}

describe('P10 hardening, Unicode safety, workspace uploads, and failover resilience', () => {
  it('preserves UTF-16 surrogate pairs and replaces lone surrogates across previews, snippets, and search', () => {
    // Surrogate pairs straddling exact truncation boundary must never split.
    const emojiStr = `${'a'.repeat(139)}🚀tail`
    const truncated = truncateByCodePoints(emojiStr, 140)
    expect(truncated).toBe(`${'a'.repeat(139)}🚀…`)
    expect(() => encodeURIComponent(truncated)).not.toThrow()

    // Lone high/low surrogates get replaced cleanly with U+FFFD.
    const poisoned = `ok-${'\uD83D'}-mid-${'\uDE80'}-end`
    const cleaned = sanitizeLoneSurrogates(poisoned)
    expect(cleaned).toBe('ok-\uFFFD-mid-\uFFFD-end')
    expect(() => encodeURIComponent(cleaned)).not.toThrow()

    // Code-point snippet windowing around a match surrounded by 4-byte UTF-8 emojis.
    const widePrefix = '🎉'.repeat(30)
    const wideSuffix = '𠀀'.repeat(60)
    const doc = `${widePrefix}needle${wideSuffix}`
    const matchIdx = doc.indexOf('needle')
    const snippet = extractCodePointSnippet(doc, matchIdx, 'needle'.length, 24, 48)
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet).toContain('needle')
    expect(() => encodeURIComponent(snippet)).not.toThrow()

    const preview = extractPreviewTextFromEvent({
      type: 'assistant/message',
      data: { message: { content: `${'b'.repeat(139)}🧪more-text` } },
    })
    expect(preview).toBe(`${'b'.repeat(139)}🧪…`)
    expect(() => encodeURIComponent(preview!)).not.toThrow()

    const searched = searchSessionCollections({
      query: 'target',
      sources: [
        {
          sessionId: 'sess-emoji',
          events: [
            {
              seq: 1,
              type: 'user/message',
              data: { message: { content: `${'🧩'.repeat(30)} target ${'🪐'.repeat(60)}` } },
            },
          ],
        },
      ],
    })
    expect(searched.hits).toHaveLength(1)
    expect(() => encodeURIComponent(searched.hits[0]!.snippet)).not.toThrow()
  })

  it('blocks symlink escapes in official transcript path discovery and disk search keeps >60 Zstd sessions hot without thrashing', async () => {
    const baseDir = makeTempDir('dsh-sym-cache')
    const dshHome = join(baseDir, '.dsh')
    const sessionRoot = join(dshHome, 'sessions')
    const cfgDir = join(baseDir, 'cfg')
    const cwd = join(baseDir, 'work')
    mkdirSync(sessionRoot, { recursive: true })
    mkdirSync(cfgDir, { recursive: true })
    mkdirSync(cwd, { recursive: true })

    // Outside file linked via symlink inside sessionsRoot MUST be rejected.
    const outsideSecret = join(baseDir, 'outside-secret.jsonl')
    writeFileSync(outsideSecret, `${JSON.stringify({ type: 'session', cwd: '/etc' })}\n`, 'utf8')
    const symlinkBucket = join(sessionRoot, '--tmp-sym--', 'sess-sym-file')
    mkdirSync(symlinkBucket, { recursive: true })
    symlinkSync(outsideSecret, join(symlinkBucket, 'session.jsonl'))
    expect(findOfficialSessionTranscriptPath(sessionRoot, 'sess-sym-file')).toBeUndefined()

    const symlinkDirTarget = makeTempDir('dsh-sym-target-dir')
    writeFileSync(join(symlinkDirTarget, 'session.jsonl'), '{"type":"session"}\n', 'utf8')
    symlinkSync(symlinkDirTarget, join(sessionRoot, 'sym-bucket'))
    mkdirSync(join(symlinkDirTarget, 'sess-inside-symdir'), { recursive: true })
    writeFileSync(
      join(symlinkDirTarget, 'sess-inside-symdir', 'session.v4.jsonl.zstd'),
      zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', cwd })}\n`, 'utf8')),
    )
    expect(findOfficialSessionTranscriptPath(sessionRoot, 'sess-inside-symdir')).toBeUndefined()

    // Populate 70 persisted Zstd sessions (> old 48-entry cache cap) + 1 live session.
    const projectDir = join(sessionRoot, '--tmp-bulk--')
    for (let i = 0; i < 70; i += 1) {
      const sid = `sess-bulk-${String(i).padStart(3, '0')}`
      const dir = join(projectDir, sid)
      mkdirSync(dir, { recursive: true })
      const lines = [
        JSON.stringify({ type: 'session', version: 4, cwd }),
        JSON.stringify({ seq: 0, type: 'turn/start', data: {} }),
        JSON.stringify({ seq: 1, type: 'user/message', data: { message: { content: `batch item ${i}` } } }),
        JSON.stringify({ seq: 2, type: 'turn/end', data: { reason: { kind: 'ok' } } }),
      ].join('\n') + '\n'
      writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines, 'utf8')))
    }

    const root = new MinimalCordisRoot()
    const liveLog: Array<Record<string, unknown>> = [
      { seq: 0, type: 'turn/start', data: {} },
      { seq: 1, type: 'user/message', data: { message: { content: 'initial live phrase' } } },
    ]
    const liveAgent = makeMockAgent('sess-live-memo', liveLog)
    root.sessionMap.set('sess-live-memo', liveAgent)

    const bridge = new OfficialHostCordisBridge({
      ctx: root,
      configDir: cfgDir,
      dshHome,
      sessionRoot,
      cwd,
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
    })
    await bridge.start()
    try {
      const all = await bridge.listSessions()
      expect(all.some((s) => s.id === 'sess-live-memo')).toBe(true)

      const firstSearch = await bridge.searchSessions({ query: 'initial live phrase' })
      expect(firstSearch.hits).toHaveLength(1)
      expect(firstSearch.hits[0]?.sessionId).toBe('sess-live-memo')

      // Appending to live session log invalidates the live snapshot memoization cache automatically.
      liveLog.push({ seq: 2, type: 'assistant/message', data: { message: { content: 'fresh appended token 🚀' } } })
      const secondSearch = await bridge.searchSessions({ query: 'fresh appended token' })
      expect(secondSearch.hits).toHaveLength(1)
      expect(secondSearch.hits[0]?.snippet).toContain('🚀')

      // Scanning persisted sessions keeps cache healthy above the previous 48-entry ceiling.
      const bulkHit = await bridge.searchSessions({ query: 'batch item 69' })
      expect(bulkHit.hits).toHaveLength(1)
      expect(bulkHit.hits[0]?.sessionId).toBe('sess-bulk-069')
    } finally {
      await bridge.stop()
    }
  })

  it('enforces strict path confinement, chunk budgets, ownership isolation, and cleanup in WorkspaceUploadManager', () => {
    const work = makeTempDir('dsh-upload-unit')
    const outside = makeTempDir('dsh-upload-outside')
    const mgr = new WorkspaceUploadManager({ maxUploadBytes: 4096, defaultChunkBytes: 512, maxOpenPerDevice: 2 })

    // Unsafe filenames must fail closed before opening any descriptor.
    for (const badName of ['', '.', '..', '../pwn', 'sub/file.txt', 'sub\\file.txt', ' lead.txt', '.tmp-evil', 'bad\x00name', 'a'.repeat(256)]) {
      expect(() => validateSafeUploadFilename(badName)).toThrow(RemoteProtocolError)
    }

    // Malformed / oversized base64 rejected strictly.
    expect(() => decodeStrictUploadChunkBase64('***not-base64***', 512)).toThrow(RemoteProtocolError)
    expect(() => decodeStrictUploadChunkBase64(Buffer.alloc(600, 1).toString('base64'), 512)).toThrow(RemoteProtocolError)

    // Pre-existing symlinked .dsh-uploads directory escaping workspace MUST be blocked.
    const symlinkedUploadRoot = makeTempDir('dsh-upload-sym')
    symlinkSync(outside, join(symlinkedUploadRoot, WORKSPACE_UPLOAD_SUBDIR))
    expect(() =>
      mgr.open({
        deviceId: 'dev-a',
        sessionId: 'sess-1',
        workspaceRoot: symlinkedUploadRoot,
        filename: 'escape.txt',
        sizeBytes: 10,
      }),
    ).toThrow(RemoteProtocolError)

    // Oversized upload declaration fails cleanly without leaking descriptors.
    expect(() =>
      mgr.open({
        deviceId: 'dev-a',
        sessionId: 'sess-1',
        workspaceRoot: work,
        filename: 'too-big.bin',
        sizeBytes: 5000,
      }),
    ).toThrow(RemoteProtocolError)
    expect(mgr.activeCount()).toBe(0)

    // Ownership isolation + SHA-256 verification + temp cleanup on digest failure.
    const payload = Buffer.from('hello-workspace-upload-integrity')
    const wrongSha = '0'.repeat(64)
    const opened = mgr.open({
      deviceId: 'dev-a',
      sessionId: 'sess-1',
      workspaceRoot: work,
      filename: 'artifact.txt',
      sizeBytes: payload.length,
      sha256: wrongSha,
    })
    expect(() =>
      mgr.appendChunk({
        deviceId: 'dev-b',
        uploadId: opened.uploadId,
        offset: 0,
        dataBase64: payload.toString('base64'),
      }),
    ).toThrow(/different device/i)
    mgr.appendChunk({
      deviceId: 'dev-a',
      uploadId: opened.uploadId,
      offset: 0,
      dataBase64: payload.toString('base64'),
    })
    expect(() => mgr.commit({ deviceId: 'dev-a', uploadId: opened.uploadId })).toThrow(/sha256/i)
    expect(mgr.activeCount()).toBe(0)
    expect(readdirSync(join(work, WORKSPACE_UPLOAD_SUBDIR))).toEqual([])

    // Conflict policy 'rename' vs 'fail'.
    const sha = createHash('sha256').update(payload).digest('hex')
    const u1 = mgr.open({
      deviceId: 'dev-a',
      sessionId: 'sess-1',
      workspaceRoot: work,
      filename: 'report.txt',
      sizeBytes: payload.length,
      sha256: sha,
    })
    mgr.appendChunk({ deviceId: 'dev-a', uploadId: u1.uploadId, offset: 0, dataBase64: payload.toString('base64') })
    const r1 = mgr.commit({ deviceId: 'dev-a', uploadId: u1.uploadId })
    expect(r1.relativePath).toBe('.dsh-uploads/report.txt')

    // O(1) chunk retry idempotency: retrying exact same chunk at same offset succeeds without double write;
    // retrying same offset with conflicting bytes throws IDEMPOTENCY_CONFLICT.
    const half1 = payload.subarray(0, 12)
    const half2 = payload.subarray(12)
    const uRetry = mgr.open({
      deviceId: 'dev-a',
      sessionId: 'sess-1',
      workspaceRoot: work,
      filename: 'retry-check.txt',
      sizeBytes: payload.length,
      sha256: sha,
    })
    const c1 = mgr.appendChunk({ deviceId: 'dev-a', uploadId: uRetry.uploadId, offset: 0, dataBase64: half1.toString('base64') })
    const c1Dup = mgr.appendChunk({ deviceId: 'dev-a', uploadId: uRetry.uploadId, offset: 0, dataBase64: half1.toString('base64') })
    expect(c1Dup).toEqual(c1)
    expect(() =>
      mgr.appendChunk({
        deviceId: 'dev-a',
        uploadId: uRetry.uploadId,
        offset: 0,
        dataBase64: Buffer.alloc(half1.length, 0x5a).toString('base64'),
      }),
    ).toThrow(/conflicting bytes/i)
    mgr.appendChunk({ deviceId: 'dev-a', uploadId: uRetry.uploadId, offset: 12, dataBase64: half2.toString('base64') })
    const rRetry = mgr.commit({ deviceId: 'dev-a', uploadId: uRetry.uploadId })
    expect(rRetry.bytesWritten).toBe(payload.length)
    expect(rRetry.sha256).toBe(sha)

    const u2 = mgr.open({
      deviceId: 'dev-a',
      sessionId: 'sess-1',
      workspaceRoot: work,
      filename: 'report.txt',
      sizeBytes: payload.length,
      conflictPolicy: 'rename',
    })
    mgr.appendChunk({ deviceId: 'dev-a', uploadId: u2.uploadId, offset: 0, dataBase64: payload.toString('base64') })
    const r2 = mgr.commit({ deviceId: 'dev-a', uploadId: u2.uploadId })
    expect(r2.relativePath).toBe('.dsh-uploads/report (1).txt')

    expect(() =>
      mgr.open({
        deviceId: 'dev-a',
        sessionId: 'sess-1',
        workspaceRoot: work,
        filename: 'report.txt',
        sizeBytes: payload.length,
        conflictPolicy: 'fail',
      }),
    ).toThrow(/already exists/i)

    // Device revocation purges staging temp files immediately.
    const u3 = mgr.open({
      deviceId: 'dev-c',
      sessionId: 'sess-1',
      workspaceRoot: work,
      filename: 'partial.bin',
      sizeBytes: 100,
    })
    mgr.appendChunk({ deviceId: 'dev-c', uploadId: u3.uploadId, offset: 0, dataBase64: Buffer.from('abc').toString('base64') })
    expect(mgr.activeCount()).toBe(1)
    expect(mgr.revokeDevice('dev-c')).toBe(1)
    expect(mgr.activeCount()).toBe(0)
    expect(readdirSync(join(work, WORKSPACE_UPLOAD_SUBDIR)).some((n) => n.startsWith('.tmp-'))).toBe(false)
    mgr.disposeAll()
  })

  it('streams >64 KiB files end-to-end over encrypted Noise LAN channel with SHA-256 verification and capability enforcement', async () => {
    const baseDir = makeTempDir('dsh-upload-e2e')
    const cfgDir = join(baseDir, 'cfg')
    const dshHome = join(baseDir, '.dsh')
    const work = join(baseDir, 'workspace')
    mkdirSync(cfgDir, { recursive: true })
    mkdirSync(join(dshHome, 'sessions'), { recursive: true })
    mkdirSync(work, { recursive: true })

    const root = new MinimalCordisRoot()
    root.sessionMap.set('sess-up', makeMockAgent('sess-up'))

    const bridge = new OfficialHostCordisBridge({
      ctx: root,
      configDir: cfgDir,
      dshHome,
      cwd: work,
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
      autoConfirmCapabilities: ['observe', 'prompt'],
    })
    await bridge.start()

    let clientPrompt: FailoverRemoteClient | undefined
    let clientObserveOnly: FailoverRemoteClient | undefined
    try {
      clientPrompt = await pairClientToBridge(bridge, 'Prompt Upload Phone', ['observe', 'prompt'])
      clientObserveOnly = await pairClientToBridge(bridge, 'Readonly Tablet', ['observe'])

      // 110 KiB payload (exceeds 64 KiB Noise frame ceiling; must chunk smoothly at 32 KiB).
      const bigBytes = Buffer.alloc(110 * 1024)
      for (let i = 0; i < bigBytes.length; i += 1) {
        bigBytes[i] = (i * 131 + 7) & 0xff
      }
      const expectedSha = createHash('sha256').update(bigBytes).digest('hex')
      const progressEvents: number[] = []

      const committed = await clientPrompt.uploadWorkspaceFile({
        sessionId: 'sess-up',
        filename: 'trace-dump.bin',
        bytes: bigBytes,
        onProgress: (sent) => progressEvents.push(sent),
      })

      expect(committed.relativePath).toBe('.dsh-uploads/trace-dump.bin')
      expect(committed.bytesWritten).toBe(bigBytes.length)
      expect(committed.sha256).toBe(expectedSha)
      expect(progressEvents.length).toBeGreaterThanOrEqual(4)
      expect(progressEvents[progressEvents.length - 1]).toBe(bigBytes.length)

      const writtenPath = join(work, committed.relativePath)
      expect(lstatSync(writtenPath).isFile()).toBe(true)
      expect(readFileSync(writtenPath)).toEqual(bigBytes)

      // Read-only observe device cannot invoke workspace.upload.open.
      await expect(
        clientObserveOnly.uploadWorkspaceFile({
          sessionId: 'sess-up',
          filename: 'unauthorized.txt',
          bytes: Buffer.from('nope'),
        }),
      ).rejects.toThrow(/CAPABILITY_DENIED/)
    } finally {
      clientPrompt?.close()
      clientObserveOnly?.close()
      await bridge.stop()
    }
  })

  it('applies failover cooldowns without deadlocking, bounds history, redacts diagnostics secrets, and filters direct-only relay ICE candidates', async () => {
    const deadPort = await allocateClosedPort()
    const hostStore = new InMemoryHostIdentityStore()
    const hostId = await hostStore.loadOrCreate()
    const clientId = await new InMemoryHostIdentityStore().loadOrCreate()
    const trustStore = new InMemoryDeviceTrustStore()
    const pairingCoordinator = new PairingCoordinator(hostStore, trustStore, new PairingTokenRegistry())

    const seams: OfficialRemoteSeams = {
      async listSessions() {
        return [{ id: 's-cool', title: 'Cooldown' }]
      },
      async assertSession() {},
      async followup() {
        return { ok: true }
      },
      async respondApproval() {
        return { ok: true }
      },
      async respondQuestion() {
        return { ok: true }
      },
    }
    const core = new RemoteAdapterCore(seams, { trustStore, hostIdentityStore: hostStore })

    // Start a real secondary WS HTTP upgrade server just to test HostLanCarrier clean failover:
    const healthyLan = new HostLanCarrier({
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      core,
      trustStore,
      hostIdentityStore: hostStore,
      pairingCoordinator,
    })
    await healthyLan.start()
    const lanUrl = healthyLan.getEndpointUrl()!

    trustStore.trustSync({
      staticPublicKey: clientId.identity.publicKey,
      displayName: 'cooldown-dev',
      grantedCapabilities: ['observe'],
      trustDomainId: hostId.identity.trustDomainId,
    })

    // First try dead signaling (webrtc) -> falls back to healthy lan and puts webrtc in cooldown.
    const closedSigPort = await allocateClosedPort()
    const failoverClient = new FailoverRemoteClient({
      clientKeyPair: { publicKey: clientId.identity.publicKey, secretKey: clientId.secretKey },
      hostPublicKey: hostId.identity.publicKey,
      priorityOrder: ['webrtc', 'lan'],
      failureCooldownMs: 30_000,
      webrtc: {
        signalingUrl: `ws://127.0.0.1:${closedSigPort}/sig?token=super-secret-token-xyz`,
        iceConnectTimeoutMs: 500,
      },
      lan: { endpointUrl: lanUrl },
    })

    try {
      await failoverClient.connect()
      expect(failoverClient.getActiveTransportKind()).toBe('lan')
      const firstDiag = failoverClient.getConnectionDiagnostics()
      expect(firstDiag.cooldownsMs?.webrtc).toBeGreaterThan(0)
      const webrtcErr = firstDiag.failoverAttempts.find((a) => a.kind === 'webrtc')?.error ?? ''
      expect(webrtcErr).not.toContain('super-secret-token-xyz')

      // Reconnecting while webrtc is cooling down skips webrtc entirely and connects directly to lan.
      failoverClient.close()
      const attemptsBefore = failoverClient.getFailoverHistory().length
      await failoverClient.connect()
      const newAttempts = failoverClient.getFailoverHistory().slice(attemptsBefore)
      expect(newAttempts.map((a) => a.kind)).toEqual(['lan'])
      expect(typeof newAttempts[0]?.durationMs).toBe('number')

      failoverClient.resetCooldowns()
      expect(failoverClient.getConnectionDiagnostics().cooldownsMs).toBeUndefined()

      // When ALL candidates are dead/in-cooldown, failover still probes rather than permanently locking out.
      const deadClient = new FailoverRemoteClient({
        clientKeyPair: { publicKey: clientId.identity.publicKey, secretKey: clientId.secretKey },
        hostPublicKey: hostId.identity.publicKey,
        priorityOrder: ['lan'],
        failureCooldownMs: 30_000,
        lan: { endpointUrl: `ws://127.0.0.1:${deadPort}` },
      })
      await expect(deadClient.connect()).rejects.toThrow()
      await expect(deadClient.connect()).rejects.toThrow()
      expect(deadClient.getFailoverHistory().filter((h) => h.kind === 'lan')).toHaveLength(2)

      // Bounded history: 70 failed connection attempts cap at MAX_FAILOVER_HISTORY (64).
      for (let i = 0; i < 68; i += 1) {
        await expect(deadClient.connect()).rejects.toThrow()
      }
      expect(deadClient.getFailoverHistory().length).toBe(MAX_FAILOVER_HISTORY)
    } finally {
      failoverClient.close()
      await healthyLan.stop()
    }

    // History cap constant & secret sanitization checks.
    expect(MAX_FAILOVER_HISTORY).toBe(64)
    expect(
      sanitizeDiagnosticMessage(
        'failed ws://x?token=abc123 Bearer mySecret99 key=deadbeefdeadbeefdeadbeefdeadbeef\na=candidate:1 1 UDP 123 1.2.3.4 55 typ relay',
      ),
    ).toBe('failed ws://x?token=[REDACTED] Bearer [REDACTED] key=[REDACTED_HEX]\n[REDACTED_ICE]')

    // Direct-only WebRTC candidate filter ignores `typ relay`, retains host/srflx and end-of-candidates null.
    expect(
      shouldAllowIceCandidate(
        { candidate: 'candidate:1 1 udp 16777295 203.0.113.10 54321 typ relay raddr 10.0.0.1 rport 9999' },
        'direct-only',
      ),
    ).toBe(false)
    expect(
      shouldAllowIceCandidate(
        { candidate: 'candidate:2 1 udp 2122260223 192.168.1.20 50000 typ host' },
        'direct-only',
      ),
    ).toBe(true)
    expect(shouldAllowIceCandidate(null, 'direct-only')).toBe(true)
    expect(
      shouldAllowIceCandidate(
        { candidate: 'candidate:1 1 udp 16777295 203.0.113.10 54321 typ relay' },
        'all',
      ),
    ).toBe(true)
  })
})
