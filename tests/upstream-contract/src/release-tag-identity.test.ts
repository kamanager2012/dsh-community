import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const validator = join(repoRoot, 'scripts', 'validate-release-tag.mjs')
const version = '0.1.1-rc.2'
const tag = 'v' + version
const official = '@deepseek-ai/dsh'

const manifests = [
  'package.json',
  'apps/desktop/package.json',
  'apps/tui/package.json',
  'packages/dsh-bridge/package.json',
  'packages/shared-types/package.json',
  'packages/tui-adapter/package.json',
  'packages/tui/package.json',
  'tests/upstream-contract/package.json',
]

function write(root: string, rel: string, content: string) {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-tag-'))
  roots.push(root)
  for (const rel of manifests) {
    const needsOfficial = [
      'apps/desktop/package.json',
      'apps/tui/package.json',
      'packages/dsh-bridge/package.json',
      'tests/upstream-contract/package.json',
    ].includes(rel)
    write(root, rel, JSON.stringify({
      name: rel,
      version,
      ...(needsOfficial ? { dependencies: { [official]: version } } : {}),
    }, null, 2) + '\n')
  }
  write(
    root,
    'packages/dsh-bridge/src/pin.ts',
    "export const PINNED_DSH_VERSION = '" + version + "' as const\n",
  )
  write(
    root,
    'packages/dsh-bridge/src/community-version.ts',
    "export const COMMUNITY_PRODUCT_VERSION = '" + version + "' as const\n",
  )
  write(root, 'docs/current-release.json', JSON.stringify({
    officialKernel: { package: official, version },
    communityProduct: { version, githubLatestTag: tag },
    dualBadge: 'DeepSeek Harness Community v' + version + ' [Official Core: ' + official + '@' + version + ']',
    assets: {
      linuxAppImage: 'dsh-community-' + version + '.AppImage',
      macosDmg: 'dsh-community-' + version + '.dmg',
      windowsSetup: 'DSH.Community.Setup.' + version + '.exe',
    },
    historicalIndependentTags: ['v0.1.2'],
  }, null, 2) + '\n')
  write(root, 'CHANGELOG.md', '# Changelog\n\n## ' + version + '\n\n- fixture\n')
  return root
}

function run(root: string, requestedTag = tag) {
  return spawnSync(process.execPath, [validator, requestedTag], {
    cwd: root,
    encoding: 'utf8',
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('release tag identity validator', () => {
  it('accepts one coherent product/core/tag identity', () => {
    const result = run(makeFixture())
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('release identity verified: ' + tag)
    expect(result.stdout).toContain(official + '@' + version)
  })

  it('rejects a manually pushed tag that does not match the source version', () => {
    const result = run(makeFixture(), 'v9.9.9')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not match workspace product version')
  })

  it('rejects workspace version drift', () => {
    const root = makeFixture()
    write(root, 'apps/tui/package.json', JSON.stringify({
      name: 'apps/tui/package.json',
      version: '0.1.1-rc.9',
      dependencies: { [official]: version },
    }, null, 2) + '\n')
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('apps/tui/package.json version')
  })

  it('rejects a community product that does not mirror the official pin', () => {
    const root = makeFixture()
    write(
      root,
      'packages/dsh-bridge/src/pin.ts',
      "export const PINNED_DSH_VERSION = '0.1.1-rc.9' as const\n",
    )
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not mirror official pin')
  })

  it('rejects current-release metadata that points at another tag', () => {
    const root = makeFixture()
    const facts = JSON.parse(
      readFileSync(join(root, 'docs/current-release.json'), 'utf8'),
    )
    facts.communityProduct.githubLatestTag = 'v0.1.1-rc.9'
    write(root, 'docs/current-release.json', JSON.stringify(facts, null, 2) + '\n')
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('current-release GitHub tag')
  })

  it('keeps scripts/release.mjs on the same canonical validator', () => {
    const releaseScript = require('node:fs').readFileSync(
      join(repoRoot, 'scripts/release.mjs'),
      'utf8',
    )
    expect(releaseScript).toContain("run(process.execPath, ['scripts/validate-release-tag.mjs', tag])")
  })
})
