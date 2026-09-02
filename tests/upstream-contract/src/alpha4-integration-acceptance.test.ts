import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const source = readFileSync(join(root, 'scripts/accept-alpha4-integration.mjs'), 'utf8')

describe('alpha.4 consolidated acceptance runner', () => {
  it('runs one ordered local gate without release, PR, or provider side effects', () => {
    const order = [
      "scripts/validate-release-tag.mjs",
      "scripts/validate-published-latest.mjs",
      "['install', '--frozen-lockfile']",
      "['contracts:extract']",
      "['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund']",
      "['audit', '--package-lock-only', '--omit=dev', '--audit-level', 'high']",
      "['typecheck']",
      "['test']",
      "packages/marketplace/scripts/verify.mjs",
    ].map((needle) => source.indexOf(needle))

    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)

    expect(source).toContain("EXPECTED_TARGET = '0.1.2-alpha.4'")
    expect(source).toContain("PREVIOUS_ACCEPTED = '0.1.2-alpha.3'")
    expect(source).toContain("merge-base', '--is-ancestor'")
    expect(source.match(/git', \['status', '--porcelain'\]/gu)?.length)
      .toBeGreaterThanOrEqual(2)
    expect(source).toContain('gate.acceptedBaseline?.commit')
    expect(source).toContain("gate.finalAcceptance?.status !== 'PENDING'")
    expect(source).toContain('packageNameFromLockPath')
    expect(source).toContain('runtime lock contains mixed DSH family versions')
    expect(source).toContain('runtime-lock exact family verified')
    expect(source).toContain('providerSafeEnv')
    expect(source).toContain("'DEEPSEEK_API_KEY'")
    expect(source).toContain("'OPENAI_API_KEY'")
    expect(source).toContain("'ANTHROPIC_API_KEY'")
    expect(source).toContain('ALPHA4_INTEGRATION_ACCEPTANCE=PASS')

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
