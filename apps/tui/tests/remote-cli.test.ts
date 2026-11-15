import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openPersistentRemoteStores, stunBindingProbe } from '@dsh-community/remote-adapter'
import { COMMUNITY_TUI_HELP, parseCommunityLaunch } from '../src/launch.js'
import {
  buildLoopbackPairingWarning,
  COMMUNITY_REMOTE_HELP,
  composeRemoteHostPatchYaml,
  detectLanIpv4Candidates,
  formatColoredDiff,
  formatGitStatusSummary,
  formatPairingQrBlock,
  parseRemoteReplLine,
  REMOTE_REPL_COMMAND_SUMMARY,
  resolveRemoteCordisPluginUrl,
  runRemoteCommand,
} from '../src/remote.js'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

function captureOutputs(): {
  readonly stdout: () => string
  readonly stderr: () => string
} {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as typeof process.stdout.write)
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    err += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as typeof process.stderr.write)
  return {
    stdout: () => out,
    stderr: () => err,
  }
}

describe('dsh-community remote CLI routing and subcommands', () => {
  it('routes remote and --remote flags cleanly via parseCommunityLaunch', () => {
    expect(COMMUNITY_TUI_HELP).toContain('remote')
    expect(parseCommunityLaunch(['remote', 'start', '--mdns'])).toEqual({
      kind: 'remote',
      rest: ['start', '--mdns'],
    })
    expect(parseCommunityLaunch(['--remote', 'devices', '--json'])).toEqual({
      kind: 'remote',
      rest: ['devices', '--json'],
    })
    expect(parseCommunityLaunch(['tui', 'remote', 'status', '--json'])).toEqual({
      kind: 'remote',
      rest: ['status', '--json'],
    })
  })

  it('composes official headless Cordis patch YAML disabling conflicting plugins and setting ask approval', () => {
    const patch = composeRemoteHostPatchYaml({
      pluginUrl: 'file:///opt/dsh/cordis-plugin.js',
      workspaceRoot: '/tmp/work',
    })
    expect(patch).toContain('- id: hmr')
    expect(patch).toContain('- id: headless-startup')
    expect(patch).toContain('- id: headless-runner')
    expect(patch).toContain('- id: sandbox-policy')
    expect(patch).toContain('mode: workspace-write')
    expect(patch).toContain('workspaceRoot: "/tmp/work"')
    expect(patch).toContain('policy: ask')
    expect(patch).toContain('- id: dsh-community-remote')
    expect(patch).toContain('name: "file:///opt/dsh/cordis-plugin.js"')
  })

  it('prints help for remote --help without requiring DEEPSEEK_API_KEY', async () => {
    const io = captureOutputs()
    const code = await runRemoteCommand(['--help'], {})
    expect(code).toBe(0)
    expect(io.stdout()).toBe(COMMUNITY_REMOTE_HELP)
    expect(io.stderr()).toBe('')
  })

  it('reports isolated configDir outside DSH_HOME via remote status --json', async () => {
    const root = makeTempDir('dsh-remote-cli-')
    const dshHome = join(root, 'official-dsh-home')
    const homeDir = join(root, 'user-home')
    const xdgConfig = join(root, 'xdg-config')
    const io = captureOutputs()

    const code = await runRemoteCommand(
      ['status', '--json'],
      { HOME: homeDir, XDG_CONFIG_HOME: xdgConfig, DSH_HOME: dshHome },
      dshHome,
    )
    expect(code).toBe(0)
    const status = JSON.parse(io.stdout()) as {
      configDir: string
      dshHome: string
      hostIdentityInitialized: boolean
      activeDevices: number
      revokedDevices: number
    }
    expect(resolve(status.dshHome)).toBe(resolve(dshHome))
    expect(resolve(status.configDir).startsWith(resolve(dshHome) + sep)).toBe(false)
    expect(resolve(status.configDir)).not.toBe(resolve(dshHome))
    expect(status.hostIdentityInitialized).toBe(false)
    expect(status.activeDevices).toBe(0)
    expect(status.revokedDevices).toBe(0)
  })

  it('refuses to place DSH_REMOTE_CONFIG_DIR inside DSH_HOME', async () => {
    const root = makeTempDir('dsh-remote-cli-inside-')
    const dshHome = join(root, 'official-dsh-home')
    const insideConfigDir = join(dshHome, 'community-remote')

    await expect(
      runRemoteCommand(
        ['status', '--json'],
        { DSH_HOME: dshHome, DSH_REMOTE_CONFIG_DIR: insideConfigDir },
        dshHome,
      ),
    ).rejects.toThrow()
  })

  it('lists and revokes paired devices via remote devices --json and remote revoke', async () => {
    const root = makeTempDir('dsh-remote-cli-devices-')
    const dshHome = join(root, 'official-dsh-home')
    const configDir = join(root, 'community-remote-config')
    const env: NodeJS.ProcessEnv = {
      DSH_HOME: dshHome,
      DSH_REMOTE_CONFIG_DIR: configDir,
    }

    const stores = openPersistentRemoteStores({ configDir, dshHome })
    const hostPub = await stores.hostIdentityStore.getPublicIdentity()
    const record = stores.trustStore.trustSync({
      staticPublicKey: new Uint8Array(32).fill(9),
      displayName: 'Pixel Test Device',
      grantedCapabilities: ['observe', 'prompt', 'approve'],
      trustDomainId: hostPub.trustDomainId,
    })

    const ioDevicesBefore = captureOutputs()
    expect(await runRemoteCommand(['devices', '--json'], env, dshHome)).toBe(0)
    const beforePayload = JSON.parse(ioDevicesBefore.stdout()) as {
      devices: Array<{ deviceId: string; displayName: string; revokedAt?: number }>
    }
    expect(beforePayload.devices).toHaveLength(1)
    expect(beforePayload.devices[0]?.deviceId).toBe(record.deviceId)
    expect(beforePayload.devices[0]?.displayName).toBe('Pixel Test Device')
    expect(beforePayload.devices[0]?.revokedAt).toBeUndefined()

    vi.restoreAllMocks()
    const ioRevoke = captureOutputs()
    expect(await runRemoteCommand(['revoke', record.deviceId], env, dshHome)).toBe(0)
    expect(ioRevoke.stdout()).toContain(record.deviceId)

    vi.restoreAllMocks()
    const ioStatus = captureOutputs()
    expect(await runRemoteCommand(['status', '--json'], env, dshHome)).toBe(0)
    const status = JSON.parse(ioStatus.stdout()) as {
      hostIdentityInitialized: boolean
      hostFingerprint: string
      activeDevices: number
      revokedDevices: number
    }
    expect(status.hostIdentityInitialized).toBe(true)
    expect(status.hostFingerprint).toBe(hostPub.fingerprint)
    expect(status.activeDevices).toBe(0)
    expect(status.revokedDevices).toBe(1)

    vi.restoreAllMocks()
    const ioRevokeMissing = captureOutputs()
    expect(await runRemoteCommand(['revoke', 'nonexistent-device'], env, dshHome)).toBe(1)
    expect(ioRevokeMissing.stderr()).toContain('nonexistent-device')
  })

function ensureBuiltTuiBin(): string {
  const pkgRoot = resolve(import.meta.dirname, '..')
  const binPath = resolve(pkgRoot, 'dist', 'bin.js')
  const srcPath = resolve(pkgRoot, 'src', 'remote.ts')
  const needsBuild = !existsSync(binPath) || statSync(srcPath).mtimeMs > statSync(binPath).mtimeMs
  if (needsBuild) {
    const buildRes = spawnSync('pnpm', ['--filter', '@dsh-community/tui...', 'build'], {
      cwd: resolve(pkgRoot, '..', '..'),
      encoding: 'utf8',
    })
    expect(buildRes.status, buildRes.stderr).toBe(0)
  }
  return binPath
}

async function spawnCliUntilReadyJson<T>(
  binPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{
  ready: T
  stopAndWait: () => Promise<number>
}> {
  return await new Promise((resolveReady, rejectReady) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdoutBuf = ''
    let stderrBuf = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        rejectReady(new Error(`Timed out waiting for CLI ready JSON (${args.join(' ')}): ${stderrBuf}`))
      }
    }, 10_000)

    const stopAndWait = (): Promise<number> =>
      new Promise((resolveExit) => {
        if (child.exitCode !== null) {
          resolveExit(child.exitCode)
          return
        }
        child.once('exit', (code) => resolveExit(code ?? 0))
        child.kill('SIGTERM')
      })

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8')
    })
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8')
      const nl = stdoutBuf.indexOf('\n')
      if (nl !== -1 && !settled) {
        settled = true
        clearTimeout(timer)
        try {
          resolveReady({
            ready: JSON.parse(stdoutBuf.slice(0, nl).trim()) as T,
            stopAndWait,
          })
        } catch (err) {
          void stopAndWait()
          rejectReady(err)
        }
      }
    })
    child.once('exit', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        rejectReady(new Error(`CLI exited (${code}) before ready JSON: ${stderrBuf}`))
      }
    })
  })
}

  it('executes built bin.js remote subcommands cleanly without DEEPSEEK_API_KEY and fails closed on remote start', () => {
    const root = makeTempDir('dsh-remote-bin-')
    const dshHome = join(root, 'official-dsh-home')
    const configDir = join(root, 'community-remote-config')
    const binPath = ensureBuiltTuiBin()
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_REMOTE_CONFIG_DIR: configDir,
    }
    delete childEnv.DEEPSEEK_API_KEY

    const helpRes = spawnSync(process.execPath, [binPath, 'remote', '--help'], {
      env: childEnv,
      encoding: 'utf8',
    })
    expect(helpRes.status, helpRes.stderr).toBe(0)
    expect(helpRes.stdout).toBe(COMMUNITY_REMOTE_HELP)

    const statusRes = spawnSync(process.execPath, [binPath, 'remote', 'status', '--json'], {
      env: childEnv,
      encoding: 'utf8',
    })
    expect(statusRes.status).toBe(0)
    const parsed = JSON.parse(statusRes.stdout) as { configDir: string; dshHome: string }
    expect(resolve(parsed.configDir)).toBe(resolve(configDir))
    expect(resolve(parsed.dshHome)).toBe(resolve(dshHome))

    const emptyBinDir = makeTempDir('dsh-remote-no-agents-')
    const startNoAgentsRes = spawnSync(process.execPath, [binPath, 'remote', 'start'], {
      env: { ...childEnv, PATH: emptyBinDir },
      encoding: 'utf8',
    })
    expect(startNoAgentsRes.status).toBe(2)
    expect(startNoAgentsRes.stderr).toContain('DEEPSEEK_API_KEY')

    const startDshOnlyRes = spawnSync(process.execPath, [binPath, 'remote', 'start', '--engines', 'dsh'], {
      env: childEnv,
      encoding: 'utf8',
    })
    expect(startDshOnlyRes.status).toBe(2)
    expect(startDshOnlyRes.stderr).toContain('DEEPSEEK_API_KEY')
  })

  it('launches self-hosted BlindRelayServer via remote relay --json without leaking hostSecret', async () => {
    const binPath = ensureBuiltTuiBin()
    const secret = 'relay-cli-secret-do-not-echo'
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_REMOTE_RELAY_HOST_SECRET: secret,
    }
    delete childEnv.DEEPSEEK_API_KEY

    const { ready, stopAndWait } = await spawnCliUntilReadyJson<{
      kind: string
      host: string
      port: number
      endpointUrl: string
      healthzUrl: string
      authRequired: boolean
    }>(binPath, ['remote', 'relay', '--host', '127.0.0.1', '--port', '0', '--json'], childEnv)

    try {
      expect(ready.kind).toBe('blind-relay')
      expect(ready.host).toBe('127.0.0.1')
      expect(ready.port).toBeGreaterThan(0)
      expect(ready.endpointUrl).toBe(`ws://127.0.0.1:${ready.port}`)
      expect(ready.authRequired).toBe(true)
      expect(JSON.stringify(ready)).not.toContain(secret)

      const res = await fetch(ready.healthzUrl)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    } finally {
      expect(await stopAndWait()).toBe(0)
    }
  })

  it('launches self-hosted WebRTC signaling + STUN via remote signaling --json and fails closed on wildcard without opt-in', async () => {
    const binPath = ensureBuiltTuiBin()
    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    delete childEnv.DEEPSEEK_API_KEY

    // Wildcard bind without --allow-wildcard must fail closed
    const denied = await runRemoteCommand(
      ['signaling', '--host', '0.0.0.0', '--port', '0'],
      childEnv,
    )
    expect(denied).toBe(1)

    const { ready, stopAndWait } = await spawnCliUntilReadyJson<{
      kind: string
      host: string
      port: number
      endpointUrl: string
      healthzUrl: string
      authRequired: boolean
      stunUrl?: string
    }>(
      binPath,
      ['remote', 'signaling', '--host', '127.0.0.1', '--port', '0', '--stun-port', '0', '--json'],
      childEnv,
    )

    try {
      expect(ready.kind).toBe('webrtc-signaling')
      expect(ready.host).toBe('127.0.0.1')
      expect(ready.port).toBeGreaterThan(0)
      expect(ready.authRequired).toBe(false)
      expect(ready.stunUrl).toMatch(/^stun:127\.0\.0\.1:\d+$/u)

      const res = await fetch(ready.healthzUrl)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })

      const stunPort = Number(ready.stunUrl!.split(':').pop())
      const mapped = await stunBindingProbe({
        serverHost: '127.0.0.1',
        serverPort: stunPort,
        timeoutMs: 2_000,
      })
      expect(mapped.address).toBe('127.0.0.1')
      expect(mapped.port).toBeGreaterThan(0)
    } finally {
      expect(await stopAndWait()).toBe(0)
    }
  })

  it('detects RFC1918/Tailscale LAN IPv4s, warns on loopback-only remote start, and renders terminal QR', async () => {
    const lanIps = detectLanIpv4Candidates({
      lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
      eth0: [
        { address: '192.168.1.25', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:01', internal: false, cidr: '192.168.1.25/24' },
        { address: '169.254.1.2', netmask: '255.255.0.0', family: 'IPv4', mac: '00:00:00:00:00:01', internal: false, cidr: '169.254.1.2/16' },
        { address: '100.64.0.9', netmask: '255.192.0.0', family: 'IPv4', mac: '00:00:00:00:00:01', internal: false, cidr: '100.64.0.9/10' },
      ],
    })
    expect(lanIps).toEqual(['100.64.0.9', '192.168.1.25'])

    const warnLoopback = buildLoopbackPairingWarning({ endpointUrl: 'ws://127.0.0.1:4555' }, lanIps)
    expect(warnLoopback).toContain('100.64.0.9, 192.168.1.25')
    expect(buildLoopbackPairingWarning({ endpointUrl: 'ws://192.168.1.25:4555' }, lanIps)).toBeUndefined()
    expect(
      buildLoopbackPairingWarning(
        { endpointUrl: 'ws://127.0.0.1:4555', relayUrl: 'wss://relay.example.com' },
        lanIps,
      ),
    ).toBeUndefined()

    const qrBlock = formatPairingQrBlock('dsh-remote://pair?data=dGVzdA', false)
    expect(qrBlock).toContain('█')

    expect(COMMUNITY_REMOTE_HELP).toContain('--qr')
    const io = captureOutputs()
    const missingKeyCode = await runRemoteCommand(['start', '--qr'], {})
    expect(missingKeyCode).toBe(2)
    expect(io.stderr()).not.toContain('未知参数')
  })

  it('routes remote revoke through live .control.json endpoint when running host control server answers', async () => {
    const root = makeTempDir('dsh-remote-cli-live-revoke-')
    const dshHome = join(root, 'official-dsh-home')
    const configDir = join(root, 'community-remote-config')
    const stores = openPersistentRemoteStores({ configDir, dshHome })
    const hostPub = await stores.hostIdentityStore.getPublicIdentity()
    const record = stores.trustStore.trustSync({
      staticPublicKey: new Uint8Array(32).fill(12),
      displayName: 'Live Revoke Phone',
      grantedCapabilities: ['observe'],
      trustDomainId: hostPub.trustDomainId,
    })

    const revokedIds: string[] = []
    const token = 'test-live-control-token'
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/devices/revoke' && req.headers.authorization === `Bearer ${token}`) {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { deviceId: string }
        const ok = await stores.trustStore.revoke(body.deviceId)
        revokedIds.push(body.deviceId)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, revoked: ok, deviceId: body.deviceId }))
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))

    try {
      const addr = server.address() as { port: number }
      const controlPath = join(stores.configDir, '.control.json')
      writeFileSync(
        controlPath,
        JSON.stringify({
          pid: process.pid,
          controlUrl: `http://127.0.0.1:${addr.port}`,
          controlToken: token,
        }),
        { mode: 0o600 },
      )
      if (process.platform !== 'win32') chmodSync(controlPath, 0o600)

      const io = captureOutputs()
      const code = await runRemoteCommand(
        ['revoke', record.deviceId],
        { DSH_HOME: dshHome, DSH_REMOTE_CONFIG_DIR: configDir },
        dshHome,
      )
      expect(code).toBe(0)
      expect(revokedIds).toEqual([record.deviceId])
      expect(io.stdout()).toContain('在线会话已断开')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('prints help and exits 0 for remote subcommand --help/-h without throwing 未知参数', async () => {
    for (const argv of [
      ['start', '--help'],
      ['start', '-h'],
      ['relay', '--help'],
      ['signaling', '-h'],
      ['devices', '--help'],
      ['status', '--help'],
      ['revoke', '--help'],
    ]) {
      const io = captureOutputs()
      const code = await runRemoteCommand(argv, {})
      expect(code, argv.join(' ')).toBe(0)
      expect(io.stdout(), argv.join(' ')).toBe(COMMUNITY_REMOTE_HELP)
      expect(io.stderr(), argv.join(' ')).toBe('')
    }

    const badIo = captureOutputs()
    const badCode = await runRemoteCommand(['start', '--unknown-option'], {})
    expect(badCode).toBe(2)
    expect(badIo.stderr()).toContain('未知参数: --unknown-option')
  })

  it('resolves @dsh-community/remote-adapter/cordis-plugin via ESM exports without ERR_PACKAGE_PATH_NOT_EXPORTED', () => {
    const pluginUrl = resolveRemoteCordisPluginUrl()
    expect(pluginUrl.startsWith('file://')).toBe(true)
    expect(existsSync(new URL(pluginUrl))).toBe(true)
  })

  it('rejects unknown flags on remote status, devices, and revoke instead of exiting 0 silently', async () => {
    const root = makeTempDir('dsh-remote-cli-flags-')
    const env: NodeJS.ProcessEnv = {
      DSH_HOME: join(root, 'dsh'),
      DSH_REMOTE_CONFIG_DIR: join(root, 'cfg'),
    }
    for (const argv of [
      ['status', '--bogus'],
      ['devices', '--bogus'],
      ['revoke', 'dev-1', '--bogus'],
    ]) {
      const io = captureOutputs()
      const code = await runRemoteCommand(argv, env, join(root, 'dsh'))
      expect(code, argv.join(' ')).toBe(2)
      expect(io.stderr(), argv.join(' ')).toContain('未知参数: --bogus')
      vi.restoreAllMocks()
    }
  })

  it('fails closed when live control server returns a non-404 error on revoke', async () => {
    const root = makeTempDir('dsh-remote-cli-revoke-err-')
    const dshHome = join(root, 'dsh')
    const configDir = join(root, 'cfg')
    const stores = openPersistentRemoteStores({ configDir, dshHome })
    const hostPub = await stores.hostIdentityStore.getPublicIdentity()
    const record = stores.trustStore.trustSync({
      staticPublicKey: new Uint8Array(32).fill(15),
      displayName: 'AuthErr Phone',
      grantedCapabilities: ['observe'],
      trustDomainId: hostPub.trustDomainId,
    })

    const server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('invalid control token')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    try {
      const addr = server.address() as { port: number }
      const controlPath = join(stores.configDir, '.control.json')
      writeFileSync(
        controlPath,
        JSON.stringify({ pid: process.pid, controlUrl: `http://127.0.0.1:${addr.port}`, controlToken: 'bad' }),
        { mode: 0o600 },
      )
      const io = captureOutputs()
      const code = await runRemoteCommand(['revoke', record.deviceId], { DSH_HOME: dshHome, DSH_REMOTE_CONFIG_DIR: configDir }, dshHome)
      expect(code).toBe(1)
      expect(io.stderr()).toContain('401')
      // Durable store must remain unrevoked so host state stays honest
      const stillActive = (await stores.trustStore.list()).find((d) => d.deviceId === record.deviceId)
      expect(stillActive?.revokedAt).toBeUndefined()
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('parses interactive remote start REPL commands with explicit usage and unknown feedback', () => {
    expect(REMOTE_REPL_COMMAND_SUMMARY).toContain('help')
    expect(REMOTE_REPL_COMMAND_SUMMARY).toContain('status')
    expect(REMOTE_REPL_COMMAND_SUMMARY).toContain('engines')
    expect(REMOTE_REPL_COMMAND_SUMMARY).toContain('git <sessionId>')
    expect(REMOTE_REPL_COMMAND_SUMMARY).toContain('diff <sessionId> [path]')
    expect(parseRemoteReplLine('')).toEqual({ kind: 'empty' })
    expect(parseRemoteReplLine('engines')).toEqual({ kind: 'engines' })
    expect(parseRemoteReplLine('git')).toEqual({ kind: 'usage', usage: '用法: git <sessionId>' })
    expect(parseRemoteReplLine('git codex:s1')).toEqual({ kind: 'git', sessionId: 'codex:s1' })
    expect(parseRemoteReplLine('diff')).toEqual({ kind: 'usage', usage: '用法: diff <sessionId> [path] [--staged]' })
    expect(parseRemoteReplLine('diff codex:s1 src/app.ts')).toEqual({
      kind: 'diff',
      sessionId: 'codex:s1',
      path: 'src/app.ts',
    })
    expect(parseRemoteReplLine('diff codex:s1 --staged')).toEqual({
      kind: 'diff',
      sessionId: 'codex:s1',
      staged: true,
    })
    expect(parseRemoteReplLine('diff codex:s1 src/app.ts --staged')).toEqual({
      kind: 'diff',
      sessionId: 'codex:s1',
      path: 'src/app.ts',
      staged: true,
    })

    const coloredDiff = formatColoredDiff(
      'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      true,
    )
    expect(coloredDiff).toContain('\x1b[1;36mdiff --git')
    expect(coloredDiff).toContain('\x1b[32m+new\x1b[0m')
    expect(coloredDiff).toContain('\x1b[31m-old\x1b[0m')
    const plainDiff = formatColoredDiff('+a\n-b\n', false)
    expect(plainDiff).toContain('(+1 / -1 lines)')
    expect(plainDiff).not.toContain('\x1b[')

    const statusSummary = formatGitStatusSummary(
      JSON.stringify({
        branch: 'feat/ux',
        repoRoot: '/tmp/repo',
        ahead: 1,
        behind: 0,
        files: [{ path: 'src/main.ts', indexStatus: ' ', workTreeStatus: 'M', untracked: false }],
      }),
      false,
    )
    expect(statusSummary).toContain('Branch: feat/ux (↑1 ↓0)')
    expect(statusSummary).toContain('[M] src/main.ts')
    expect(parseRemoteReplLine('confirm')).toEqual({
      kind: 'usage',
      usage: '用法: confirm <candidateId> [cap1,cap2,...]',
    })
    expect(parseRemoteReplLine('confirm cand-42')).toEqual({ kind: 'confirm', candidateId: 'cand-42' })
    expect(parseRemoteReplLine('confirm cand-42 observe,session.manage')).toEqual({
      kind: 'confirm',
      candidateId: 'cand-42',
      capabilities: ['observe', 'session.manage'],
    })
    expect(parseRemoteReplLine('grant dev-9 command.execute,approve')).toEqual({
      kind: 'grant',
      deviceId: 'dev-9',
      capabilities: ['command.execute', 'approve'],
    })
    expect(parseRemoteReplLine('revoke-cap dev-9 command.execute')).toEqual({
      kind: 'revoke-cap',
      deviceId: 'dev-9',
      capabilities: ['command.execute'],
    })
    expect(parseRemoteReplLine('revoke')).toEqual({ kind: 'usage', usage: '用法: revoke <deviceId>' })
    expect(parseRemoteReplLine('revoke dev-9')).toEqual({ kind: 'revoke', deviceId: 'dev-9' })
    expect(parseRemoteReplLine('foobar')).toEqual({ kind: 'unknown', command: 'foobar' })
    expect(parseRemoteReplLine('help')).toEqual({ kind: 'help' })
    expect(parseRemoteReplLine('exit')).toEqual({ kind: 'quit' })
  })

  it('starts multi-agent standalone host via remote start --engines codex --json without DEEPSEEK_API_KEY', async () => {
    const root = makeTempDir('dsh-remote-standalone-cli-')
    const dshHome = join(root, 'official-dsh-home')
    const configDir = join(root, 'community-remote-config')
    const repoDir = join(root, 'repo')
    const fakeBinDir = join(root, 'bin')
    mkdirSync(repoDir, { recursive: true })
    mkdirSync(fakeBinDir, { recursive: true })
    const fakeCodex = join(fakeBinDir, 'codex')
    writeFileSync(
      fakeCodex,
      '#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("codex-cli 0.169.0"); process.exit(0); }\nprocess.exit(0);\n',
      'utf8',
    )
    chmodSync(fakeCodex, 0o755)

    const binPath = ensureBuiltTuiBin()
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      HOME: root,
      CODEX_HOME: join(root, '.codex'),
      DSH_HOME: dshHome,
      DSH_REMOTE_CONFIG_DIR: configDir,
    }
    delete childEnv.DEEPSEEK_API_KEY

    const { ready, stopAndWait } = await spawnCliUntilReadyJson<{
      mode: string
      controlUrl: string
      controlToken: string
      deepLink: string
      lanUrl: string
      engines: Array<{ id: string; available: boolean; version?: string }>
    }>(binPath, ['remote', 'start', '--engines', 'codex', '--json', '--cwd', repoDir], childEnv)

    try {
      expect(ready.mode).toBe('multi-agent-standalone')
      expect(ready.deepLink).toContain('pair')
      expect(ready.lanUrl).toMatch(/^ws:\/\//u)
      const codexEngine = ready.engines.find((e) => e.id === 'codex')
      expect(codexEngine?.available).toBe(true)
      expect(codexEngine?.version).toContain('0.169.0')

      const enginesRes = await fetch(`${ready.controlUrl}/engines`, {
        headers: { authorization: `Bearer ${ready.controlToken}` },
      })
      expect(enginesRes.status).toBe(200)
      const enginesJson = (await enginesRes.json()) as { engines: Array<{ id: string; available: boolean }> }
      expect(enginesJson.engines.some((e) => e.id === 'codex' && e.available)).toBe(true)
    } finally {
      expect(await stopAndWait()).toBe(0)
    }
  })

  it('validates unified DSH_REMOTE_DEFAULT_* transport defaults and rejects turn:/non-ws schemes', async () => {
    expect(COMMUNITY_REMOTE_HELP).toContain('DSH_REMOTE_DEFAULT_SIGNALING_URL')
    expect(COMMUNITY_REMOTE_HELP).toContain('DSH_REMOTE_DEFAULT_STUN_URLS')

    const root = makeTempDir('dsh-remote-defaults-cli-')
    const dshHome = join(root, 'official-dsh-home')
    const configDir = join(root, 'community-remote-config')
    const baseEnv: NodeJS.ProcessEnv = {
      DSH_HOME: dshHome,
      DSH_REMOTE_CONFIG_DIR: configDir,
      DEEPSEEK_API_KEY: 'sk-test-default-check',
    }

    const ioBadStun = captureOutputs()
    expect(
      await runRemoteCommand(
        ['start', '--cwd', root],
        { ...baseEnv, DSH_REMOTE_DEFAULT_STUN_URLS: 'turn:relay.example.com:3478' },
        dshHome,
      ),
    ).toBe(2)
    expect(ioBadStun.stderr()).toContain('DSH_REMOTE_DEFAULT_STUN_URLS')
    expect(ioBadStun.stderr()).toContain('turn:')

    vi.restoreAllMocks()
    const ioBadSig = captureOutputs()
    expect(
      await runRemoteCommand(
        ['start', '--cwd', root],
        { ...baseEnv, DSH_REMOTE_DEFAULT_SIGNALING_URL: 'https://not-ws.example.com' },
        dshHome,
      ),
    ).toBe(2)
    expect(ioBadSig.stderr()).toContain('DSH_REMOTE_DEFAULT_SIGNALING_URL')
    expect(ioBadSig.stderr()).toContain('ws:// 或 wss://')
  })

  it('spawns dsh-community remote gateway with --web-dir and includes webPairingUrl on remote start --web-url', async () => {
    expect(COMMUNITY_REMOTE_HELP).toContain('dsh-community remote gateway')
    expect(COMMUNITY_REMOTE_HELP).toContain('--web-url')

    const root = makeTempDir('dsh-remote-gateway-cli-')
    const dshHome = join(root, 'official-dsh-home')
    const configDir = join(root, 'community-remote-config')
    const repoDir = join(root, 'repo')
    const fakeBinDir = join(root, 'fake-bin')
    const webDir = join(root, 'pwa-dist')
    mkdirSync(repoDir, { recursive: true })
    mkdirSync(fakeBinDir, { recursive: true })
    mkdirSync(webDir, { recursive: true })
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><html><body>PWA</body></html>\n', 'utf8')

    const fakeCodex = join(fakeBinDir, 'codex')
    writeFileSync(
      fakeCodex,
      [
        '#!/usr/bin/env node',
        'if (process.argv[2] === "--version") { console.log("codex-cli 0.169.0"); process.exit(0); }',
        'process.exit(0);',
      ].join('\n'),
      'utf8',
    )
    chmodSync(fakeCodex, 0o755)

    const binPath = ensureBuiltTuiBin()
    const gwEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_REMOTE_GATEWAY_HOST_SECRET: 'gw-cli-secret',
    }
    const { ready: gwReady, stopAndWait: stopGateway } = await spawnCliUntilReadyJson<{
      kind: string
      relayEndpointUrl: string
      signalingEndpointUrl: string
      healthzUrl: string
      webAppUrl?: string
      authRequired: boolean
    }>(binPath, ['remote', 'gateway', '--port', '0', '--web-dir', webDir, '--json'], gwEnv)

    try {
      expect(gwReady.kind).toBe('blind-gateway')
      expect(gwReady.relayEndpointUrl.endsWith('/relay')).toBe(true)
      expect(gwReady.signalingEndpointUrl.endsWith('/signal')).toBe(true)
      expect(gwReady.webAppUrl?.endsWith('/app/')).toBe(true)
      expect(gwReady.authRequired).toBe(true)
      expect(JSON.stringify(gwReady)).not.toContain('gw-cli-secret')

      const healthRes = await fetch(gwReady.healthzUrl)
      expect(healthRes.status).toBe(200)
      const appRes = await fetch(gwReady.webAppUrl!)
      expect(appRes.status).toBe(200)
      expect(await appRes.text()).toContain('PWA')

      const hostEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
        HOME: root,
        CODEX_HOME: join(root, '.codex'),
        DSH_HOME: dshHome,
        DSH_REMOTE_CONFIG_DIR: configDir,
        DSH_REMOTE_RELAY_HOST_SECRET: 'gw-cli-secret',
        DSH_REMOTE_SIGNALING_HOST_SECRET: 'gw-cli-secret',
      }
      delete hostEnv.DEEPSEEK_API_KEY
      const { ready: hostReady, stopAndWait: stopHost } = await spawnCliUntilReadyJson<{
        deepLink: string
        webPairingUrl?: string
        relayUrl?: string
        signalingUrl?: string
      }>(
        binPath,
        [
          'remote',
          'start',
          '--engines',
          'codex',
          '--relay-url',
          gwReady.relayEndpointUrl,
          '--signaling-url',
          gwReady.signalingEndpointUrl,
          '--web-url',
          gwReady.webAppUrl!,
          '--json',
          '--cwd',
          repoDir,
        ],
        hostEnv,
      )
      try {
        expect(hostReady.relayUrl).toBe(gwReady.relayEndpointUrl)
        expect(hostReady.signalingUrl).toBe(gwReady.signalingEndpointUrl)
        expect(hostReady.webPairingUrl?.startsWith(`${gwReady.webAppUrl!}#pair=`)).toBe(true)
      } finally {
        expect(await stopHost()).toBe(0)
      }
    } finally {
      expect(await stopGateway()).toBe(0)
    }
  })

  it('rejects invalid and non-loopback HTTP --web-url on remote start', async () => {
    const root = makeTempDir('dsh-remote-bad-weburl-')
    for (const badUrl of [
      'javascript:alert(1)',
      'http://192.168.1.25:8080/app/',
      'http://example.com/app/',
      'https://user:pass@example.com/app/',
    ]) {
      const io = captureOutputs()
      expect(
        await runRemoteCommand(
          ['start', '--web-url', badUrl, '--cwd', root],
          { DSH_HOME: join(root, 'dsh'), DSH_REMOTE_CONFIG_DIR: join(root, 'cfg') },
          join(root, 'dsh'),
        ),
      ).toBe(2)
      expect(io.stderr()).toContain('--web-url')
    }

    const envIo = captureOutputs()
    expect(
      await runRemoteCommand(
        ['start', '--cwd', root],
        {
          DSH_HOME: join(root, 'dsh'),
          DSH_REMOTE_CONFIG_DIR: join(root, 'cfg'),
          DSH_REMOTE_WEB_URL: 'http://10.0.0.8:8080/app/',
        },
        join(root, 'dsh'),
      ),
    ).toBe(2)
    expect(envIo.stderr()).toContain('--web-url')
  })

  it('parses --trusted-proxies / env on remote gateway and fails closed on invalid CIDRs', async () => {
    expect(COMMUNITY_REMOTE_HELP).toContain('--trusted-proxies')

    for (const badCidr of ['not-a-cidr', '0.0.0.0/0', '::/0', '127.0.0.1/33', '127.0.0.1,']) {
      const io = captureOutputs()
      expect(
        await runRemoteCommand(['gateway', '--trusted-proxies', badCidr], {}, process.cwd()),
      ).toBe(2)
      expect(io.stderr()).toMatch(/trusted prox(y|ies)/i)
    }

    const badEnvIo = captureOutputs()
    expect(
      await runRemoteCommand(
        ['gateway'],
        { DSH_REMOTE_GATEWAY_TRUSTED_PROXIES: 'invalid-proxy' },
        process.cwd(),
      ),
    ).toBe(2)
    expect(badEnvIo.stderr()).toMatch(/trusted prox(y|ies)/i)

    const binPath = ensureBuiltTuiBin()
    const { ready, stopAndWait } = await spawnCliUntilReadyJson<{
      kind: string
      trustedProxies?: string[]
    }>(
      binPath,
      ['remote', 'gateway', '--port', '0', '--trusted-proxies', '127.0.0.1,10.0.0.0/8', '--json'],
      {},
    )
    try {
      expect(ready.kind).toBe('blind-gateway')
      expect(ready.trustedProxies).toEqual(['127.0.0.1', '10.0.0.0/8'])
    } finally {
      await stopAndWait()
    }
  })

  it('grants and independently revokes device capabilities offline and through live control server', async () => {
    const root = makeTempDir('dsh-remote-cli-caps-')
    const dshHome = join(root, 'dsh')
    const configDir = join(root, 'cfg')
    const env: NodeJS.ProcessEnv = { DSH_HOME: dshHome, DSH_REMOTE_CONFIG_DIR: configDir }

    const stores = openPersistentRemoteStores({ configDir, dshHome })
    const hostPub = await stores.hostIdentityStore.getPublicIdentity()
    const record = stores.trustStore.trustSync({
      staticPublicKey: new Uint8Array(32).fill(21),
      displayName: 'Granular Phone',
      grantedCapabilities: ['observe', 'prompt'],
      trustDomainId: hostPub.trustDomainId,
    })

    // Offline grant + revoke --cap
    expect(
      await runRemoteCommand(['grant', record.deviceId, 'session.manage,command.execute'], env, dshHome),
    ).toBe(0)
    expect([
      ...((await openPersistentRemoteStores({ configDir, dshHome }).trustStore.get(record.deviceId))
        ?.grantedCapabilities ?? []),
    ]).toEqual([
      'observe',
      'prompt',
      'session.manage',
      'command.execute',
    ])

    expect(
      await runRemoteCommand(['revoke', record.deviceId, '--cap', 'command.execute'], env, dshHome),
    ).toBe(0)
    expect([
      ...((await openPersistentRemoteStores({ configDir, dshHome }).trustStore.get(record.deviceId))
        ?.grantedCapabilities ?? []),
    ]).toEqual([
      'observe',
      'prompt',
      'session.manage',
    ])

    // Invalid capability returns exit 2
    const badCapIo = captureOutputs()
    expect(await runRemoteCommand(['grant', record.deviceId, 'bogus'], env, dshHome)).toBe(2)
    expect(badCapIo.stderr()).toContain('未知能力')
    vi.restoreAllMocks()

    // Live control server delegation for grant + revoke --cap
    const requests: Array<{ deviceId: string; grant?: string[]; revoke?: string[] }> = []
    const token = 'cap-ctrl-token'
    const server = createServer(async (req, res) => {
      if (
        req.method === 'POST' &&
        req.url === '/devices/capabilities' &&
        req.headers.authorization === `Bearer ${token}`
      ) {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          deviceId: string
          grant?: string[]
          revoke?: string[]
        }
        requests.push(body)
        const liveStores = openPersistentRemoteStores({ configDir, dshHome })
        const current = await liveStores.trustStore.get(body.deviceId)
        const set = new Set(current?.grantedCapabilities ?? [])
        for (const c of body.grant ?? []) set.add(c as any)
        for (const c of body.revoke ?? []) set.delete(c as any)
        const updated = await liveStores.trustStore.updateCapabilities(body.deviceId, Array.from(set))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, capabilities: [...updated.grantedCapabilities] }))
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))

    try {
      const addr = server.address() as { port: number }
      writeFileSync(
        join(stores.configDir, '.control.json'),
        JSON.stringify({
          pid: process.pid,
          controlUrl: `http://127.0.0.1:${addr.port}`,
          controlToken: token,
        }),
        { mode: 0o600 },
      )
      expect(await runRemoteCommand(['grant', record.deviceId, 'workspace.write'], env, dshHome)).toBe(0)
      expect(
        await runRemoteCommand(['revoke', record.deviceId, '--cap', 'session.manage'], env, dshHome),
      ).toBe(0)
      expect(requests).toEqual([
        { deviceId: record.deviceId, grant: ['workspace.write'] },
        { deviceId: record.deviceId, revoke: ['session.manage'] },
      ])
      expect([
        ...((await openPersistentRemoteStores({ configDir, dshHome }).trustStore.get(record.deviceId))
          ?.grantedCapabilities ?? []),
      ]).toEqual([
        'observe',
        'prompt',
        'workspace.write',
      ])
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('fails closed on grant/revoke/capability revoke when live control returns 404 or is unreachable (F-02 P2)', async () => {
    const root = makeTempDir('dsh-remote-cli-live-fail-closed-')
    const dshHome = join(root, 'official-dsh-home')
    const configDir = join(root, 'community-remote-config')
    const stores = openPersistentRemoteStores({ configDir, dshHome })
    const hostPub = await stores.hostIdentityStore.getPublicIdentity()
    const record = stores.trustStore.trustSync({
      staticPublicKey: new Uint8Array(32).fill(77),
      displayName: 'Fail-Closed Live Control Phone',
      grantedCapabilities: ['observe', 'prompt'],
      trustDomainId: hostPub.trustDomainId,
    })

    const server404 = createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    })
    await new Promise<void>((r) => server404.listen(0, '127.0.0.1', () => r()))
    const addr = server404.address() as { port: number }
    const controlPath = join(stores.configDir, '.control.json')
    writeFileSync(
      controlPath,
      JSON.stringify({
        pid: process.pid,
        controlUrl: `http://127.0.0.1:${addr.port}`,
        controlToken: 'test-token-404',
      }),
      { mode: 0o600 },
    )
    if (process.platform !== 'win32') chmodSync(controlPath, 0o600)

    try {
      const env = { DSH_HOME: dshHome, DSH_REMOTE_CONFIG_DIR: configDir }

      const ioGrant = captureOutputs()
      expect(await runRemoteCommand(['grant', record.deviceId, 'approve'], env, dshHome)).toBe(1)
      expect(ioGrant.stderr()).toContain('404')
      expect(ioGrant.stderr()).toContain('已拒绝回退至离线写入')

      const ioRevokeCap = captureOutputs()
      expect(await runRemoteCommand(['revoke', record.deviceId, '--cap', 'prompt'], env, dshHome)).toBe(1)
      expect(ioRevokeCap.stderr()).toContain('404')
      expect(ioRevokeCap.stderr()).toContain('已拒绝回退至离线写入')

      const ioRevoke = captureOutputs()
      expect(await runRemoteCommand(['revoke', record.deviceId], env, dshHome)).toBe(1)
      expect(ioRevoke.stderr()).toContain('404')
      expect(ioRevoke.stderr()).toContain('已拒绝回退至离线写入')
    } finally {
      await new Promise<void>((r) => server404.close(() => r()))
    }

    // Now the port is closed while .control.json still has live process.pid -> connection error must fail closed too.
    const env = { DSH_HOME: dshHome, DSH_REMOTE_CONFIG_DIR: configDir }
    const ioUnreachable = captureOutputs()
    expect(await runRemoteCommand(['grant', record.deviceId, 'approve'], env, dshHome)).toBe(1)
    expect(ioUnreachable.stderr()).toContain('连接控制接口失败')

    const persisted = await openPersistentRemoteStores({ configDir, dshHome }).trustStore.get(record.deviceId)
    expect(persisted?.revokedAt).toBeUndefined()
    expect(Array.from(persisted?.grantedCapabilities ?? []).sort()).toEqual(['observe', 'prompt'])
  })

  it('fails closed on non-loopback/wildcard relay, signaling, and gateway without --host-secret (F-04)', async () => {
    const binPath = ensureBuiltTuiBin()

    expect(
      await runRemoteCommand(['relay', '--host', '0.0.0.0', '--port', '0', '--allow-wildcard'], {}),
    ).toBe(1)
    expect(
      await runRemoteCommand(['signaling', '--host', '::', '--port', '0', '--allow-wildcard'], {}),
    ).toBe(1)
    expect(
      await runRemoteCommand(['gateway', '--host', '192.168.50.10', '--port', '0'], {}),
    ).toBe(1)

    const { ready, stopAndWait } = await spawnCliUntilReadyJson<{
      kind: string
      authRequired: boolean
    }>(
      binPath,
      [
        'remote',
        'gateway',
        '--host',
        '0.0.0.0',
        '--port',
        '0',
        '--allow-wildcard',
        '--host-secret',
        'cli-gateway-secret',
        '--json',
      ],
      {},
    )
    try {
      expect(ready.kind).toBe('blind-gateway')
      expect(ready.authRequired).toBe(true)
    } finally {
      expect(await stopAndWait()).toBe(0)
    }
  })
})
