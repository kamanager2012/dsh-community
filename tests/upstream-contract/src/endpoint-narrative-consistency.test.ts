import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8')
}

describe('current endpoint narrative', () => {
  const currentNarrativeFiles = [
    'README.md',
    'README.en.md',
    'README.zh-CN.md',
    'ARCHITECTURE.md',
    'ECOSYSTEM.md',
    'AGENTS.md',
    'docs/story.md',
    'docs/getting-started.md',
    'docs/getting-started.en.md',
    'docs/community-endpoints.md',
    'docs/community-endpoints.en.md',
    'docs/current-release.md',
  ] as const

  it('does not regress to legacy four/five-endpoint claims after Complementary Edition narrowing', () => {
    for (const rel of currentNarrativeFiles) {
      const text = read(rel)
      expect(text, rel).not.toContain('One Harness. Four shipped community endpoints')
      expect(text, rel).not.toMatch(/five Community endpoints/iu)
      expect(text, rel).not.toContain('5 个 Community endpoints')
      expect(text, rel).not.toMatch(/四个(?:当前)?已发行/u)
      expect(text, rel).not.toContain('五个社区端')
    }
  })

  it('keeps three Complementary Community endpoints explicit while Android remains unpublished and unverified', () => {
    expect(read('README.md')).toMatch(/three complementary community endpoints/iu)
    expect(read('README.en.md')).toMatch(/three complementary community endpoints/iu)
    expect(read('ARCHITECTURE.md')).toMatch(/three complementary community endpoints/iu)
    expect(read('AGENTS.md')).toMatch(/three complementary community endpoints/iu)
    expect(read('ECOSYSTEM.md')).toMatch(/three complementary community endpoints/iu)
    expect(read('docs/story.md')).toMatch(/Three Complementary Community Endpoints/u)
    expect(read('docs/story.md')).toMatch(/三个互补社区端/u)

    for (const rel of [
      'README.md',
      'README.en.md',
      'ARCHITECTURE.md',
      'AGENTS.md',
      'docs/community-endpoints.en.md',
      'docs/current-release.md',
    ]) {
      expect(read(rel), rel).toMatch(/Android[\s\S]{0,200}(UNVERIFIED|experimental|Experimental)/u)
    }

    for (const rel of ['README.en.md', 'ECOSYSTEM.md', 'docs/community-endpoints.en.md']) {
      expect(read(rel), rel).toMatch(/deepseek-harness[\s\S]{0,160}(Windows|Win\/macOS)/iu)
    }
  })

  it('keeps Chinese onboarding aligned on two shipped Complementary endpoints and unverified Android', () => {
    const gettingStarted = read('docs/getting-started.md')
    expect(gettingStarted).toContain('三个互补 Community endpoints')
    expect(gettingStarted).toContain('两个当前已发行')
    expect(gettingStarted).toMatch(/Android.*UNVERIFIED/u)
  })

  it('keeps Candidate Source and Published Latest separate in public/maintainer narrative', () => {
    for (const rel of [
      'README.md',
      'README.en.md',
      'README.zh-CN.md',
      'AGENTS.md',
      'ECOSYSTEM.md',
      'docs/getting-started.md',
      'docs/getting-started.en.md',
      'docs/current-release.md',
    ]) {
      const text = read(rel)
      expect(text, rel).toMatch(/Candidate Source/u)
      expect(text, rel).toMatch(/Published Latest/u)
    }

    expect(read('README.zh-CN.md')).not.toMatch(/当前发行[^\n]{0,160}根目录[^\n]{0,80}workspace/u)
    expect(read('README.md')).not.toMatch(
      /current release[^\n]{0,160}root[^\n]{0,80}workspace/iu,
    )
    expect(read('README.en.md')).not.toMatch(
      /current release[^\n]{0,160}root[^\n]{0,80}workspace/iu,
    )
    expect(read('AGENTS.md')).toMatch(/Never infer one from the other/u)
    expect(read('ECOSYSTEM.md')).toMatch(/no single "current version" invariant/u)
    expect(read('docs/getting-started.md')).toMatch(/源码候选可以领先于已发布下载/u)
    expect(read('docs/getting-started.en.md')).toMatch(/source may lead the published download/u)
  })

  it('does not apply current-narrative rules to historical archives or changelog', () => {
    // Historical material is allowed to preserve what the project claimed at
    // that time. The guard intentionally scopes only currentNarrativeFiles.
    expect(currentNarrativeFiles).not.toContain('CHANGELOG.md')
    expect(currentNarrativeFiles).not.toContain('docs/archive/ecosystem-handoff-2026-08-21.md')
  })
})
