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

        const indent = lines[i]?.match(/^ */u)?.[0].length ?? 0
        const block: string[] = []
        for (let j = i + 1; j < lines.length; j += 1) {
          const line = lines[j] ?? ''
          if (line.trim() === '') {
            block.push(line)
            continue
          }
          const nextIndent = line.match(/^ */u)?.[0].length ?? 0
          if (nextIndent <= indent) break
          block.push(line)
        }

        if (!block.some((line) => line.trim() === 'persist-credentials: false')) {
          violations.push(name + ':' + String(i + 1))
        }
      }
    }

    expect(checkouts).toBeGreaterThan(0)
    expect(violations).toEqual([])
  })
})
