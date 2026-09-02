import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const POLICY = resolve(ROOT, 'apps/android/nodejs-project/src/main/js/android-sandbox-policy.mjs')
const PROVIDER = resolve(ROOT, 'apps/android/nodejs-project/src/main/js/android-sandbox-provider.mjs')
const PATCH = resolve(ROOT, 'apps/android/nodejs-project/src/main/js/android.cordis.patch.yml')
const PROBE = resolve(ROOT, 'scripts/android-sandbox-landlock-probe.sh')

describe('Android sandbox provider', () => {
  it('maps the official confined policy vocabulary to the Landlock CLI without widening it', async () => {
    const policy = await import(pathToFileURL(POLICY).href) as {
      buildAndroidLandlockArgv(
        launcher: string,
        innerArgv: string[],
        sandboxPolicy: { mode: string; workspaceRoot: string },
        writableRoots: string[],
      ): string[]
    }

    expect(policy.buildAndroidLandlockArgv(
      '/app/landlock-run',
      ['/system/bin/sh', '-c', 'echo hi'],
      { mode: 'read-only', workspaceRoot: '/workspace' },
      [],
    )).toEqual([
      '/app/landlock-run',
      '--ro', '/',
      '--rw', '/dev/null',
      '--',
      '/system/bin/sh', '-c', 'echo hi',
    ])

    expect(policy.buildAndroidLandlockArgv(
      '/app/landlock-run',
      ['bash', '-c', 'touch file'],
      { mode: 'workspace-write', workspaceRoot: '/workspace' },
      ['/workspace', '/tmp', '/data/user/0/org.dsh.community.android/cache'],
    )).toEqual([
      '/app/landlock-run',
      '--ro', '/',
      '--rw', '/dev/null',
      '--rw', '/workspace',
      '--rw', '/tmp',
      '--rw', '/data/user/0/org.dsh.community.android/cache',
      '--',
      'bash', '-c', 'touch file',
    ])

    expect(() => policy.buildAndroidLandlockArgv(
      '/app/landlock-run',
      ['bash'],
      { mode: 'danger-full-access', workspaceRoot: '/workspace' },
      [],
    )).toThrow(/only confined/u)
    expect(() => policy.buildAndroidLandlockArgv(
      'relative/landlock-run',
      ['bash'],
      { mode: 'read-only', workspaceRoot: '/workspace' },
      [],
    )).toThrow(/absolute/u)
    expect(() => policy.buildAndroidLandlockArgv(
      '/app/landlock-run',
      ['bash'],
      { mode: 'read-only', workspaceRoot: '/workspace' },
      ['/tmp'],
    )).toThrow(/read-only policy/u)
  })

  it('uses only the official sandbox seam and refuses partial Landlock enforcement', () => {
    const provider = readFileSync(PROVIDER, 'utf8')
    expect(provider).toContain("from '@deepseek-ai/dsh-sandbox'")
    expect(provider).toContain('SandboxProvider')
    expect(provider).toContain('SandboxUnavailableError')
    expect(provider).toContain('writableRoots')
    expect(provider).toContain("const FULL_PROBE_LINE = 'landlock: fully enforced'")
    expect(provider).toContain('allowedExitCodes: [LANDLOCK_FAILURE_EXIT]')
    expect(provider).toContain('fatalSignatures: [LANDLOCK_FATAL_SIGNATURE]')
    expect(provider).not.toContain('@deepseek-ai/dsh-sandbox-local')
    expect(provider).not.toMatch(/codex/iu)
  })

  it('keeps sandbox replacement inside the exact Android execution-provider overlay', () => {
    const patch = readFileSync(PATCH, 'utf8')
    expect(patch).toContain("- id: sandbox")
    expect(patch).toContain("name: '@deepseek-ai/dsh-sandbox-local'")
    expect(patch).toContain('disabled: true')
    expect(patch).toContain('- id: android-sandbox')
    expect(patch).toContain('name: ./android-sandbox-provider.mjs')
    const ids = [...patch.matchAll(/^[ \t]*-[ \t]+id:[ \t]+([a-z0-9-]+)[ \t]*$/gmu)]
      .map(match => match[1])
    expect(ids).toEqual(['subprocess', 'sandbox', 'android-subprocess', 'android-sandbox'])
  })

  it('keeps the frozen-source Android Landlock probe syntax-valid, network-free, and patch-free', () => {
    const syntax = spawnSync('bash', ['-n', PROBE], { cwd: ROOT, encoding: 'utf8' })
    expect(syntax.status).toBe(0)
    expect(syntax.stderr).toBe('')

    const probe = readFileSync(PROBE, 'utf8')
    expect(probe).toContain('EXPECTED_PACKAGE="@deepseek-ai/node-addon-landlock-run"')
    expect(probe).toContain('EXPECTED_VERSION="0.1.1"')
    expect(probe).toContain('src/main.c')
    expect(probe).toContain('-fPIE -pie')
    expect(probe).toContain('landlock: fully enforced')
    expect(probe).toContain('ADB_SHELL_FULL_OK_NOT_APP_UID_ACCEPTANCE')
    expect(probe).not.toMatch(/\bcurl\b|\bwget\b/u)
    expect(probe).not.toMatch(/^\s*(?:git\s+apply|patch\s|sed\s+-i)/mu)
  })
})
