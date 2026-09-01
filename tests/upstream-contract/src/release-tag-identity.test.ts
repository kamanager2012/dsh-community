import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const validator = join(repoRoot, 'scripts', 'validate-release-tag.mjs')
const candidateVersion = '0.1.2-alpha.3'
const candidateTag = 'v' + candidateVersion
const publishedVersion = '0.1.1-rc.2'
const publishedTag = 'v' + publishedVersion
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

function publishedAssets(version = publishedVersion) {
  return {
    linuxAppImage: 'dsh-community-' + version + '.AppImage',
    macosDmg: 'dsh-community-' + version + '.dmg',
    windowsSetup: 'DSH.Community.Setup.' + version + '.exe',
  }
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
      version: candidateVersion,
      ...(needsOfficial ? { dependencies: { [official]: candidateVersion } } : {}),
    }, null, 2) + '\n')
  }
  write(
    root,
    'packages/dsh-bridge/src/pin.ts',
    "export const PINNED_DSH_VERSION = '" + candidateVersion + "' as const\n",
  )
  write(
    root,
    'packages/dsh-bridge/src/community-version.ts',
    "export const COMMUNITY_PRODUCT_VERSION = '" + candidateVersion + "' as const\n",
  )
  const assets = publishedAssets()
  write(root, 'docs/current-release.json', JSON.stringify({
    schemaVersion: 2,
    officialKernel: { package: official, version: candidateVersion },
    communityProduct: { version: candidateVersion, githubLatestTag: publishedTag },
    candidateTag,
    dualBadge: 'DeepSeek Harness Community v' + candidateVersion
      + ' [Official Core: ' + official + '@' + candidateVersion + ']',
    assets,
    publishedAssets: { ...assets },
    publishedReleaseEvidence: {
      releaseId: 374950921,
      tag: publishedTag,
      url: 'https://github.com/kamanager2012/dsh-community/releases/tag/' + publishedTag,
      publishedAt: '2026-08-22T14:25:10Z',
      primaryAssets: {
        linuxAppImage: {
          name: assets.linuxAppImage,
          assetId: 525116665,
          digest: 'sha256:' + '1'.repeat(64),
        },
        macosDmg: {
          name: assets.macosDmg,
          assetId: 525116664,
          digest: 'sha256:' + '2'.repeat(64),
        },
        windowsSetup: {
          name: assets.windowsSetup,
          assetId: 525116662,
          digest: 'sha256:' + '3'.repeat(64),
        },
      },
    },
    historicalIndependentTags: ['v0.1.2'],
  }, null, 2) + '\n')
  write(root, 'CHANGELOG.md', '# Changelog\n\n## ' + candidateVersion + '\n\n- fixture\n')
  return root
}

function run(root: string, requestedTag = candidateTag) {
  return spawnSync(process.execPath, [validator, requestedTag], {
    cwd: root,
    encoding: 'utf8',
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('release tag identity validator', () => {
  it('accepts Candidate Source newer than Published Latest without inventing assets', () => {
    const result = run(makeFixture())
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('candidate ' + candidateTag)
    expect(result.stdout).toContain(official + '@' + candidateVersion)
    expect(result.stdout).toContain('Published Latest=' + publishedTag)
  })

  it('rejects a manually pushed tag that does not match Candidate Source', () => {
    const result = run(makeFixture(), 'v9.9.9')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not match workspace candidate')
  })

  it('rejects workspace version drift', () => {
    const root = makeFixture()
    write(root, 'apps/tui/package.json', JSON.stringify({
      name: 'apps/tui/package.json',
      version: '0.1.2-alpha.2',
      dependencies: { [official]: candidateVersion },
    }, null, 2) + '\n')
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('apps/tui/package.json version')
  })

  it('rejects semver ranges for the official runtime dependency', () => {
    const root = makeFixture()
    write(root, 'apps/desktop/package.json', JSON.stringify({
      name: 'apps/desktop/package.json',
      version: candidateVersion,
      dependencies: { [official]: '^' + candidateVersion },
    }, null, 2) + '\n')
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('expected exact ' + candidateVersion)
  })
  it('rejects a candidate product that does not mirror the official pin', () => {
    const root = makeFixture()
    write(
      root,
      'packages/dsh-bridge/src/pin.ts',
      "export const PINNED_DSH_VERSION = '0.1.2-alpha.2' as const\n",
    )
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not mirror official pin')
  })

  it('rejects candidateTag drift independently of Published Latest', () => {
    const root = makeFixture()
    const facts = JSON.parse(readFileSync(join(root, 'docs/current-release.json'), 'utf8'))
    facts.candidateTag = publishedTag
    write(root, 'docs/current-release.json', JSON.stringify(facts, null, 2) + '\n')
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('candidateTag')
  })

  it('rejects fabricated candidate installers while Published Latest is still rc.2', () => {
    const root = makeFixture()
    const facts = JSON.parse(readFileSync(join(root, 'docs/current-release.json'), 'utf8'))
    facts.assets = publishedAssets(candidateVersion)
    facts.publishedAssets = { ...facts.assets }
    write(root, 'docs/current-release.json', JSON.stringify(facts, null, 2) + '\n')
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('for Published Latest')
  })

  it('rejects disagreement between assets and publishedAssets aliases', () => {
    const root = makeFixture()
    const facts = JSON.parse(readFileSync(join(root, 'docs/current-release.json'), 'utf8'))
    facts.publishedAssets.windowsSetup = 'forged.exe'
    write(root, 'docs/current-release.json', JSON.stringify(facts, null, 2) + '\n')
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('disagrees with assets')
  })

  it('rejects Published Latest drift even when matching asset filenames are also edited', () => {
    const root = makeFixture()
    const facts = JSON.parse(readFileSync(join(root, 'docs/current-release.json'), 'utf8'))
    const staleTag = facts.communityProduct.githubLatestTag
    facts.communityProduct.githubLatestTag = 'v0.1.1-rc.1'
    facts.assets = publishedAssets('0.1.1-rc.1')
    facts.publishedAssets = { ...facts.assets }
    write(root, 'docs/current-release.json', JSON.stringify(facts, null, 2) + '\n')
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('publishedReleaseEvidence tag')
    expect(staleTag).toBe(publishedTag)
  })

  it('rejects Published Latest evidence with a malformed digest', () => {
    const root = makeFixture()
    const facts = JSON.parse(readFileSync(join(root, 'docs/current-release.json'), 'utf8'))
    facts.publishedReleaseEvidence.primaryAssets.linuxAppImage.digest = 'sha256:not-a-digest'
    write(root, 'docs/current-release.json', JSON.stringify(facts, null, 2) + '\n')
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('digest is invalid')
  })

  it('keeps scripts/release.mjs on the same canonical validator', () => {
    const releaseScript = readFileSync(join(repoRoot, 'scripts/release.mjs'), 'utf8')
    expect(releaseScript).toContain("run(process.execPath, ['scripts/validate-release-tag.mjs', tag])")
  })
})
