import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const source = readFileSync(join(root, 'scripts/accept-0.2.2-rc.2-integration.mjs'), 'utf8')

describe('0.2.2-rc.2 consolidated acceptance runner', () => {
  it('runs one ordered local gate without release, PR, or provider side effects', () => {
    const order = [
      'scripts/validate-release-tag.mjs',
      'scripts/validate-published-latest.mjs',
      "['install', '--frozen-lockfile']",
      "['audit', '--audit-level', 'high', '--registry', auditRegistry]",
      "['contracts:extract']",
      "['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund']",
      "['audit', '--package-lock-only', '--omit=dev', '--audit-level', 'high', '--registry', auditRegistry]",
      'scripts/verify-android-release-ready.mjs',
      "['typecheck']",
      "['test']",
      'packages/marketplace/scripts/verify.mjs',
    ].map((needle) => source.indexOf(needle))

    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)

    expect(source).toContain("EXPECTED_TARGET = '0.2.2-rc.2'")
    expect(source).toContain("PREVIOUS_ACCEPTED = '0.2.2-rc.1'")
    expect(source).toContain("merge-base', '--is-ancestor'")
    expect(source.match(/git', \['status', '--porcelain'\]/gu)?.length)
      .toBeGreaterThanOrEqual(2)
    expect(source).toContain('gate.acceptedBaseline?.commit')
    expect(source).toContain("gate.finalAcceptance?.version !== EXPECTED_TARGET")
    expect(source).toContain("acceptanceStatus !== 'PENDING' && acceptanceStatus !== 'PASS'")
    expect(source).toContain('packageNameFromLockPath')
    expect(source).toContain('runtime lock contains mixed DSH family versions')
    expect(source).toContain('runtime-lock exact family verified')
    expect(source).toContain('providerSafeEnv')
    expect(source).toContain("'DEEPSEEK_API_KEY'")
    expect(source).toContain("'OPENAI_API_KEY'")
    expect(source).toContain("'ANTHROPIC_API_KEY'")
    expect(source).toContain('RC2_INTEGRATION_ACCEPTANCE=PASS')

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
