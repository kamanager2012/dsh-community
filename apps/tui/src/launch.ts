import { COMMUNITY_TUI_PROFILE } from './profile.js'

/**
 * Official launcher argv. `dsh` owns --profile/--patch; everything after
 * reaches the booted app. Official help: `dsh --profile tui --resume <session>`.
 */
export function officialTuiArgv(patchPath: string, extra: readonly string[] = []): string[] {
  return ['--profile', COMMUNITY_TUI_PROFILE, '--patch', patchPath, ...extra]
}

export type CommunityLaunch =
  | { readonly kind: 'help' }
  | { readonly kind: 'list' }
  | { readonly kind: 'resume'; readonly id: string; readonly rest: readonly string[] }
  | { readonly kind: 'run'; readonly rest: readonly string[] }

export const COMMUNITY_TUI_HELP = `dsh-community-tui — community terminal on official @deepseek-ai/dsh

Usage:
  dsh-community-tui
  dsh-community-tui --list-sessions
  dsh-community-tui --resume <official-session-id>

  --list-sessions     read-only list of official ~/.dsh/sessions
  --resume <id>       official dsh --profile … --resume <id>
  -h, --help          this help

Other args are passed through to official dsh after --profile/--patch.
Session store is official ~/.dsh, shared with Desktop and official Web.
This binary is not dsh-tui and is not published as @deepseek-ai/*.
`

export function parseCommunityLaunch(argv: readonly string[]): CommunityLaunch {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv]
  if (args[0] === '--help' || args[0] === '-h') return { kind: 'help' }
  if (args[0] === '--list-sessions') return { kind: 'list' }
  if (args[0] === '--resume') {
    const id = args[1]
    if (id === undefined || id.length === 0 || id.startsWith('-')) {
      throw new Error('dsh-community-tui --resume needs an official session id (see --list-sessions)')
    }
    return { kind: 'resume', id, rest: args.slice(2) }
  }
  return { kind: 'run', rest: args }
}

/** Official app args after launcher flags. */
export function officialAppArgs(launch: Extract<CommunityLaunch, { kind: 'resume' } | { kind: 'run' }>): string[] {
  if (launch.kind === 'resume') return ['--resume', launch.id, ...launch.rest]
  return [...launch.rest]
}

/**
 * The mounted TUI plugin feeds official `ctx.agents.resume` from config.sessionId.
 * That config reads these env names. This is not a second session store.
 */
export function resumeEnv(env: NodeJS.ProcessEnv, id: string): NodeJS.ProcessEnv {
  return {
    ...env,
    DSH_TUI_RESUME_SESSION: id,
    DSH_CC_RESUME_SESSION: id,
  }
}

export function isCommunityListSessions(argv: readonly string[]): boolean {
  return parseCommunityLaunch(argv).kind === 'list'
}
