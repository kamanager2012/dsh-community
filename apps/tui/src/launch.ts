import { COMMUNITY_TUI_PROFILE } from './profile.js'

export function officialTuiArgv(patchPath: string, extra: readonly string[] = []): string[] {
  return ['--profile', COMMUNITY_TUI_PROFILE, '--patch', patchPath, ...extra]
}

export function isCommunityListSessions(argv: readonly string[]): boolean {
  return argv[0] === '--list-sessions'
}
