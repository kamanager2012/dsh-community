import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

describe('Linux-first positioning claims', () => {
  const pages = ['README.md', 'README.zh-CN.md', 'README.en.md']
  const competitors = ['herdrdev/herdr', 'happier-dev/happier', 'getpaseo/paseo', 'pingdotgg/t3code', 'liguobao/ds-harness-remote']

  it('does not revert to star-count rankings or unique multi-agent claims', () => {
    for (const page of pages) {
      const s = read(page)
      expect(s, page).toContain('Herdr')
      expect(s, page).toContain('Paseo')
      expect(s, page).toContain('Happier')
      expect(s, page).toMatch(/UNVERIFIED/u)
      expect(s, page).not.toMatch(/\|\s*Stars\s*\|/iu)
      expect(s, page).not.toMatch(/\b0\s+stars?\b/iu)
    }
  })

  it('keeps first-party references, DSH-only session truth and opt-in feedback in both languages', () => {
    for (const [readme,guide] of [
      ['README.md', 'docs/competitive-positioning.md'],
      ['README.zh-CN.md', 'docs/competitive-positioning.md'],
      ['README.en.md', 'docs/competitive-positioning.en.md'],
    ]) {
      expect(read(readme), readme).toContain(guide)
      const text=read(guide)
      for (const repo of competitors) expect(text, guide).toContain('https://github.com/'+repo)
      expect(text, guide).toMatch(/~\/\.dsh/u)
      expect(text, guide).toContain('UNVERIFIED')
      expect(text, guide).toContain('first-run-feedback.yml')
    }
    const feedback=read('.github/ISSUE_TEMPLATE/first-run-feedback.yml')
    expect(feedback).toContain('required: true')
    expect(feedback).toContain('Never post API keys')
  })
})
