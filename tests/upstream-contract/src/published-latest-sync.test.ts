import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const syncScript = join(repoRoot, 'scripts', 'sync-published-latest.mjs')

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-published-sync-'))
  roots.push(root)
  mkdirSync(join(root, 'docs'), { recursive: true })

  const facts = {
    schemaVersion: 2,
    asOf: '2026-08-22',
    officialKernel: {
      package: '@deepseek-ai/dsh',
      version: '0.1.2-alpha.3',
    },
    communityProduct: {
      version: '0.1.2-alpha.3',
      githubLatestTag: 'v0.1.1-rc.2',
    },
    candidateTag: 'v0.1.2-alpha.3',
    dualBadge:
      'DeepSeek Harness Community v0.1.2-alpha.3 '
      + '[Official Core: @deepseek-ai/dsh@0.1.2-alpha.3]',
    assets: {
      linuxAppImage: 'dsh-community-0.1.1-rc.2.AppImage',
      macosDmg: 'dsh-community-0.1.1-rc.2.dmg',
      windowsSetup: 'DSH.Community.Setup.0.1.1-rc.2.exe',
      note: 'existing note',
    },
    publishedAssets: {
      linuxAppImage: 'dsh-community-0.1.1-rc.2.AppImage',
      macosDmg: 'dsh-community-0.1.1-rc.2.dmg',
      windowsSetup: 'DSH.Community.Setup.0.1.1-rc.2.exe',
      note: 'existing note',
    },
    publishedReleaseEvidence: {
      releaseId: 1,
      tag: 'v0.1.1-rc.2',
      url: 'https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.1-rc.2',
      publishedAt: '2026-08-22T14:25:10Z',
      primaryAssets: {},
    },
    evidence: {
      userLoop: { status: 'UNVERIFIED', note: 'keep me' },
      pluginRegistryLastVerified: { testedDsh: '0.1.1-rc.2', note: 'keep me too' },
    },
  }

  const release = {
    id: 999,
    tag_name: 'v0.1.2-rc.1',
    html_url: 'https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.2-rc.1',
    published_at: '2026-09-02T01:02:03Z',
    draft: false,
    prerelease: false,
    assets: [
      {
        id: 101,
        name: 'dsh-community-0.1.2-rc.1.AppImage',
        digest: 'sha256:' + '1'.repeat(64),
      },
      {
        id: 102,
        name: 'dsh-community-0.1.2-rc.1.dmg',
        digest: 'sha256:' + '2'.repeat(64),
      },
      {
        id: 103,
        name: 'DSH.Community.Setup.0.1.2-rc.1.exe',
        digest: 'sha256:' + '3'.repeat(64),
      },
    ],
  }

  writeFileSync(join(root, 'docs/current-release.json'), JSON.stringify(facts, null, 2) + '\n')
  writeFileSync(join(root, 'latest.json'), JSON.stringify(release, null, 2) + '\n')
  return { root, facts, release }
}

function run(root: string, write = false) {
  return spawnSync(
    process.execPath,
    [syncScript, '--fixture', 'latest.json', ...(write ? ['--write'] : [])],
    { cwd: root, encoding: 'utf8' },
  )
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Published Latest synchronization', () => {
  it('dry-runs by default and leaves the file byte-for-byte unchanged', () => {
    const { root } = makeRoot()
    const path = join(root, 'docs/current-release.json')
    const before = readFileSync(path, 'utf8')
    const result = run(root)
    expect(result.status).toBe(3)
    expect(result.stdout).toContain('Published Latest sync required')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('updates only publication truth while preserving Candidate and evidence state', () => {
    const { root, facts } = makeRoot()
    const result = run(root, true)
    expect(result.status).toBe(0)

    const next = JSON.parse(
      readFileSync(join(root, 'docs/current-release.json'), 'utf8'),
    )
    expect(next.officialKernel).toEqual(facts.officialKernel)
    expect(next.communityProduct.version).toBe('0.1.2-alpha.3')
    expect(next.candidateTag).toBe('v0.1.2-alpha.3')
    expect(next.dualBadge).toBe(facts.dualBadge)
    expect(next.evidence).toEqual(facts.evidence)

    expect(next.communityProduct.githubLatestTag).toBe('v0.1.2-rc.1')
    expect(next.assets.linuxAppImage).toBe('dsh-community-0.1.2-rc.1.AppImage')
    expect(next.assets.macosDmg).toBe('dsh-community-0.1.2-rc.1.dmg')
    expect(next.assets.windowsSetup).toBe('DSH.Community.Setup.0.1.2-rc.1.exe')
    expect(next.publishedAssets).toEqual(next.assets)
    expect(next.publishedReleaseEvidence.releaseId).toBe(999)
    expect(next.publishedReleaseEvidence.primaryAssets.windowsSetup.assetId).toBe(103)
    expect(next.asOf).toBe('2026-09-02')
  })

  it('refuses to sync an alpha tag into Published Latest', () => {
    const { root, release } = makeRoot()
    release.tag_name = 'v0.1.2-alpha.3'
    release.html_url =
      'https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.2-alpha.3'
    writeFileSync(join(root, 'latest.json'), JSON.stringify(release, null, 2) + '\n')
    const result = run(root, true)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('not Latest-eligible')
  })

  it('fails closed when a required installer is missing', () => {
    const { root, release } = makeRoot()
    release.assets = release.assets.filter(
      (asset) => !asset.name.endsWith('.dmg'),
    )
    writeFileSync(join(root, 'latest.json'), JSON.stringify(release, null, 2) + '\n')
    const result = run(root, true)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('missing required primary asset')
  })

  it('fails closed on duplicate release asset names', () => {
    const { root, release } = makeRoot()
    release.assets.push({ ...release.assets[0], id: 104 })
    writeFileSync(join(root, 'latest.json'), JSON.stringify(release, null, 2) + '\n')
    const result = run(root, true)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('duplicate asset name')
  })
})
