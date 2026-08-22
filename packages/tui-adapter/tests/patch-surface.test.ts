import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const patches = join(here, '../patches')
const repoRoot = join(here, '../../..')

export interface PatchRow {
  readonly id: string
  readonly kind: 'override' | 'insert' | 'disable'
  readonly disabled: boolean
}

/**
 * Minimal reader for the flat list-of-rows patch format we ship. Top-level
 * `- id:` rows are overrides/disables; ids nested under `insert:` are inserts.
 */
export function parsePatchRows(text: string): PatchRow[] {
  const lines = text.split('\n')
  const rows: PatchRow[] = []
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)- id:\s+(\S+)/u.exec(lines[i] ?? '')
    if (match === null) continue
    const nestedInsert = (match[1]?.length ?? 0) > 0
    let disabled = false
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? ''
      if (next.trim() === '') continue
      disabled = /^\s+disabled:\s*true\s*$/u.test(next)
      break
    }
    const id = match[2] ?? ''
    const kind = nestedInsert ? 'insert' : disabled ? 'disable' : 'override'
    rows.push({ id, kind, disabled })
  }
  return rows
}

describe('TUI patch-surface reduction', () => {
  const classification = JSON.parse(readFileSync(join(patches, 'classification.json'), 'utf8')) as {
    total: number
    presetIsolationDisables: string[]
    officialInserts: string[]
    bundlePatch: { file: string; overrides: string[]; disables: string[] }
    tuiOwned: string[]
    note: string
  }

  // The two shipped patch files are the source of truth for every number here.
  const overlayText = readFileSync(join(patches, 'tui-owned.cordis.patch.yml'), 'utf8')
  const bundleText = readFileSync(join(repoRoot, 'packages/tui/cordis.patch.yml'), 'utf8')
  const overlayRows = parsePatchRows(overlayText)
  const bundleRows = parsePatchRows(bundleText)
  const overlayIds = overlayRows.map((row) => row.id)
  const bundleOverrideIds = bundleRows.filter((row) => row.kind === 'override').map((row) => row.id)
  const bundleInsertIds = bundleRows.filter((row) => row.kind === 'insert').map((row) => row.id)

  it('classifies the shipped runtime overlay exactly', () => {
    expect(classification.total).toBe(33)
    expect(classification.presetIsolationDisables).toHaveLength(0)
    expect(classification.officialInserts).toEqual(['dsh-community-tui'])
    // Exact row set of patches/tui-owned.cordis.patch.yml — order included.
    expect(overlayIds).toEqual([
      'system-prompt',
      'agent-loop',
      'sandbox-policy',
      'approval',
      'session-persistence-jsonl',
    ])
    expect(classification.tuiOwned).toEqual(overlayIds)
    expect(classification.tuiOwned).not.toContain('llm-deepseek')
    expect(classification.note).toMatch(/llm-deepseek/)
  })

  it('classifies the shipped bundle patch exactly', () => {
    expect(bundleRows.map((row) => row.id)).toEqual([
      'hmr',
      'dsh-community-tui',
      'user-questions',
      'approval',
    ])
    expect(bundleInsertIds).toEqual(['dsh-community-tui'])
    expect(bundleOverrideIds).toEqual(['user-questions', 'approval'])
    expect(classification.bundlePatch.file).toBe('packages/tui/cordis.patch.yml')
    expect(classification.bundlePatch.overrides).toEqual(bundleOverrideIds)
    expect(classification.bundlePatch.disables).toEqual(['hmr'])
    for (const row of bundleRows) {
      expect(row.disabled).toBe(row.id === 'hmr')
    }
  })

  it('keeps our overlay minimal and never disables official tools', () => {
    // Exact shipped rows replace the old 2..15 count range.
    expect(overlayIds).toEqual([
      'system-prompt',
      'agent-loop',
      'sandbox-policy',
      'approval',
      'session-persistence-jsonl',
    ])
    expect(overlayRows.every((row) => !row.disabled)).toBe(true)
    expect(overlayText).not.toMatch(/dsh-tui/)
    expect(overlayText).not.toMatch(/@deepseek-harness-tui/)
    expect(overlayText).not.toMatch(/disabled: true/)
  })

  it('never widens sandbox/approval by OS detection — only explicit env may widen', () => {
    // Regression: win32 used to hardcode danger-full-access + approval never
    // with no way to opt out. Defaults must be platform-uniform and safe.
    expect(overlayText).not.toMatch(/process\.platform/)
    expect(overlayText).toMatch(/DSH_PERMISSION_MODE/)
    expect(overlayText).toMatch(/DSH_APPROVAL_POLICY/)
    const defaultModes = overlayText.match(/DSH_PERMISSION_MODE\s*\?\?\s*'([^']+)'/) ?? []
    expect(defaultModes[1]).toBe('workspace-write')
  })

  it('contract KPI matches the union of both shipped patches', () => {
    const surface = JSON.parse(
      readFileSync(join(repoRoot, 'contracts/compatibility/tui-patch-surface.json'), 'utf8'),
    ) as {
      interventionCount: number
      communityTuiOwned: number
      communityTuiOwnedWritten: number
      presetIsolationRows: number
      overrides: string[]
      disables: string[]
      inserts: string[]
      tuiOwnedInserts: string[]
      milestones: number[]
    }
    const overrideUnion = [...new Set([...overlayIds, ...bundleOverrideIds])]
    expect([...surface.overrides].sort()).toEqual([...overrideUnion].sort())
    expect(surface.disables).toEqual(['hmr'])
    expect(surface.inserts).toEqual(['dsh-community-tui'])
    expect(surface.tuiOwnedInserts).toEqual([])
    expect(surface.interventionCount).toBe(overrideUnion.length + surface.disables.length + surface.inserts.length)
    expect(surface.communityTuiOwned).toBe(surface.interventionCount)
    expect(surface.communityTuiOwnedWritten).toBe(overlayIds.length)
    expect(surface.presetIsolationRows).toBe(0)
    expect(surface.milestones.at(-1)).toBe(surface.interventionCount)
    expect(JSON.stringify(surface)).not.toContain('llm-deepseek')
    expect(JSON.stringify(surface)).not.toContain('agent-presets')
    expect(JSON.stringify(surface)).not.toContain('cordis-host-runner')
    expect(JSON.stringify(surface)).not.toMatch(/ccch1mneyyy|dsh-TUI\/blob/)
  })
})
