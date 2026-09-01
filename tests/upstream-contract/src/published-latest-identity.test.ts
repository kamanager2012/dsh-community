import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const validator = join(repoRoot, 'scripts', 'validate-published-latest.mjs')

const tag = 'v0.1.1-rc.2'
const releaseId = 374950921
const publishedAt = '2026-08-22T14:25:10Z'
const url = 'https://github.com/kamanager2012/dsh-community/releases/tag/' + tag

const primary = {
  linuxAppImage: {
    name: 'dsh-community-0.1.1-rc.2.AppImage',
    assetId: 525116665,
    digest: 'sha256:52b7b786681a5a4e2726f91696e3baf532cb3fdbddf8d7714e57e2eef22beee6',
  },
  macosDmg: {
    name: 'dsh-community-0.1.1-rc.2.dmg',
    assetId: 525116664,
    digest: 'sha256:f3889c4f5c10e206d2e315bfb7c8fbdc3afbb50dd20400e9fdbcd797b5836229',
  },
  windowsSetup: {
    name: 'DSH.Community.Setup.0.1.1-rc.2.exe',
    assetId: 525116662,
    digest: 'sha256:c2a24e0fb8be45d14a3ea9f08d361907f94cdc3f77f49c6fcfcb8750aa7d6777',
  },
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-published-latest-'))
  roots.push(root)
  mkdirSync(join(root, 'docs'), { recursive: true })

  const names = {
    linuxAppImage: primary.linuxAppImage.name,
    macosDmg: primary.macosDmg.name,
    windowsSetup: primary.windowsSetup.name,
  }
  const facts = {
    communityProduct: { githubLatestTag: tag },
    assets: { ...names },
    publishedAssets: { ...names },
    publishedReleaseEvidence: {
      releaseId,
      tag,
      url,
      publishedAt,
      primaryAssets: structuredClone(primary),
    },
  }
  const release = {
    id: releaseId,
    tag_name: tag,
    html_url: url,
    published_at: publishedAt,
    draft: false,
    assets: Object.values(primary).map((asset) => ({
      id: asset.assetId,
      name: asset.name,
      digest: asset.digest,
    })),
  }

  writeFileSync(join(root, 'docs/current-release.json'), JSON.stringify(facts, null, 2) + '\n')
  writeFileSync(join(root, 'latest.json'), JSON.stringify(release, null, 2) + '\n')
  return { root, facts, release }
}

function writeFixture(root: string, facts: unknown, release: unknown) {
  writeFileSync(join(root, 'docs/current-release.json'), JSON.stringify(facts, null, 2) + '\n')
  writeFileSync(join(root, 'latest.json'), JSON.stringify(release, null, 2) + '\n')
}

function run(root: string) {
  return spawnSync(process.execPath, [validator, '--fixture', 'latest.json'], {
    cwd: root,
    encoding: 'utf8',
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Published Latest release-gate wiring', () => {
  it('runs the online Published Latest validator before local tagging', () => {
    const releaseScript = readFileSync(join(repoRoot, 'scripts/release.mjs'), 'utf8')
    const publishedIndex = releaseScript.indexOf("run(process.execPath, ['scripts/validate-published-latest.mjs'])")
    const tagIndex = releaseScript.indexOf("run('git', ['tag', tag])")
    expect(publishedIndex).toBeGreaterThan(-1)
    expect(tagIndex).toBeGreaterThan(publishedIndex)
  })

  it('runs the Published Latest validator in the tag identity job before release builds', () => {
    const workflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
    const candidateIndex = workflow.indexOf('node scripts/validate-release-tag.mjs')
    const publishedIndex = workflow.indexOf('node scripts/validate-published-latest.mjs')
    const buildIndex = workflow.indexOf('runtime-sbom:')
    expect(candidateIndex).toBeGreaterThan(-1)
    expect(publishedIndex).toBeGreaterThan(candidateIndex)
    expect(buildIndex).toBeGreaterThan(publishedIndex)
  })
})

describe('Published Latest identity validator', () => {
  it('accepts the exact GitHub release identity and three primary assets', () => {
    const { root } = makeRoot()
    const result = run(root)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Published Latest verified: ' + tag)
    expect(result.stdout).toContain('releaseId=' + releaseId)
    expect(result.stdout).toContain('primaryAssets=3')
  })

  it('rejects GitHub Latest tag drift even when the value is syntactically valid', () => {
    const { root, facts, release } = makeRoot()
    release.tag_name = 'v0.1.1-rc.1'
    writeFixture(root, facts, release)
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('GitHub Latest tag')
  })

  it('rejects release-id drift', () => {
    const { root, facts, release } = makeRoot()
    release.id = releaseId + 1
    writeFixture(root, facts, release)
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('release id')
  })

  it('rejects a mutated primary asset digest', () => {
    const { root, facts, release } = makeRoot()
    release.assets[0].digest = 'sha256:' + '0'.repeat(64)
    writeFixture(root, facts, release)
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('asset digest drift')
  })

  it('rejects a missing published primary asset', () => {
    const { root, facts, release } = makeRoot()
    release.assets = release.assets.filter((asset) => asset.name !== primary.macosDmg.name)
    writeFixture(root, facts, release)
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('missing published asset')
  })

  it('rejects evidence that renames an asset while the release facts stay unchanged', () => {
    const { root, facts, release } = makeRoot()
    facts.publishedReleaseEvidence.primaryAssets.windowsSetup.name = 'forged.exe'
    writeFixture(root, facts, release)
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('asset name drift')
  })
})
