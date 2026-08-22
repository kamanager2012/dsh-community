import { OFFICIAL_UI_CONTRACT } from '@dsh-community/shared-types'

/**
 * Re-export of the official UI contract for community surfaces.
 *
 * Community surfaces (the desktop shell and the TUI adapter) consume this
 * contract as-is. The agent loop, message derivation, and session storage
 * remain the responsibility of the official runtime; a community surface
 * that reimplements any of them breaks the single-runtime boundary this
 * workspace is built on.
 */
export const communityUiContract = OFFICIAL_UI_CONTRACT

export type CommunityUiRole = 'desktop-shell' | 'tui-adapter'

export interface CommunitySurface {
  readonly role: CommunityUiRole
  readonly runtime: 'official-dsh-subprocess' | 'official-dsh-plugin'
}

export const DESKTOP_SURFACE: CommunitySurface = {
  role: 'desktop-shell',
  runtime: 'official-dsh-subprocess',
}

export const TUI_SURFACE: CommunitySurface = {
  role: 'tui-adapter',
  runtime: 'official-dsh-plugin',
}
