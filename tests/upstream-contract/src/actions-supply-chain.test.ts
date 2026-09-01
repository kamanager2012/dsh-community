import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflowDir = join(repoRoot, '.github', 'workflows')
const workflowFiles = readdirSync(workflowDir)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort()

const EXTERNAL_ACTION_RE = /uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^\s#]+)/gu

describe('GitHub Actions supply-chain pins', () => {
  it('pins every external action to an immutable 40-character commit SHA', () => {
    const violations: string[] = []
    let seen = 0

    for (const name of workflowFiles) {
      const content = readFileSync(join(workflowDir, name), 'utf8')
      for (const match of content.matchAll(EXTERNAL_ACTION_RE)) {
        seen += 1
        const action = match[1] ?? ''
        const ref = match[2] ?? ''
        if (!/^[0-9a-f]{40}$/u.test(ref)) {
          violations.push(name + ': ' + action + '@' + ref)
        }
      }
    }

    expect(seen).toBeGreaterThan(0)
    expect(violations).toEqual([])
  })

  it('does not persist the repository token in checkout git configuration', () => {
    const violations: string[] = []
    let checkouts = 0

    for (const name of workflowFiles) {
      const lines = readFileSync(join(workflowDir, name), 'utf8').split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i]?.includes('uses: actions/checkout@')) continue
        checkouts += 1

        // checkout's `with:` is either nested under "- uses:" or a sibling
        // of `uses:` in a named step. The credential setting must appear
        // immediately after checkout, before another action can begin.
        const block = lines.slice(i + 1, Math.min(lines.length, i + 6))
        const nextAction = block.findIndex((line) => line.includes('uses: '))
        const checkoutConfig = nextAction === -1 ? block : block.slice(0, nextAction)

        if (!checkoutConfig.some((line) => line.trim() === 'persist-credentials: false')) {
          violations.push(name + ':' + String(i + 1))
        }
      }
    }

    expect(checkouts).toBeGreaterThan(0)
    expect(violations).toEqual([])
  })
})
