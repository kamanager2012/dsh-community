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
  hasInstallScript?: boolean
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

  it('pins every non-root tarball to the public npm registry', () => {
    const lock = JSON.parse(
      readFileSync(join(runtimeLockRoot, 'package-lock.json'), 'utf8'),
    ) as RuntimeLock
    const violations = Object.entries(lock.packages ?? {})
      .filter(([name]) => name !== '')
      .filter(([, entry]) => !entry.resolved?.startsWith('https://registry.npmjs.org/'))
      .map(([name, entry]) => `${name}: ${String(entry.resolved)}`)

    expect(violations).toEqual([])
  })

  it('requires an explicit decision for every lifecycle-script package', () => {
    const lock = JSON.parse(
      readFileSync(join(runtimeLockRoot, 'package-lock.json'), 'utf8'),
    ) as RuntimeLock
    const policy = JSON.parse(
      readFileSync(join(runtimeLockRoot, 'lifecycle-scripts.json'), 'utf8'),
    ) as {
      schemaVersion?: number
      allowed?: Array<{ name: string; version: string; reason: string }>
      denied?: Array<{ name: string; version: string; reason: string }>
    }

    expect(policy.schemaVersion).toBe(1)
    expect(policy.allowed?.map(({ name, version }) => `${name}@${version}`).sort()).toEqual([
      `@deepseek-ai/dsh-subprocess-local@${PINNED_DSH_VERSION}`,
      'koffi@3.1.6',
      'node-pty@1.2.0-beta.15',
      'protobufjs@7.6.6',
    ])
    expect(policy.denied?.map(({ name, version }) => `${name}@${version}`).sort()).toEqual([
      '@google/genai@1.52.0',
    ])
    for (const entry of [...(policy.allowed ?? []), ...(policy.denied ?? [])]) {
      expect(entry.reason.length, entry.name + ' review reason').toBeGreaterThan(20)
    }

    const observed = Object.entries(lock.packages ?? {})
      .filter(([, entry]) => entry.hasInstallScript === true)
      .map(([path, entry]) => {
        const marker = 'node_modules/'
        const index = path.lastIndexOf(marker)
        const name = index === -1 ? path : path.slice(index + marker.length)
        return `${name}@${String(entry.version)}`
      })
      .sort()
    const reviewed = [...(policy.allowed ?? []), ...(policy.denied ?? [])]
      .map(({ name, version }) => `${name}@${version}`)
      .sort()

    expect(observed).toEqual(reviewed)

    const workspace = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
    for (const line of [
      "  '@deepseek-ai/dsh-subprocess-local': true",
      '  koffi: true',
      '  node-pty: true',
      '  protobufjs: true',
      "  '@google/genai': false",
    ]) {
      expect(workspace, 'pnpm build policy drift: ' + line).toContain(line)
    }
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
      schemaVersion?: number
      source?: string
      delivery?: string
      workflowRunId?: number
      workflowJobId?: number
      generatorCommit?: string
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
    expect(evidence.schemaVersion).toBe(2)
    expect(evidence.source).toBe('github-actions')
    expect(evidence.delivery).toBe('direct-commit')
    expect(evidence.workflowRunId).toBe(33540607690)
    expect(evidence.workflowJobId).toBe(99965617854)
    expect(evidence.generatorCommit).toBe('4458655c7225a308b770d881353ebdec90ff9fd2')
    expect(evidence.artifactId).toBeUndefined()
    expect(evidence.artifactZipSha256).toBeUndefined()
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
    expect(stage).toContain("'ci',\n  '--ignore-scripts',")
    expect(stage).toContain("'rebuild',\n    entry.name,")
    expect(stage).not.toMatch(/spawnSync\('npm', \[\s*'install',/u)
    expect(stage).toContain('runtime lifecycle-script surface drifted')
    expect(stage).toContain('reviewed lifecycle package version drifted')
    expect(stage).toContain('runtime package-lock does not contain the exact official DSH package')
  })
})
