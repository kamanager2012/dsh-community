import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { readLiveControlEndpoint, writeLiveControlEndpoint } from '@dsh-community/dsh-bridge'
import { openPersistentRemoteStores } from '@dsh-community/remote-adapter/stores'
import {
  DesktopRemoteController,
  detectInstalledExternalEngines,
  parseConfirmPairingInput,
  parseDesktopRemoteSettings,
  parseRemoteGitInspectInput,
  parseRevokeDeviceInput,
  resolveDesktopRemoteConfigDir,
  resolveDesktopRemotePluginPath,
  resolveDesktopStandaloneHostPath,
  resolveEffectiveListenHost,
  validateRemoteStartInput,
  type DesktopRemoteContext,
} from '../src/remote.ts'

async function startMockControlServer(): Promise<{
  readonly baseUrl: string
  readonly requests: { method: string; url: string; body: unknown; auth: string }[]
  readonly close: () => Promise<void>
}> {
  const requests: { method: string; url: string; body: unknown; auth: string }[] = []
  let issuedCount = 0

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      let parsed: unknown = undefined
      if (rawBody.trim().length > 0) {
        try {
          parsed = JSON.parse(rawBody)
        } catch {
          parsed = rawBody
        }
      }
      const reqUrl = req.url ?? '/'
      requests.push({
        method: req.method ?? 'GET',
        url: reqUrl,
        body: parsed,
        auth: String(req.headers.authorization ?? ''),
      })

      res.setHeader('content-type', 'application/json')
      if (reqUrl === '/status') {
        res.end(
          JSON.stringify({
            hostFingerprint: 'fp-mock-host',
            lanEndpointUrl: 'ws://192.168.1.88:9443',
            relayUrl: 'wss://relay.example.com',
            relayRoomId: 'room-1',
            activeConnections: 1,
            pendingApprovals: 1,
            pendingQuestions: 0,
          }),
        )
        return
      }
      if (reqUrl === '/sessions') {
        res.end(
          JSON.stringify({
            sessions: [
              {
                id: 'sess-mock-1',
                title: 'Mock Live Session',
                status: 'running',
                preview: 'Inspecting diffs',
                model: { provider: 'deepseek', model: 'deepseek-chat' },
                pendingApprovals: 1,
              },
            ],
          }),
        )
        return
      }
      if (reqUrl === '/pairing/pending') {
        res.end(
          JSON.stringify({
            pending: [
              {
                candidateId: 'cand-abc',
                deviceId: 'dev-1',
                displayName: 'Test Phone',
                maxAllowedCapabilities: ['observe', 'prompt', 'approve', 'answer-question'],
                expiresAt: 1_900_000_000_000,
                state: 'pending',
              },
            ],
          }),
        )
        return
      }
      if (reqUrl === '/devices') {
        res.end(
          JSON.stringify({
            devices: [
              {
                deviceId: 'dev-trusted',
                displayName: 'Pixel 9 Pro',
                capabilities: ['observe', 'prompt'],
                pairedAt: 1_800_000_000_000,
                lastSeenAt: 1_800_000_100_000,
              },
            ],
          }),
        )
        return
      }
      if (reqUrl === '/pairing-token') {
        issuedCount += 1
        res.end(
          JSON.stringify({
            pairingJson: `{"v":1,"n":${String(issuedCount)}}`,
            deepLink: `dshremote://pair?v=1&seq=${String(issuedCount)}`,
            expiresAt: 1_900_000_200_000,
          }),
        )
        return
      }
      if (reqUrl === '/pairing/confirm') {
        res.end(JSON.stringify({ ok: true, displayName: 'Test Phone', deviceId: 'dev-1' }))
        return
      }
      if (reqUrl === '/devices/revoke') {
        res.end(JSON.stringify({ revoked: true }))
        return
      }
      if (reqUrl === '/shutdown') {
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (reqUrl === '/engines') {
        res.end(
          JSON.stringify({
            engines: [
              { id: 'codex', displayName: 'Codex CLI', available: true, version: '0.169.0' },
              { id: 'claude', displayName: 'Claude Code', available: false },
            ],
          }),
        )
        return
      }
      if (reqUrl.startsWith('/git/status')) {
        res.end(
          JSON.stringify({
            repoRoot: '/tmp/mock-repo',
            branch: 'feat/test',
            ahead: 1,
            behind: 0,
            clean: false,
            files: [{ path: 'src/index.ts', indexStatus: ' ', workTreeStatus: 'M', untracked: false }],
          }),
        )
        return
      }
      if (reqUrl.startsWith('/git/diff')) {
        res.end(
          JSON.stringify({
            repoRoot: '/tmp/mock-repo',
            diff: 'diff --git a/src/index.ts b/src/index.ts\n+export const ok = true\n',
            truncated: false,
          }),
        )
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'not found' }))
    })
  })

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') {
    throw new Error('expected TCP address')
  }
  return {
    baseUrl: `http://127.0.0.1:${String(addr.port)}`,
    requests,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  }
}

