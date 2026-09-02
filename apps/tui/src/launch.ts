/**
 * Official launcher argv. Terminal boots our own dsh-community-tui profile
 * (our surface @dsh-community/tui-surface over official host seams). `dsh` owns
 * --profile/--patch.
 */
import { COMMUNITY_TUI_PROFILE } from './profile.js'

export function officialTuiArgv(patchPath: string, extra: readonly string[] = []): string[] {
  return ['--profile', COMMUNITY_TUI_PROFILE, '--patch', patchPath, ...extra]
}

export type CommunityLaunch =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'doctor' }
  | { readonly kind: 'desktop' }
  | { readonly kind: 'plugins'; readonly porcelain: boolean }
  | { readonly kind: 'list'; readonly porcelain: boolean }
  | { readonly kind: 'pick' }
  | { readonly kind: 'default' }
  | { readonly kind: 'new'; readonly rest: readonly string[] }
  | { readonly kind: 'resume'; readonly id: string; readonly rest: readonly string[] }
  | { readonly kind: 'run'; readonly rest: readonly string[] }

export const COMMUNITY_TUI_HELP = `dsh-community — 社区发行层，跑官方 @deepseek-ai/dsh

终端是我们的自研 @dsh-community/tui-surface（官方 seam 上）。
不安装、不挂第三方 TUI，第三方只许参考。

  dsh-community                     有对话就接着最近一条，否则开新的
  dsh-community new [任务]          新对话；任务正文不进入子进程 argv
  dsh-community resume last         接着最近一条
  dsh-community sessions            看官方 ~/.dsh 里的对话
  dsh-community version             统一 Dual-Badge（客户端版本 + 官方核心）
  dsh-community doctor              自检（不打印密钥）
  dsh-community plugins             只读插件目录
  dsh-community desktop             打开桌面壳

  --new / new
  --resume last|<id>  /  resume last|<id>
  --list-sessions / sessions / -l
  --plugins / plugins
  --version / version
  --doctor / doctor
  --desktop / desktop
  -h, --help
`

function peelLauncher(argv: readonly string[]): string[] {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv]
  if (args[0] === 'tui' || args[0] === 'start') return args.slice(1)
  return args
}

export function parseCommunityLaunch(argv: readonly string[]): CommunityLaunch {
  const args = peelLauncher(argv)
  const head = args[0]
  if (head === undefined || head === 'chat') return { kind: 'default' }
  if (head === '--new' || head === 'new') return { kind: 'new', rest: args.slice(1) }
  if (head === '--help' || head === '-h' || head === 'help') return { kind: 'help' }
  if (head === '--version' || head === '-v' || head === 'version') return { kind: 'version' }
  if (head === '--doctor' || head === 'doctor') return { kind: 'doctor' }
  if (head === '--desktop' || head === 'desktop') return { kind: 'desktop' }
  if (head === '--plugins' || head === 'plugins') {
    return { kind: 'plugins', porcelain: args.includes('--porcelain') }
  }
  if (
    head === '--list-sessions' || head === '-l' || head === 'sessions' || head === 'list'
  ) {
    return { kind: 'list', porcelain: args.includes('--porcelain') }
  }
  if (head === '--resume' || head === 'resume') {
    const id = args[1]
    if (id === undefined || id.length === 0 || id.startsWith('-')) return { kind: 'pick' }
    return { kind: 'resume', id, rest: args.slice(2) }
  }
  return { kind: 'run', rest: args }
}

/**
 * Official app args after launcher flags.
 *
 * User task text deliberately does NOT ride argv. On multi-user systems argv
 * is commonly process-list visible. The launcher transports the optional first
 * prompt through DSH_TUI_FIRST_PROMPT and our TUI consumes it through the
 * official agent.followup seam after boot.
 */
export function officialAppArgs(launch: Extract<CommunityLaunch, { kind: 'resume' } | { kind: 'run' }>): string[] {
  if (launch.kind === 'resume') return ['--resume', launch.id]
  return []
}

/** Optional first user turn, kept out of the child command line. */
export function initialPromptForLaunch(launch: CommunityLaunch): string | undefined {
  if (launch.kind !== 'new' && launch.kind !== 'run' && launch.kind !== 'resume') return undefined
  const prompt = launch.rest.join(' ').trim()
  return prompt === '' ? undefined : prompt
}

/**
 * Build the child environment without mutating the parent process.
 * Environment transport is process-scoped, not a secret store; the TUI deletes
 * DSH_TUI_FIRST_PROMPT immediately after reading it so later subprocesses do
 * not inherit the task text.
 */
export function tuiLaunchEnv(
  env: NodeJS.ProcessEnv,
  launch: CommunityLaunch,
  resumeId?: string,
): NodeJS.ProcessEnv {
  const next = resumeId === undefined ? { ...env } : resumeEnv(env, resumeId)
  const prompt = initialPromptForLaunch(launch)
  if (prompt !== undefined) next.DSH_TUI_FIRST_PROMPT = prompt
  else delete next.DSH_TUI_FIRST_PROMPT
  return next
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
