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
  }): {
    schemaVersion: number
    platform: string
    arch: string
    hardlink: string
    sandbox: string
    landlockEnforcement: string
  }
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

describe('Android app-UID preflight', () => {
  it('proves hard-link identity and requires an allow/deny Landlock pair before PASS', () => {
    const f = fixture()
    try {
      const fakeSpawn = (_file: string, args: readonly string[]): SpawnResult => {
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

      expect(preflight.runAndroidAppUidPreflight({
        platform: 'android',
        arch: 'arm64',
        appDataDir: f.appDataDir,
        cacheDir: f.cacheDir,
        landlockLauncher: f.launcher,
        execPath: process.execPath,
        env: {},
        spawnSync: fakeSpawn,
      })).toEqual({
        schemaVersion: 1,
        platform: 'android',
        arch: 'arm64',
        hardlink: 'PASS',
        sandbox: 'PASS',
        landlockEnforcement: 'full',
      })
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('fails closed on a partial Landlock probe', () => {
    const f = fixture()
    try {
      expect(() => preflight.runAndroidAppUidPreflight({
        platform: 'android',
        appDataDir: f.appDataDir,
        cacheDir: f.cacheDir,
        landlockLauncher: f.launcher,
        spawnSync: () => ({
          status: 0,
          stdout: 'landlock: partially enforced (older ABI)\n',
          stderr: '',
        }),
      })).toThrow(/fully enforced/u)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('refuses non-Android execution even when all paths exist', () => {
    const f = fixture()
    try {
      expect(() => preflight.runAndroidAppUidPreflight({
        platform: 'linux',
        appDataDir: f.appDataDir,
        cacheDir: f.cacheDir,
        landlockLauncher: f.launcher,
      })).toThrow(/expected process\.platform=android/u)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })
})
