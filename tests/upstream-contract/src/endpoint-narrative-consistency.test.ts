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

  it('does not regress to the four-endpoint product-count slogan', () => {
    for (const rel of currentNarrativeFiles) {
      expect(read(rel), rel).not.toContain('One Harness. Four shipped community endpoints')
    }
  })

  it('keeps five Community endpoints explicit while Android remains unpublished and unverified', () => {
    expect(read('README.en.md')).toMatch(/five Community endpoints/i)
    expect(read('ARCHITECTURE.md')).toMatch(/five Community endpoints/i)
    expect(read('AGENTS.md')).toMatch(/five Community endpoints/i)
    expect(read('docs/story.md')).toMatch(/Five Community Endpoints/i)
    expect(read('ECOSYSTEM.md')).toMatch(/five Community endpoints/i)

    for (const rel of [
      'README.en.md',
      'ARCHITECTURE.md',
      'AGENTS.md',
      'docs/community-endpoints.en.md',
      'docs/current-release.md',
    ]) {
      expect(read(rel), rel).toMatch(/Android[\s\S]{0,180}(UNVERIFIED|experimental|Experimental)/u)
    }
  })

  it('keeps Chinese onboarding from counting Android as a fifth shipped endpoint', () => {
    const gettingStarted = read('docs/getting-started.md')
    expect(gettingStarted).not.toContain('五个社区端定义')
    expect(gettingStarted).toMatch(/四个(?:当前)?已发行/)
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
