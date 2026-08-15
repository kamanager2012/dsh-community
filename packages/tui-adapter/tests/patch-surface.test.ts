import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const patches = join(here, '../patches')

function countPatchIds(text: string): number {
  return text.split('\n').filter((line) => /^- id:\s+\S+/.test(line) || /^ {4}- id:\s+\S+/.test(line)).length
}

describe('TUI patch-surface reduction', () => {
  const classification = JSON.parse(readFileSync(join(patches, 'classification.json'), 'utf8')) as {
    total: number
    presetIsolationDisables: string[]
    officialInserts: string[]
    tuiOwned: string[]
  }

  it('splits the 33-row upstream file into isolation vs TUI-owned', () => {
    expect(classification.total).toBe(33)
    expect(classification.presetIsolationDisables).toHaveLength(23)
    expect(classification.officialInserts).toHaveLength(2)
    expect(classification.tuiOwned).toHaveLength(8)
    expect(23 + 2 + 8).toBe(33)
  })

  it('keeps the TUI-owned file at or below the 15 milestone', () => {
    const owned = readFileSync(join(patches, 'tui-owned.cordis.patch.yml'), 'utf8')
    const isolation = readFileSync(join(patches, 'preset-isolation.cordis.patch.yml'), 'utf8')
    expect(countPatchIds(owned)).toBeLessThanOrEqual(15)
    expect(countPatchIds(owned)).toBeGreaterThanOrEqual(2)
    expect(countPatchIds(isolation)).toBe(25)
    expect(owned).toMatch(/dsh-tui/)
    expect(owned).not.toMatch(/tool-bash/)
    expect(owned).not.toMatch(/compaction-basic/)
    expect(isolation).toMatch(/tool-bash/)
  })
})
