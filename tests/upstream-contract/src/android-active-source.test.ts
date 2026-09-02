import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')

describe('active Android endpoint source contract', () => {
  it('pins the exact official runtime and keeps the embedded Web host loopback-only', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(ROOT, 'apps/android/nodejs-project/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    expect(pkg.dependencies?.['@deepseek-ai/dsh']).toBe('0.1.2-alpha.4')

    const bootstrap = readFileSync(
      resolve(ROOT, 'apps/android/nodejs-project/src/main/js/main.js'),
      'utf8',
    )
    expect(bootstrap).toContain("'--host', '127.0.0.1'")
    expect(bootstrap).toContain("'--no-open'")
    expect(bootstrap).not.toMatch(/HOST:\s*['"]0\.0\.0\.0['"]/u)
  })

  it('does not promote Android beyond its real evidence state', () => {
    const doc = readFileSync(resolve(ROOT, 'docs/android-endpoint.md'), 'utf8')
    expect(doc).toContain('[UNVERIFIED]')
    expect(doc).toMatch(/Reality Gate/u)
  })
})
