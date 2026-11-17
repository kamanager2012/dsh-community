import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const facts = JSON.parse(read('docs/current-release.json')) as {
  officialKernel: { version: string }
  communityProduct: { version: string; githubLatestTag: string }
  candidateTag: string
  dualBadge: string
  evidence: { candidatePrerelease: { tag: string; status: string; url: string } }
  publishedReleaseEvidence: { tag: string }
}

describe('community preview candidate identity', () => {
  it('keeps every workspace package at the candidate product version and the official pin intact', () => {
    const manifests = [
      'package.json', 'apps/desktop/package.json', 'apps/tui/package.json',
      'apps/remote-web/package.json', 'packages/dsh-bridge/package.json',
      'packages/shared-types/package.json', 'packages/tui-adapter/package.json',
      'packages/tui/package.json', 'packages/marketplace/package.json',
      'packages/remote-adapter/package.json', 'tests/upstream-contract/package.json',
    ] as const
    for (const name of manifests) {
      const entry = JSON.parse(read(name)) as { version: string }
      expect(entry.version, name).toBe(facts.communityProduct.version)
    }
    expect(facts.candidateTag).toBe('v' + facts.communityProduct.version)
    expect(facts.officialKernel.version).toBe('0.2.2-rc.3')
    const android = read('apps/android/app/build.gradle.kts')
    expect(android).toContain('versionName = "' + facts.communityProduct.version + '"')
    expect(android).toMatch(/versionCode\s*=\s*[1-9]\d*/u)
  })

  it('keeps candidate documentation consistent without forging release evidence', () => {
    const current = read('docs/current-release.md')
    expect(current).toContain('| Candidate community product | `' + facts.communityProduct.version + '` |')
    expect(current).toContain('| Candidate tag | `' + facts.candidateTag + '`')
    expect(current).toContain(facts.dualBadge)
    expect(current).toContain('| GitHub Latest | [`' + facts.communityProduct.githubLatestTag + '`]')
    expect(facts.publishedReleaseEvidence.tag).toBe(facts.communityProduct.githubLatestTag)
    const handbook = [
      'handbook/VERSION.md',
      'handbook/content/00-overview/community-ecosystem.md',
      'handbook/en/00-overview/community-ecosystem.md',
      'handbook/content/11-operations/community-release-status.md',
      'handbook/en/11-operations/community-release-status.md',
      'handbook/content/11-operations/community-release-runbook.md',
      'handbook/en/11-operations/community-release-runbook.md',
    ] as const
    for (const name of handbook) {
      const content = read(name)
      expect(content, name).toContain(facts.candidateTag)
      expect(content, name).toContain(facts.evidence.candidatePrerelease.tag)
      if (facts.evidence.candidatePrerelease.tag !== facts.candidateTag) {
        expect(content, name).toMatch(/unpublished|未发布|待发布/u)
      }
    }
    expect(read('CHANGELOG.md')).toContain('## ' + facts.communityProduct.version)
    expect(facts.evidence.candidatePrerelease.status).toBe('PASS')
    expect(facts.evidence.candidatePrerelease.url).toContain(facts.evidence.candidatePrerelease.tag)
  })
})
