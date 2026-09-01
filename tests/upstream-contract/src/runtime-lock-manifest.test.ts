import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OFFICIAL_DSH_PACKAGE, PINNED_DSH_VERSION } from '@dsh-community/dsh-bridge'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('official runtime lock manifest', () => {
  it('contains only the exact pinned official runtime dependency', () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, 'apps/desktop/runtime-lock/package.json'), 'utf8'),
    ) as {
      private?: boolean
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      scripts?: Record<string, string>
    }

    expect(manifest.private).toBe(true)
    expect(manifest.dependencies).toEqual({
      [OFFICIAL_DSH_PACKAGE]: PINNED_DSH_VERSION,
    })
    expect(manifest.devDependencies).toBeUndefined()
    expect(manifest.optionalDependencies).toBeUndefined()
    expect(manifest.scripts).toBeUndefined()
  })
})
