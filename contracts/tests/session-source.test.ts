import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { dumpUsesOfficialSessionRoot } from '@dsh-community/dsh-bridge'
import { officialWebDump } from './domain-rows.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

describe('TUI, Desktop, and official Web share one session store', () => {
  it('official web persistence points at dshHomePath(sessions)', () => {
    expect(dumpUsesOfficialSessionRoot(officialWebDump())).toBe(true)
  })

  it('our TUI-owned patch points at the same official root', () => {
    const patch = readFileSync(
      join(root, 'packages/tui-adapter/patches/tui-owned.cordis.patch.yml'),
      'utf8',
    )
    expect(dumpUsesOfficialSessionRoot(patch)).toBe(true)
    expect(patch).not.toMatch(/\.dsh-tui/)
    expect(patch).not.toMatch(/\.dsh-cc/)
  })
})
