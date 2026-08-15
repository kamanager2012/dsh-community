import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OFFICIAL_UI_CONTRACT } from '@dsh-community/shared-types'

/**
 * Reconstruction target for `dsh-TUI`.
 * Keep Ink. KPI is patch-surface reduction, not a rewrite.
 */

const surface = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../contracts/compatibility/tui-patch-surface.json'),
    'utf8',
  ),
) as {
  readonly interventionCount: number
  readonly milestones: readonly number[]
  readonly tuiOwnedInserts: readonly string[]
  readonly target: string
}

export const TUI_KEEP = [
  'src/ink',
  'screens',
  'theme',
  'activity line',
  'Esc-Esc undo',
  'i18n',
] as const

export const TUI_MUST_NOT = [
  'implement AgentLoop',
  'write a second session log',
  'vendor official packages/core',
  'rewrite Ink',
  'claim official will never ship a TUI',
] as const

export const TUI_BOOT = {
  install: 'dsh plugin --profile tui add @deepseek-harness-tui/dsh-tui',
  run: 'dsh --profile tui',
} as const

export const tuiSeam = {
  contract: OFFICIAL_UI_CONTRACT,
  sessionChannel: 'session/event',
  drive: 'ctx.agents',
  submitTurn: 'Agent.followup',
} as const

export const tuiPatchKpi = {
  current: surface.interventionCount,
  milestones: surface.milestones,
  tuiOwnedInserts: surface.tuiOwnedInserts,
  target: surface.target,
} as const
