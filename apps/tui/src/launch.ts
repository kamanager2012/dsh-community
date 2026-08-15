import { COMMUNITY_TUI_PROFILE } from './profile.js'

export function officialTuiArgv(patchPath: string, extra: readonly string[] = []): string[] {
  return ['--profile', COMMUNITY_TUI_PROFILE, '--patch', patchPath, ...extra]
}

export type CommunityLaunch =
  | { readonly kind: 'list' }
  | { readonly kind: 'resume'; readonly id: string; readonly rest: readonly string[] }
  | { readonly kind: 'run'; readonly rest: readonly string[] }

export function parseCommunityLaunch(argv: readonly string[]): CommunityLaunch {
  if (argv[0] === '--list-sessions') return { kind: 'list' }
  if (argv[0] === '--resume') {
    const id = argv[1]
    if (id === undefined || id.length === 0 || id.startsWith('-')) {
      throw new Error('dsh-community-tui --resume needs an official session id (see --list-sessions)')
    }
    return { kind: 'resume', id, rest: argv.slice(2) }
  }
  return { kind: 'run', rest: argv }
}

export function resumeEnv(env: NodeJS.ProcessEnv, id: string): NodeJS.ProcessEnv {
  return { ...env, DSH_TUI_RESUME_SESSION: id }
}

export function isCommunityListSessions(argv: readonly string[]): boolean {
  return parseCommunityLaunch(argv).kind === 'list'
}
