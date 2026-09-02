import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')

describe('Android subprocess provider composition', () => {
  it('reuses official ordinary subprocess behavior and overrides only the Android terminal primitive', () => {
    const provider = readFileSync(
      resolve(ROOT, 'apps/android/nodejs-project/src/main/js/android-subprocess-provider.mjs'),
      'utf8',
    )

    expect(provider).toContain("import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'")
    expect(provider).toContain("import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'")
    expect(provider).toContain("import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'")
    expect(provider).toContain("import * as nodePty from 'node-pty'")
    expect(provider).toContain('class AndroidSubprocessRuntime extends LocalSubprocessRuntime')
    expect(provider).toContain('async spawnTerminal(spec)')
    expect(provider).toContain("process.platform !== 'android'")
    expect(provider).not.toContain('terminalInspector')
    expect(provider).toContain('const env = scrubbedParentEnv()')
    expect(provider).toContain('if (value === undefined) delete env[key]')
    expect(provider).toContain('spec.graceMs > MAX_TIMER_DELAY_MS')
    expect(provider).not.toMatch(/\bspawn\s*\(spec\)/u)
    expect(provider).not.toContain('/proc/')
  })

  it('declares exact direct runtime dependencies rather than relying on transitive hoisting', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(ROOT, 'apps/android/nodejs-project/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }

    expect(pkg.dependencies).toMatchObject({
      '@deepseek-ai/dsh': '0.1.2-alpha.4',
      '@deepseek-ai/dsh-sandbox': '0.1.2-alpha.4',
      '@deepseek-ai/dsh-subprocess': '0.1.2-alpha.4',
      '@deepseek-ai/dsh-subprocess-local': '0.1.2-alpha.4',
      '@deepseek-ai/dsh-timeout': '0.1.2-alpha.4',
      'node-pty': '1.2.0-beta.15',
    })
  })

  it('replaces the shipped subprocess and sandbox rows in place without insert collisions', () => {
    const patch = readFileSync(
      resolve(ROOT, 'apps/android/nodejs-project/src/main/js/android.cordis.patch.yml'),
      'utf8',
    )

    expect(patch).toMatch(/- id: subprocess\n\s+name: \.\/android-subprocess-provider\.mjs\n\s+disabled: false/u)
    expect(patch).toMatch(/- id: sandbox\n\s+name: \.\/android-sandbox-provider\.mjs\n\s+disabled: false/u)
    expect(patch).not.toContain('- insert:')
    expect((patch.match(/- id: subprocess/g) ?? [])).toHaveLength(1)
    expect((patch.match(/- id: sandbox/g) ?? [])).toHaveLength(1)
  })
})
