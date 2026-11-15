import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow = readFileSync(join(repoRoot, '.github/workflows/dependency-review.yml'), 'utf8')

describe('dependency review gate', () => {
  it('runs on dependency-changing pull requests only', () => {
    expect(workflow).toContain('pull_request:')
    expect(workflow).not.toContain('pull_request_target')
    expect(workflow).toContain("'pnpm-lock.yaml'")
    expect(workflow).toContain("'**/package.json'")
  })

  it('also covers the independent shipped runtime lockfile', () => {
    expect(workflow).toContain("'apps/desktop/runtime-lock/package-lock.json'")
  })

  it('fails on high or critical advisories without continue-on-error', () => {
    expect(workflow).toContain('fail-on-severity: high')
    expect(workflow).not.toContain('continue-on-error: true')
  })

  it('stays read-only and pins every action to an immutable commit', () => {
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain('persist-credentials: false')
    const uses = [...workflow.matchAll(/uses:\s*(\S+)/gu)].map((m) => m[1] as string)
    expect(uses.length).toBeGreaterThan(0)
    for (const ref of uses) expect(ref).toMatch(/@[0-9a-f]{40}$/u)
  })
})
