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

  it('owns only config rows — no tool disables, no third-party names', () => {
    expect(classification.total).toBe(33)
    expect(classification.presetIsolationDisables).toHaveLength(0)
    expect(classification.officialInserts).toEqual(['dsh-community-tui'])
    expect(classification.tuiOwned).toHaveLength(6)
    expect(classification.tuiOwned).not.toContain('dsh-tui')
  })

  it('keeps our overlay minimal and never disables official tools', () => {
    const owned = readFileSync(join(patches, 'tui-owned.cordis.patch.yml'), 'utf8')
    expect(countPatchIds(owned)).toBeLessThanOrEqual(15)
    expect(countPatchIds(owned)).toBeGreaterThanOrEqual(2)
    expect(owned).not.toMatch(/dsh-tui/)
    expect(owned).not.toMatch(/@deepseek-harness-tui/)
    expect(owned).not.toMatch(/disabled: true/)
  })
})
