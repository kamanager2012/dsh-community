import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  OFFICIAL_DSH_BIN_REL,
  OFFICIAL_DSH_PACKAGE,
  PINNED_DSH_VERSION,
  resolveOfficialDsh,
} from '@dsh-community/dsh-bridge'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

function readManifest(rel: string): { version?: string; dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(repoRoot, rel), 'utf8')) as {
    version?: string
    dependencies?: Record<string, string>
  }
}

describe('community product version', () => {
  it('every workspace package.json uses the same community version', () => {
    const manifests = [
      'package.json',
      'apps/desktop/package.json',
      'apps/tui/package.json',
      'packages/dsh-bridge/package.json',
      'packages/shared-types/package.json',
      'packages/tui-adapter/package.json',
      'tests/upstream-contract/package.json',
    ]
    const root = readManifest('package.json').version
    expect(root).toMatch(/^\d+\.\d+\.\d+$/)
    for (const rel of manifests) {
      expect(readManifest(rel).version, rel).toBe(root)
    }
  })
})

describe('official pin consistency', () => {
  it('every workspace package that depends on official dsh uses the exact pin', () => {
    const manifests = [
      'packages/dsh-bridge/package.json',
      'apps/desktop/package.json',
      'apps/tui/package.json',
      'tests/upstream-contract/package.json',
    ]
    for (const rel of manifests) {
      const pin = readManifest(rel).dependencies?.[OFFICIAL_DSH_PACKAGE]
      expect(pin, rel).toBe(PINNED_DSH_VERSION)
    }
  })

  it('the installed official package matches the pin and bin contract', () => {
    const install = resolveOfficialDsh({ from: import.meta.url })
    expect(install.packageName).toBe(OFFICIAL_DSH_PACKAGE)
    expect(install.version).toBe(PINNED_DSH_VERSION)
    expect(install.binPath.replaceAll('\\', '/')).toMatch(new RegExp(`${OFFICIAL_DSH_BIN_REL}$`))
  })
})
