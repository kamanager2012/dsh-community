import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const source = readFileSync(join(root, 'scripts/accept-alpha3-integration.mjs'), 'utf8')

describe('alpha.3 consolidated acceptance runner', () => {
  it('runs one ordered local gate without release, PR, or provider side effects', () => {
    const order = [
      "scripts/validate-release-tag.mjs",
      "scripts/validate-published-latest.mjs",
      "['install', '--frozen-lockfile']",
      "['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund']",
      "['audit', '--package-lock-only', '--omit=dev', '--audit-level', 'high']",
      "['typecheck']",
      "['test']",
      "packages/marketplace/scripts/verify.mjs",
    ].map((needle) => source.indexOf(needle))

    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)

    expect(source).toContain("EXPECTED_TARGET = '0.1.2-alpha.3'")
    expect(source).toContain("merge-base', '--is-ancestor'")
    expect(source).toContain("git', ['status', '--porcelain']")
    expect(source).toContain("DSH_COMMUNITY_ALLOW_UNPINNED")
    expect(source).toContain('ALPHA3_INTEGRATION_ACCEPTANCE=PASS')

    for (const forbidden of [
      "git', ['tag'",
      "git', ['push'",
      'create_pull_request',
      'workflow_dispatch',
      'user-loop-evidence',
      'openai',
      'anthropic',
      'deepseek-chat',
    ]) {
      expect(source, forbidden).not.toContain(forbidden)
    }
  })
})
