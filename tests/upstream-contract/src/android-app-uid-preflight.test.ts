import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const PREFLIGHT = resolve(ROOT, 'apps/android/nodejs-project/src/main/js/android-app-uid-preflight.cjs')
const require = createRequire(import.meta.url)

type SpawnResult = {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

type FakePty = {
  pid: number
  onData(callback: (data: string) => void): { dispose(): void }
  onExit(callback: (event: { exitCode: number; signal: number }) => void): { dispose(): void }
  kill(signal?: string): void
}

type PreflightModule = {
  runAndroidAppUidPreflight(options: {
    platform?: string
    arch?: string
    appDataDir?: string
    cacheDir?: string
    landlockLauncher?: string
    execPath?: string
    env?: NodeJS.ProcessEnv
    spawnSync?: (file: string, args: readonly string[], options: unknown) => SpawnResult
    ptyModule?: { spawn(...args: unknown[]): FakePty }
    procModule?: unknown
    processInspector?: {
      snapshot(): {
        tree(pid: number): Array<{ pid: number; started: string }>
        session(id: number): Array<{ pid: number; started: string }>
        alive(identity: { pid: number; started: string }): boolean
      }
      signalGroup(pgid: number, signal: number | string): void
    }
    ptyRootStat?: (pid: number) => {
      pid: number
      processGroupId: number
      sessionId: number
      ttyDevice: number
      foregroundProcessGroupId: number
      started: string
    }
    ptyTimeoutMs?: number
  }): Promise<{
    schemaVersion: number
    platform: string
    arch: string
    hardlink: string
    sandbox: string
    landlockEnforcement: string
    ptySubstrate: string
    ptyInputWaitingExactProbe: boolean
  }>
}

const preflight = require(PREFLIGHT) as PreflightModule

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-appuid-preflight-test-'))
  const appDataDir = join(root, 'files')
  const cacheDir = join(root, 'cache')
  const launcher = join(root, 'landlock-run')
  mkdirSync(appDataDir)
  mkdirSync(cacheDir)
  writeFileSync(launcher, '#!/bin/sh\nexit 0\n')
  chmodSync(launcher, 0o755)
  return { root, appDataDir, cacheDir, launcher }
}

function landlockSpawn(_file: string, args: readonly string[]): SpawnResult {
  if (args.length === 1 && args[0] === '--probe') {
    return { status: 0, stdout: 'landlock: fully enforced\n', stderr: '' }
  }
  const target = args.at(-1)
  if (target?.includes('/allowed/') === true) {
    writeFileSync(target, 'DSH_APP_UID_OK')
    return { status: 0, stdout: '', stderr: '' }
  }
  return { status: 1, stdout: '', stderr: 'Error: EACCES: permission denied' }
}

function ptyFixture() {
  const pid = 4321
  let data: ((value: string) => void) | undefined
  let exit: ((event: { exitCode: number; signal: number }) => void) | undefined
  const ptyModule = {
    spawn: (): FakePty => {
      queueMicrotask(() => {
        data?.('DSH_PTY_APP_UID_OK')
        exit?.({ exitCode: 0, signal: 0 })
      })
      return {
        pid,
        onData(callback) {
          data = callback
          return { dispose() { data = undefined } }
        },
        onExit(callback) {
          exit = callback
          return { dispose() { exit = undefined } }
        },
        kill() {
          exit?.({ exitCode: 0, signal: 9 })
        },
      }
    },
  }
  const rootIdentity = { pid, started: '999' }
  const groupSignals: Array<[number, number | string]> = []
  const processInspector = {
    snapshot: () => ({
      tree: (candidate: number) => candidate === pid ? [rootIdentity] : [],
      session: (candidate: number) => candidate === pid ? [rootIdentity] : [],
      alive: (identity: { pid: number; started: string }) =>
        identity.pid === pid && identity.started === '999',
    }),
    signalGroup: (pgid: number, signal: number | string) => {
      groupSignals.push([pgid, signal])
    },
  }
  const ptyRootStat = () => ({
    pid,
    processGroupId: pid,
    sessionId: pid,
    ttyDevice: 34816,
    foregroundProcessGroupId: pid,
    started: '999',
  })
  return { ptyModule, processInspector, ptyRootStat, groupSignals }
}

describe('Android app-UID preflight', () => {
  it('requires hard-link, full Landlock, and PTY/proc/session substrate before PASS', async () => {
    const f = fixture()
    try {
      const pty = ptyFixture()
      await expect(preflight.runAndroidAppUidPreflight({
        platform: 'android',
        arch: 'arm64',
        appDataDir: f.appDataDir,
        cacheDir: f.cacheDir,
        landlockLauncher: f.launcher,
        execPath: process.execPath,
        env: {},
        spawnSync: landlockSpawn,
        ptyModule: pty.ptyModule,
        procModule: {},
        processInspector: pty.processInspector,
        ptyRootStat: pty.ptyRootStat,
        ptyTimeoutMs: 100,
      })).resolves.toEqual({
        schemaVersion: 1,
        platform: 'android',
        arch: 'arm64',
        hardlink: 'PASS',
        sandbox: 'PASS',
        landlockEnforcement: 'full',
        ptySubstrate: 'PASS',
        ptyInputWaitingExactProbe: false,
      })
      expect(pty.groupSignals).toEqual([[4321, 0]])
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('fails closed on a partial Landlock probe before PTY allocation', async () => {
    const f = fixture()
    try {
      await expect(preflight.runAndroidAppUidPreflight({
        platform: 'android',
        appDataDir: f.appDataDir,
        cacheDir: f.cacheDir,
        landlockLauncher: f.launcher,
        spawnSync: () => ({
          status: 0,
          stdout: 'landlock: partially enforced (older ABI)\n',
          stderr: '',
        }),
      })).rejects.toThrow(/fully enforced/u)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('fails closed when the PTY root identity is not visible to the APK UID', async () => {
    const f = fixture()
    try {
      const pty = ptyFixture()
      await expect(preflight.runAndroidAppUidPreflight({
        platform: 'android',
        appDataDir: f.appDataDir,
        cacheDir: f.cacheDir,
        landlockLauncher: f.launcher,
        spawnSync: landlockSpawn,
        ptyModule: pty.ptyModule,
        procModule: {},
        processInspector: {
          snapshot: () => ({
            tree: () => [],
            session: () => [],
            alive: () => false,
          }),
          signalGroup: () => {},
        },
        ptyRootStat: pty.ptyRootStat,
        ptyTimeoutMs: 100,
      })).rejects.toThrow(/identity is not enumerable\/alive/u)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('refuses non-Android execution even when all paths exist', async () => {
    const f = fixture()
    try {
      await expect(preflight.runAndroidAppUidPreflight({
        platform: 'linux',
        appDataDir: f.appDataDir,
        cacheDir: f.cacheDir,
        landlockLauncher: f.launcher,
      })).rejects.toThrow(/expected process\.platform=android/u)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })
})
