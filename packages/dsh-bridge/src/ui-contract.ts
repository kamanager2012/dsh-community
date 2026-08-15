import { OFFICIAL_UI_CONTRACT } from '@dsh-community/shared-types'

/**
 * Community UIs (Desktop window, future TUI adapter) attach here.
 * Implementing `AgentLoop`, `deriveMessages`, or a second session store
 * in this workspace is a layering violation.
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
