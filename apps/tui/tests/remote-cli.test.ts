import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openPersistentRemoteStores } from '@dsh-community/remote-adapter'
import { COMMUNITY_TUI_HELP, parseCommunityLaunch } from '../src/launch.js'
import { COMMUNITY_REMOTE_HELP, composeRemoteHostPatchYaml, runRemoteCommand } from '../src/remote.js'

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

  it('executes built bin.js remote subcommands cleanly without DEEPSEEK_API_KEY and fails closed on remote start', () => {
    const root = makeTempDir('dsh-remote-bin-')
    const dshHome = join(root, 'official-dsh-home')
    const configDir = join(root, 'community-remote-config')
    const binPath = resolve(import.meta.dirname, '..', 'dist', 'bin.js')
    if (!existsSync(binPath)) {
      const buildRes = spawnSync('pnpm', ['build'], {
        cwd: resolve(import.meta.dirname, '..'),
        encoding: 'utf8',
      })
      expect(buildRes.status, buildRes.stderr).toBe(0)
    }
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
})
