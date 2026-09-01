import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OFFICIAL_DSH_PACKAGE, PINNED_DSH_VERSION } from '@dsh-community/dsh-bridge'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const runtimeLockRoot = join(repoRoot, 'apps', 'desktop', 'runtime-lock')

interface LockedPackage {
  version?: string
  resolved?: string
  integrity?: string
  dependencies?: Record<string, string>
  optional?: boolean
  os?: string[]
  cpu?: string[]
}

interface RuntimeLock {
  lockfileVersion?: number
  packages?: Record<string, LockedPackage>
}

describe('official runtime lock', () => {
  it('contains only the exact pinned official runtime dependency at the root', () => {
    const manifest = JSON.parse(
      readFileSync(join(runtimeLockRoot, 'package.json'), 'utf8'),
    ) as {
      private?: boolean
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      scripts?: Record<string, string>
    }

    expect(manifest.private).toBe(true)
    expect(manifest.dependencies).toEqual({
      [OFFICIAL_DSH_PACKAGE]: PINNED_DSH_VERSION,
    })
    expect(manifest.devDependencies).toBeUndefined()
    expect(manifest.optionalDependencies).toBeUndefined()
    expect(manifest.scripts).toBeUndefined()
  })

  it('locks the exact official tarball with registry integrity', () => {
    const lock = JSON.parse(
      readFileSync(join(runtimeLockRoot, 'package-lock.json'), 'utf8'),
    ) as RuntimeLock

    expect(lock.lockfileVersion).toBe(3)
    expect(lock.packages?.['']?.dependencies).toEqual({
      [OFFICIAL_DSH_PACKAGE]: PINNED_DSH_VERSION,
    })

    const dsh = lock.packages?.['node_modules/@deepseek-ai/dsh']
    expect(dsh?.version).toBe(PINNED_DSH_VERSION)
    expect(dsh?.resolved).toBe(
      'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-' +
        PINNED_DSH_VERSION +
        '.tgz',
    )
    expect(dsh?.integrity).toMatch(/^sha512-[A-Za-z0-9+/=]+$/u)
  })

  it('keeps every non-root package pinned to resolved bytes with integrity', () => {
    const lock = JSON.parse(
      readFileSync(join(runtimeLockRoot, 'package-lock.json'), 'utf8'),
    ) as RuntimeLock
    const packages = lock.packages ?? {}
    const violations: string[] = []

    for (const [name, entry] of Object.entries(packages)) {
      if (name === '') continue
      if (typeof entry.resolved !== 'string' || entry.resolved.length === 0) {
        violations.push(name + ': missing resolved')
      }
      if (
        typeof entry.integrity !== 'string' ||
        !/^sha512-[A-Za-z0-9+/=]+$/u.test(entry.integrity)
      ) {
        violations.push(name + ': missing/invalid integrity')
      }
    }

    expect(Object.keys(packages).length).toBeGreaterThan(500)
    expect(violations).toEqual([])
  })

  it('retains cross-platform optional native entries in the shared lock', () => {
    const lock = JSON.parse(
      readFileSync(join(runtimeLockRoot, 'package-lock.json'), 'utf8'),
    ) as RuntimeLock
    const packages = lock.packages ?? {}

    for (const name of [
      'node_modules/@img/sharp-linux-x64',
      'node_modules/@img/sharp-darwin-x64',
      'node_modules/@img/sharp-win32-x64',
      'node_modules/@koromix/koffi-linux-x64',
      'node_modules/@koromix/koffi-darwin-x64',
      'node_modules/@koromix/koffi-win32-x64',
      'node_modules/node-addon-require-builtin-linux-x64-gnu',
      'node_modules/node-addon-require-builtin-darwin-x64',
      'node_modules/node-addon-require-builtin-win32-x64-msvc',
    ]) {
      expect(packages[name], name).toBeDefined()
      expect(packages[name]?.optional, name).toBe(true)
    }
  })

  it('binds the committed lock bytes to recorded generation provenance', () => {
    const raw = readFileSync(join(runtimeLockRoot, 'package-lock.json'))
    const lock = JSON.parse(raw.toString('utf8')) as RuntimeLock
    const evidence = JSON.parse(
      readFileSync(join(runtimeLockRoot, 'evidence.json'), 'utf8'),
    ) as {
      source?: string
      workflowRunId?: number
      artifactId?: number
      artifactZipSha256?: string
      lockSha256?: string
      runnerImage?: string
      nodeVersion?: string
      npmVersion?: string
      command?: string
      officialPackage?: string
      officialVersion?: string
      lockfileVersion?: number
      packageEntries?: number
    }

    expect(createHash('sha256').update(raw).digest('hex')).toBe(
      evidence.lockSha256,
    )
    expect(evidence.source).toBe('github-actions')
    expect(evidence.workflowRunId).toBe(33466316081)
    expect(evidence.artifactId).toBe(9785175407)
    expect(evidence.artifactZipSha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(evidence.runnerImage).toBe('ubuntu-24.04')
    expect(evidence.nodeVersion).toBe('v22.23.2')
    expect(evidence.npmVersion).toBe('10.9.8')
    expect(evidence.command).toBe(
      'npm install --package-lock-only --ignore-scripts --no-audit --no-fund',
    )
    expect(evidence.officialPackage).toBe(OFFICIAL_DSH_PACKAGE)
    expect(evidence.officialVersion).toBe(PINNED_DSH_VERSION)
    expect(evidence.lockfileVersion).toBe(lock.lockfileVersion)
    expect(evidence.packageEntries).toBe(Object.keys(lock.packages ?? {}).length)
  })

  it('stages from committed package-lock with npm ci, never a free npm install', () => {
    const stage = readFileSync(
      join(repoRoot, 'apps/desktop/scripts/stage-official-runtime.mjs'),
      'utf8',
    )

    expect(stage).toContain("const runtimeLockPath = join(runtimeLockRoot, 'package-lock.json')")
    expect(stage).toContain("copyFileSync(runtimeLockPath, join(stageRoot, 'package-lock.json'))")
    expect(stage).toMatch(/spawnSync\('npm', \[\s*'ci',/u)
    expect(stage).not.toMatch(/spawnSync\('npm', \[\s*'install',/u)
    expect(stage).toContain('runtime package-lock does not contain the exact official DSH package')
  })
})
