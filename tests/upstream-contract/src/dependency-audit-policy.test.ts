import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow = readFileSync(join(repoRoot, '.github/workflows/dependency-audit.yml'), 'utf8')

describe('dependency audit gate', () => {
  it('audits dependency-changing pull requests and also runs weekly', () => {
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain("'pnpm-lock.yaml'")
    expect(workflow).toContain("'**/package.json'")
    expect(workflow).toContain('schedule:')
    expect(workflow).toContain('workflow_dispatch:')
  })

  it('fails on high or critical advisories instead of continuing on error', () => {
    expect(workflow).toContain('pnpm audit --audit-level high')
    expect(workflow).not.toContain('continue-on-error: true')
  })

  it('keeps the audit read-only and uses an immutable checkout', () => {
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/u)
    expect(workflow).toContain('persist-credentials: false')
  })
})
