import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  formatPairingQrBlock,
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

    const startRes = spawnSync(process.execPath, [binPath, 'remote', 'start'], {
      env: childEnv,
      encoding: 'utf8',
    })
    expect(startRes.status).toBe(2)
    expect(startRes.stderr).toContain('DEEPSEEK_API_KEY')
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
})
