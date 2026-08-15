/**
 * Community-owned types only.
 *
 * Official event names, ctx keys, and config rows live in
 * `contracts/upstream/*.snapshot.json`. Do not grow an event-types.ts here.
 */

export const OFFICIAL_PROFILES = ['web', 'headless'] as const
export type OfficialProfile = (typeof OFFICIAL_PROFILES)[number]

export const OFFICIAL_WEB_DEFAULT_ORIGIN = 'http://127.0.0.1:3080'

export interface OfficialWebBind {
  readonly host: '127.0.0.1' | 'localhost'
  /** `0` lets the OS pick. Official default when omitted is 3080. */
  readonly port: number
}

export interface ReadyOfficialWeb {
  readonly origin: string
  readonly pid?: number
}

export interface PinnedOfficialRuntime {
  readonly packageName: '@deepseek-ai/dsh'
  readonly version: string
  readonly binName: 'dsh'
}

/** Official architecture instruction — not a type we extend. */
export const OFFICIAL_UI_CONTRACT = {
  renderFrom: 'session/event',
  drive: 'ctx.agents',
  noSecondLoop: true,
} as const
