import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OFFICIAL_UI_CONTRACT } from '@dsh-community/shared-types'

/**
 * Official Runtime is the foundation. Third-party TUI is reference only —
 * do not install or mount it.
 */

const surface = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../contracts/compatibility/tui-patch-surface.json'),
    'utf8',
  ),
) as {
  readonly interventionCount: number
  readonly communityTuiOwned?: number
  readonly milestones: readonly number[]
  readonly tuiOwnedInserts: readonly string[]
  readonly target: string
}

export const TUI_KEEP = [
  'official dsh --profile headless',
  'official ~/.dsh sessions',
] as const

export const TUI_MUST_NOT = [
  'implement AgentLoop',
  'write a second session log',
  'vendor official packages/core',
  'install @deepseek-harness-tui/dsh-tui',
  'mount a third-party TUI as our product',
] as const

export const TUI_BOOT = {
  install: 'none — official @deepseek-ai/dsh only',
  run: 'dsh --profile headless',
} as const

export const tuiSeam = {
  contract: OFFICIAL_UI_CONTRACT,
  sessionChannel: 'session/event',
  drive: 'ctx.agents',
  submitTurn: 'Agent.followup',
} as const

export const tuiPatchKpi = {
  current: surface.interventionCount,
  communityTuiOwned: surface.communityTuiOwned ?? surface.interventionCount,
  milestones: surface.milestones,
  tuiOwnedInserts: surface.tuiOwnedInserts,
  target: surface.target,
} as const
