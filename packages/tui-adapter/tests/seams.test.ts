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
    expect(TUI_KEEP).toContain('src/ink')
    expect(TUI_MUST_NOT).toContain('rewrite Ink')
    expect(TUI_MUST_NOT).toContain('implement AgentLoop')
    expect(TUI_MUST_NOT).toContain('claim official will never ship a TUI')
  })

  it('measures patch-surface reduction instead of promising a rewrite', () => {
    expect(tuiPatchKpi.current).toBe(33)
    expect(tuiPatchKpi.milestones).toEqual([33, 15, 8, 2])
    expect(tuiPatchKpi.tuiOwnedInserts).toEqual(['dsh-tui', 'working-activity'])
  })

  it('does not contain an Ink tree', () => {
    expect(existsSync(join(pkg, 'src/ink'))).toBe(false)
  })
})
