import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  OFFICIAL_DSH_BIN_REL,
  OFFICIAL_DSH_PACKAGE,
  PINNED_DSH_VERSION,
  COMMUNITY_PRODUCT_VERSION,
  communityBaseVersion,
  resolveOfficialDsh,
} from '@dsh-community/dsh-bridge'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

function readManifest(rel: string): {
  version?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  scripts?: Record<string, string>
} {
  return JSON.parse(readFileSync(join(repoRoot, rel), 'utf8')) as {
    version?: string
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    scripts?: Record<string, string>
  }
}

describe('community product version', () => {
  it('every workspace package.json uses the same community version', () => {
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
    const root = readManifest('package.json').version
    expect(root).toBe(COMMUNITY_PRODUCT_VERSION)
    if (root === undefined) throw new Error('root package.json must declare a version')
    expect(communityBaseVersion(root)).toBe(PINNED_DSH_VERSION)
    for (const rel of manifests) {
      expect(readManifest(rel).version, rel).toBe(root)
    }
  })
})

describe('root convenience scripts', () => {
  it('routes start/tui/doctor/sessions through the community launcher, not the surface', () => {
    const root = readManifest('package.json').scripts ?? {}
    const launcher = readManifest('apps/tui/package.json').scripts ?? {}
    expect(launcher.start).toMatch(/dist\/bin\.js/)
    for (const name of ['start', 'tui', 'new', 'doctor', 'sessions', 'plugins']) {
      expect(root[name], name).toMatch(/@dsh-community\/tui(?!-surface)/)
      expect(root[name], name).not.toMatch(/@dsh-community\/tui-surface start/)
    }
    expect(root.doctor).toMatch(/start -- doctor/)
    expect(root.sessions).toMatch(/start -- sessions/)
  })
})

describe('official pin consistency', () => {
  it('every workspace package that depends on official dsh uses the exact pin', () => {
    const manifests = [
      'packages/dsh-bridge/package.json',
      'apps/desktop/package.json',
      'apps/tui/package.json',
      'tests/upstream-contract/package.json',
    ]
    for (const rel of manifests) {
      const pin = readManifest(rel).dependencies?.[OFFICIAL_DSH_PACKAGE]
      expect(pin, rel).toBe(PINNED_DSH_VERSION)
    }
    const tuiPeers = readManifest('packages/tui/package.json').peerDependencies
    for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-agent']) {
      expect(tuiPeers?.[name], `packages/tui peer ${name}`).toBe(PINNED_DSH_VERSION)
    }
  })

  it('the installed official package matches the pin and bin contract', () => {
    const install = resolveOfficialDsh({ from: import.meta.url })
    expect(install.packageName).toBe(OFFICIAL_DSH_PACKAGE)
    expect(install.version).toBe(PINNED_DSH_VERSION)
    expect(install.binPath.replaceAll('\\', '/')).toMatch(new RegExp(`${OFFICIAL_DSH_BIN_REL}$`))
  })
})

describe('docs/current-release.json', () => {
  it('matches the pin, product version, Dual-Badge, and published asset names', () => {
    const facts = JSON.parse(
      readFileSync(join(repoRoot, 'docs/current-release.json'), 'utf8'),
    ) as {
      schemaVersion: number
      officialKernel: { package: string; version: string }
      communityProduct: { version: string; githubLatestTag: string }
      candidateTag: string
      dualBadge: string
      assets: { linuxAppImage: string; macosDmg: string; windowsSetup: string }
      publishedAssets: { linuxAppImage: string; macosDmg: string; windowsSetup: string }
      publishedReleaseEvidence: {
        releaseId: number
        tag: string
        url: string
        publishedAt: string
        primaryAssets: Record<string, { name: string; assetId: number; digest: string }>
      }
      historicalIndependentTags: string[]
    }
    const version = COMMUNITY_PRODUCT_VERSION
    expect(facts.officialKernel.package).toBe(OFFICIAL_DSH_PACKAGE)
    expect(facts.officialKernel.version).toBe(PINNED_DSH_VERSION)
    expect(facts.communityProduct.version).toBe(version)
    expect(facts.candidateTag).toBe(`v${version}`)
    expect(facts.communityProduct.githubLatestTag).toMatch(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
    const publishedVersion = facts.communityProduct.githubLatestTag.slice(1)
    expect(facts.publishedAssets).toEqual(facts.assets)
    expect(facts.dualBadge).toBe(
      `DeepSeek Harness Community v${version} [Official Core: ${OFFICIAL_DSH_PACKAGE}@${PINNED_DSH_VERSION}]`,
    )
    expect(facts.assets.linuxAppImage).toBe(`dsh-community-${publishedVersion}.AppImage`)
    expect(facts.assets.macosDmg).toBe(`dsh-community-${publishedVersion}.dmg`)
    expect(facts.assets.windowsSetup).toBe(`DSH.Community.Setup.${publishedVersion}.exe`)
    expect(facts.historicalIndependentTags).not.toContain(`v${version}`)
    expect(facts.historicalIndependentTags).not.toContain(facts.communityProduct.githubLatestTag)
    expect(facts.schemaVersion).toBeGreaterThanOrEqual(2)
    expect(facts.publishedReleaseEvidence.tag).toBe(facts.communityProduct.githubLatestTag)
    expect(facts.publishedReleaseEvidence.releaseId).toBeGreaterThan(0)
    expect(facts.publishedReleaseEvidence.url).toBe(
      `https://github.com/kamanager2012/dsh-community/releases/tag/${facts.communityProduct.githubLatestTag}`,
    )
    expect(facts.publishedReleaseEvidence.publishedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u,
    )
    for (const key of ['linuxAppImage', 'macosDmg', 'windowsSetup'] as const) {
      const evidence = facts.publishedReleaseEvidence.primaryAssets[key]
      expect(evidence?.name, key).toBe(facts.publishedAssets[key])
      expect(evidence?.assetId, key).toBeGreaterThan(0)
      expect(evidence?.digest, key).toMatch(/^sha256:[0-9a-f]{64}$/u)
    }
  })
})
