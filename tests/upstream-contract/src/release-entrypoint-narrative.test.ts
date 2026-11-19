import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const facts = JSON.parse(read('docs/current-release.json')) as {
  communityProduct: { githubLatestTag: string }
  candidateTag: string
  publishedReleaseEvidence: { tag: string }
  evidence: { candidatePrerelease: { status: string; tag: string; url: string } }
}
const preview = facts.evidence.candidatePrerelease
// A pre-release is only surfaced as a separate channel when it is a community patch on top of the current Latest.
const hasNewerPreview = preview.tag.startsWith(facts.communityProduct.githubLatestTag + '-community.')

describe('release channel onboarding accuracy', () => {
  const readmes = ['README.md', 'README.zh-CN.md', 'README.en.md'] as const
  it('distinguishes the Latest badge from preview and grounds both channels', () => {
    expect(preview.status).toBe('PASS')
    for (const name of readmes) {
      const body = read(name)
      expect(body, name).toContain('github/v/release/kamanager2012/dsh-community?label=Published%20Latest')
      expect(body, name).not.toContain('include_prereleases&label=Published%20Latest')
      expect(body, name).not.toContain('include_prereleases&label=Community%20Preview')
      const badgeVersion = preview.tag.replaceAll('-', '--')
      if (hasNewerPreview) {
        expect(body, name).toContain('img.shields.io/badge/Community%20Preview-' + badgeVersion + '-blue')
      } else {
        expect(body, name).not.toContain('img.shields.io/badge/Community%20Preview-')
      }
      expect(body, name).toContain(preview.url)
      expect(body, name).toContain(facts.communityProduct.githubLatestTag)
    }
  })
  it('pins installer implementation separately from the target git checkout', () => {
    const targetRef = hasNewerPreview ? preview.tag : facts.communityProduct.githubLatestTag
    const expectedCommit = hasNewerPreview
      ? 'fe54d126b57a9dc3439ce22751cacfffa0a81ede'
      : '0a8009d0462042764ad67e87208df791f1f6180b'
    for (const name of readmes) {
      const body = read(name)
      expect(body, name).toContain('raw.githubusercontent.com/kamanager2012/dsh-community/afe0514e9da98174ac117e70d7e9fb30aa48de2b/scripts/install-linux.sh')
      expect(body, name).toContain('--ref ' + targetRef)
      expect(body, name).toContain('--expected-commit ' + expectedCommit)
      expect(body, name).not.toMatch(/raw\.githubusercontent\.com\/kamanager2012\/dsh-community\/main\/scripts\/install-linux\.sh\s*\|\s*bash/u)
      expect(body, name).toContain('.sigstore.json')
    }
  })
  it('keeps getting-started pages and release-cut examples consistent', () => {
    for (const name of ['docs/getting-started.md', 'docs/getting-started.en.md']) {
      const body = read(name)
      expect(body, name).toContain(preview.url)
      expect(body, name).toContain(facts.communityProduct.githubLatestTag)
      expect(body, name).toContain('--ref ' + facts.communityProduct.githubLatestTag)
      expect(body, name).toContain('--expected-commit 0a8009d0462042764ad67e87208df791f1f6180b')
      expect(body, name).toContain('UNVERIFIED')
    }
    const release = read('docs/release.md')
    expect(release).toContain('REVIEWED_NEW_TAG')
    expect(release).not.toContain('node scripts/release.mjs v0.1.1-rc.2')
  })
})
