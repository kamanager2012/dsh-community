import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TUI_KEEP, TUI_MUST_NOT, tuiPatchKpi, tuiSeam } from '../src/index.ts'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('tui adapter reconstruction', () => {
  it('hangs on the official UI contract, not a second loop', () => {
    expect(tuiSeam.contract.noSecondLoop).toBe(true)
    expect(tuiSeam.sessionChannel).toBe('session/event')
    expect(tuiSeam.submitTurn).toBe('Agent.followup')
    expect(TUI_KEEP).toContain('official dsh --profile headless')
    expect(TUI_MUST_NOT).toContain('install @deepseek-harness-tui/dsh-tui')
    expect(TUI_MUST_NOT).toContain('implement AgentLoop')
    expect(TUI_MUST_NOT).toContain('mount a third-party TUI as our product')
  })

  it('does not mount a third-party TUI plugin', () => {
    expect(tuiPatchKpi.tuiOwnedInserts).toEqual([])
    // Regenerated from the two shipped patch files (see tui-patch-surface.json):
    // 6 distinct row overrides + hmr disable + our own dsh-community-tui insert.
    expect(tuiPatchKpi.communityTuiOwned).toBe(8)
  })

  it('does not contain an Ink tree', () => {
    expect(existsSync(join(pkg, 'src/ink'))).toBe(false)
  })
})