function makeTestContext(baseDir: string, overrides?: Partial<DesktopRemoteContext>): DesktopRemoteContext {
  const desktopRoot = join(baseDir, 'desktop-user-data')
  const dshHome = join(baseDir, 'official-dsh-home')
  const mainDir = join(baseDir, 'app-dist')
  const remoteBundleDir = join(baseDir, 'remote-bundle')
  mkdirSync(desktopRoot, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(mainDir, { recursive: true })
  mkdirSync(remoteBundleDir, { recursive: true })
  writeFileSync(join(remoteBundleDir, 'cordis-plugin.mjs'), 'export const name = "dsh-community-remote"\n')
  return {
    env: { DEEPSEEK_API_KEY: 'sk-test-dummy-value' },
    home: baseDir,
    desktopRoot,
    dshHome,
    isolated: false,
    isPackaged: false,
    mainDir,
    resourcesPath: join(baseDir, 'resources'),
    workspaceRoot: baseDir,
    launchPaths: () => ({
      nodeExecutable: process.execPath,
      cliEntry: join(baseDir, 'fake-dsh-cli.js'),
      cwd: baseDir,
      env: { DSH_HOME: dshHome },
      electronRunAsNode: false,
    }),
    ...overrides,
  }
}

describe('desktop remote controller & validators', () => {
  it('validates start settings and IPC payloads strictly', () => {
    const valid = validateRemoteStartInput({
      listenHost: ' 192.168.1.40 ',
      port: '9443',
      enableMdns: false,
      relayUrl: 'wss://relay.example.com/ws',
      signalingUrl: 'ws://192.168.1.40:8080',
      stunUrls: 'stun:stun.l.google.com:19302, stun:stun1.l.google.com:19302',
    })
    expect(valid).toEqual({
      ok: true,
      settings: {
        listenHost: '192.168.1.40',
        port: 9443,
        enableMdns: false,
        relayUrl: 'wss://relay.example.com/ws',
        signalingUrl: 'ws://192.168.1.40:8080',
        stunUrls: 'stun:stun.l.google.com:19302, stun:stun1.l.google.com:19302',
      },
    })

    expect(validateRemoteStartInput({ port: 70000 }).ok).toBe(false)
    expect(validateRemoteStartInput({ relayUrl: 'https://not-ws.example.com' }).ok).toBe(false)
    expect(validateRemoteStartInput({ stunUrls: 'https://bad-stun' }).ok).toBe(false)
    expect(validateRemoteStartInput({ listenHost: '127.0.0.1\nrm -rf' }).ok).toBe(false)

    expect(parseDesktopRemoteSettings({ port: 'bad', enableMdns: 'nope' })).toEqual({
      listenHost: '',
      port: 0,
      enableMdns: true,
      relayUrl: '',
      signalingUrl: '',
      stunUrls: '',
    })

    expect(parseConfirmPairingInput({ candidateId: 'cand_1-a', allowApprove: false })).toEqual({
      candidateId: 'cand_1-a',
      allowApprove: false,
    })
    expect(parseConfirmPairingInput({ candidateId: '../evil' })).toBeUndefined()

    expect(parseRevokeDeviceInput(' dev-123 ')).toBe('dev-123')
    expect(parseRevokeDeviceInput('   ')).toBeUndefined()
    expect(parseRevokeDeviceInput('dev with spaces')).toBeUndefined()

    expect(resolveEffectiveListenHost('', ['100.64.1.2', '192.168.1.10'])).toBe('100.64.1.2')
    expect(resolveEffectiveListenHost('0.0.0.0', ['192.168.1.10'])).toBe('0.0.0.0')
    expect(resolveEffectiveListenHost('', [])).toBe('127.0.0.1')
  })

  it('keeps remote trust storage outside official DSH_HOME and resolves packaged plugin paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-remote-paths-'))
    try {
      const ctx = makeTestContext(dir)
      const sharedDir = resolveDesktopRemoteConfigDir(ctx)
      expect(sharedDir).toBe(join(dir, '.config', 'dsh-community', 'remote'))
      const isolatedDir = resolveDesktopRemoteConfigDir({ ...ctx, isolated: true })
      expect(isolatedDir).toBe(join(ctx.desktopRoot, 'remote-isolated'))

      expect(() =>
        resolveDesktopRemoteConfigDir({
          ...ctx,
          env: { ...ctx.env, DSH_REMOTE_CONFIG_DIR: join(ctx.dshHome, 'remote') },
        }),
      ).toThrow(/outside official DSH_HOME/i)

      expect(resolveDesktopRemotePluginPath(ctx)).toBe(join(dir, 'remote-bundle', 'cordis-plugin.mjs'))
      const packagedRes = join(ctx.resourcesPath, 'remote', 'cordis-plugin.mjs')
      mkdirSync(join(ctx.resourcesPath, 'remote'), { recursive: true })
      writeFileSync(packagedRes, 'export const name = "dsh-community-remote"\n')
      expect(resolveDesktopRemotePluginPath({ ...ctx, isPackaged: true })).toBe(packagedRes)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('errors clearly when DEEPSEEK_API_KEY is missing and supports offline trust store listing/revocation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-remote-offline-'))
    try {
      const ctx = makeTestContext(dir, { env: {} })
      const configDir = resolveDesktopRemoteConfigDir(ctx)
      const stores = openPersistentRemoteStores({ configDir, dshHome: ctx.dshHome })
      const trusted = await stores.trustStore.trust({
        staticPublicKey: randomBytes(32),
        displayName: 'Offline Phone',
        grantedCapabilities: ['observe', 'prompt'],
        trustDomainId: 'domain-1',
      })

      const controller = new DesktopRemoteController({ getContext: () => ctx })
      await controller.start({ listenHost: '127.0.0.1', port: 9555, enableMdns: false })
      let snap = await controller.snapshot()
      expect(snap.phase).toBe('error')
      expect(snap.apiKeyPresent).toBe(false)
      expect(snap.error).toMatch(/DEEPSEEK_API_KEY/)
      expect(snap.settings.port).toBe(9555)
      expect(snap.devices).toHaveLength(1)
      expect(snap.devices[0]?.displayName).toBe('Offline Phone')

      await controller.revokeDevice(trusted.deviceId)
      snap = await controller.snapshot()
      expect(snap.devices[0]?.revokedAt).toBeTypeOf('number')
      expect(snap.notice).toMatch(/离线吊销/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('attaches to external live control server, confirms pairing without approve when toggled off, refreshes QR, and revokes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-remote-ext-'))
    const mock = await startMockControlServer()
    try {
      const ctx = makeTestContext(dir)
      const configDir = resolveDesktopRemoteConfigDir(ctx)
      mkdirSync(configDir, { recursive: true })
      writeLiveControlEndpoint(configDir, {
        pid: process.pid,
        controlUrl: mock.baseUrl,
        controlToken: 'ctrl-secret-123',
      })

      const controller = new DesktopRemoteController({ getContext: () => ctx })
      await controller.start({})
      const snap = await controller.snapshot()
      expect(snap.phase).toBe('external')
      expect(snap.pairing?.deepLink).toBe('dshremote://pair?v=1&seq=1')
      expect(snap.pairing?.qrSvg).toContain('<svg ')
      expect(snap.pendingCandidates).toHaveLength(1)
      expect(snap.devices[0]?.deviceId).toBe('dev-trusted')

      await controller.confirmPairing('cand-abc', false)
      const confirmReq = mock.requests.find((r) => r.url === '/pairing/confirm')
      expect(confirmReq?.auth).toBe('Bearer ctrl-secret-123')
      expect(confirmReq?.body).toEqual({
        candidateId: 'cand-abc',
        grantedCapabilities: ['observe', 'prompt', 'answer-question'],
      })

      await controller.revokeDevice('dev-trusted')
      expect(mock.requests.some((r) => r.url === '/devices/revoke')).toBe(true)

      await controller.stop()
      expect(mock.requests.some((r) => r.url === '/shutdown')).toBe(true)
    } finally {
      await mock.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('spawns owned remote host, writes patch YAML + ready state, and cleans up on shutdown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-remote-owned-'))
    const mock = await startMockControlServer()
    try {
      const ctx = makeTestContext(dir)
      const fakeCli = join(dir, 'fake-dsh-cli.js')
      writeFileSync(fakeCli, '#!/usr/bin/env node\n')

      let spawnedEnv: Record<string, string | undefined> = {}
      let spawnedPatch = ''
      let killed = false

      const fakeChild = new EventEmitter() as ChildProcess
      Object.assign(fakeChild, {
        pid: 54321,
        exitCode: null as number | null,
        killed: false,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => {
          killed = true
          ;(fakeChild as unknown as { exitCode: number | null }).exitCode = 0
          fakeChild.emit('exit', 0, null)
          return true
        },
      })

      const controller = new DesktopRemoteController({
        getContext: () => ctx,
        spawnFn: ((_exe: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
          spawnedEnv = { ...(opts.env ?? {}) }
          const patchIdx = args.indexOf('--patch')
          const patchPath = patchIdx >= 0 ? args[patchIdx + 1]! : ''
          spawnedPatch = readFileSync(patchPath, 'utf8')
          const readyPath = spawnedEnv.DSH_REMOTE_READY_FILE!
          setTimeout(() => {
            writeFileSync(
              readyPath,
              JSON.stringify({
                controlUrl: mock.baseUrl,
                deepLink: 'dshremote://pair?owned=1',
                pairingJson: '{"v":1,"owned":true}',
                lanUrl: 'ws://192.168.1.88:9443',
                hostFingerprint: 'fp-mock-host',
              }),
            )
          }, 20)
          return fakeChild
        }) as unknown as typeof import('node:child_process').spawn,
      })

      await controller.start({
        listenHost: '192.168.1.88',
        port: 9443,
        enableMdns: false,
      })
      const snap = await controller.snapshot()
      expect(snap.phase).toBe('running')
      expect(snap.pid).toBe('54321')
      expect(snap.pairing?.qrSvg).toContain('<svg ')
      expect(spawnedEnv.DSH_HOME).toBe(ctx.dshHome)
      expect(spawnedEnv.DSH_REMOTE_LAN_HOST).toBe('192.168.1.88')
      expect(spawnedEnv.DSH_REMOTE_LAN_PORT).toBe('9443')
      expect(spawnedEnv.DSH_REMOTE_ENABLE_MDNS).toBe('0')
      expect(spawnedPatch).toContain('dsh-community-remote')

      expect(controller.isRunning()).toBe(true)
      const liveSnap = await controller.snapshot({ refreshLive: true })
      expect(liveSnap.pendingApprovals).toBe(1)
      expect(liveSnap.liveSessions?.[0]?.title).toBe('Mock Live Session')
      expect(liveSnap.liveSessions?.[0]?.status).toBe('running')
      expect(liveSnap.liveSessions?.[0]?.model).toBe('deepseek-chat')
      const configDir = resolveDesktopRemoteConfigDir(ctx)
      expect(readLiveControlEndpoint(configDir)?.controlUrl).toBe(mock.baseUrl)

      // Fake stderr pairing notification updates pending count immediately.
      ;(fakeChild.stderr as PassThrough).write('DSH_REMOTE_PAIRING_REQUEST {}\n')
      await new Promise((r) => setTimeout(r, 40))
      expect(controller.pendingCount()).toBe(1)

      // Shutdown cleanly sends /shutdown, waits for exit, and removes .control.json.
      setTimeout(() => {
        if (fakeChild.exitCode === null) {
          ;(fakeChild as unknown as { exitCode: number | null }).exitCode = 0
          fakeChild.emit('exit', 0, null)
        }
      }, 20)
      await controller.shutdown()
      expect(controller.isRunning()).toBe(false)
      expect(existsSync(join(configDir, '.control.json'))).toBe(false)
      expect(killed).toBe(false)
    } finally {
      await mock.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('launches standalone multi-agent host without DEEPSEEK_API_KEY and inspects read-only Git diff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-multi-agent-'))
    const mock = await startMockControlServer()
    try {
      const binDir = join(dir, 'fake-bin')
      mkdirSync(binDir, { recursive: true })
      const fakeCodex = join(binDir, 'codex')
      writeFileSync(fakeCodex, '#!/bin/sh\necho codex 0.169.0\n', 'utf8')
      chmodSync(fakeCodex, 0o755)

      const ctx = makeTestContext(dir, {
        env: { PATH: binDir },
      })
      const standaloneEntry = join(dir, 'remote-bundle', 'standalone-cli.mjs')
      writeFileSync(standaloneEntry, 'export async function runStandaloneMultiAgentHost() {}\n', 'utf8')
      expect(detectInstalledExternalEngines(ctx.env)).toEqual(['codex'])
      expect(resolveDesktopStandaloneHostPath(ctx)).toBe(standaloneEntry)

      expect(validateRemoteStartInput({ engines: 'invalid-engine' }).ok).toBe(false)
      expect(validateRemoteStartInput({ engines: 'Claude, Codex' })).toMatchObject({
        ok: true,
        settings: { engines: 'claude,codex' },
      })
      expect(parseDesktopRemoteSettings({ engines: 'codex' }).engines).toBe('codex')
      expect(parseRemoteGitInspectInput({ clear: true })).toEqual({ action: 'clear' })
      expect(parseRemoteGitInspectInput({ sessionId: 'bad id' })).toBeUndefined()
      expect(parseRemoteGitInspectInput({ sessionId: 'codex:s1', path: 'src/index.ts' })).toEqual({
        action: 'inspect',
        sessionId: 'codex:s1',
        path: 'src/index.ts',
      })

      let spawnedArgs: readonly string[] = []
      let spawnedEnv: Record<string, string | undefined> = {}
      const fakeChild = Object.assign(new EventEmitter(), {
        pid: 65432,
        exitCode: null as number | null,
        killed: false,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => {
          ;(fakeChild as unknown as { exitCode: number | null }).exitCode = 0
          fakeChild.emit('exit', 0, null)
          return true
        },
      })

      const controller = new DesktopRemoteController({
        getContext: () => ctx,
        spawnFn: ((_exe: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
          spawnedArgs = args
          spawnedEnv = { ...(opts.env ?? {}) }
          const readyPath = spawnedEnv.DSH_REMOTE_READY_FILE!
          setTimeout(() => {
            writeFileSync(
              readyPath,
              JSON.stringify({
                mode: 'multi-agent-standalone',
                controlUrl: mock.baseUrl,
                deepLink: 'dshremote://pair?multi=1',
                pairingJson: '{"v":1,"multi":true}',
                lanUrl: 'ws://192.168.1.99:9555',
                hostFingerprint: 'fp-multi-agent',
              }),
            )
          }, 15)
          return fakeChild
        }) as unknown as typeof import('node:child_process').spawn,
      })

      await controller.start({ engines: 'codex' })
      expect(spawnedArgs).toEqual([standaloneEntry])
      expect(spawnedEnv.DSH_REMOTE_ENGINES).toBe('codex')

      await controller.inspectSessionGit({ sessionId: 'codex:mock-1', path: 'src/index.ts' })
      const snap = await controller.snapshot({ refreshLive: true })
      expect(snap.phase).toBe('running')
      expect(snap.engines?.find((e) => e.id === 'codex')?.available).toBe(true)
      expect(snap.gitPreview?.branch).toBe('feat/test')
      expect(snap.gitPreview?.staged).toBe(false)
      expect(snap.gitPreview?.files[0]?.path).toBe('src/index.ts')
      expect(snap.gitPreview?.diffText).toContain('+export const ok = true')

      await controller.inspectSessionGit({ sessionId: 'codex:mock-1', path: 'src/index.ts', staged: true })
      const stagedSnap = await controller.snapshot({ refreshLive: false })
      expect(stagedSnap.gitPreview?.staged).toBe(true)
      expect(stagedSnap.gitPreview?.diffPath).toBe('src/index.ts')

      await controller.inspectSessionGit({ clear: true })
      const cleared = await controller.snapshot({ refreshLive: false })
      expect(cleared.gitPreview).toBeUndefined()

      await controller.shutdown()
    } finally {
      await mock.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
