import type { OfficialSessionRef } from '@dsh-community/dsh-bridge'
import { formatOfficialSessionMtime } from '@dsh-community/dsh-bridge'

export function newestOfficialSession(
  sessions: readonly OfficialSessionRef[],
): OfficialSessionRef | undefined {
  return sessions[0]
}

export function resolveResumeTarget(
  requested: string,
  sessions: readonly OfficialSessionRef[],
): { ok: true; id: string } | { ok: false; reason: string } {
  if (sessions.length === 0) {
    return { ok: false, reason: 'no official sessions — run dsh-community new to start one' }
  }
  if (requested === 'last') {
    const named = sessions.find((session) => session.id === 'last')
    return { ok: true, id: named?.id ?? sessions[0]!.id }
  }
  const match = sessions.find((session) => session.id === requested)
  if (match === undefined) {
    return { ok: false, reason: `no official session ${requested} (try --list-sessions or --resume last)` }
  }
  return { ok: true, id: match.id }
}

export function parsePickChoice(
  raw: string,
  sessions: readonly OfficialSessionRef[],
): { ok: true; id: string } | { ok: false; reason: string } {
  const choice = raw.trim()
  if (choice.length === 0) return { ok: false, reason: 'empty choice' }
  if (/^\d+$/.test(choice)) {
    const index = Number(choice) - 1
    const session = sessions[index]
    if (session === undefined) return { ok: false, reason: `no session #${choice}` }
    return { ok: true, id: session.id }
  }
  return resolveResumeTarget(choice, sessions)
}

export function formatPorcelainSessions(sessions: readonly OfficialSessionRef[]): string {
  return sessions
    .map((session) =>
      `${session.id}\t${session.projectKey}\t${formatOfficialSessionMtime(session.mtimeMs)}\t${session.transcript}`,
    )
    .join('\n')
}

export function formatHumanSessions(
  sessions: readonly OfficialSessionRef[],
  root: string,
): string {
  if (sessions.length === 0) {
    return [
      `官方 ${root} 里还没有对话。TUI / Desktop / 官方 Web 共用这一份。`,
      '',
      '开新对话：',
      '  dsh-community-tui',
      '',
      '需要交互终端，以及 DEEPSEEK_API_KEY。',
      '',
    ].join('\n')
  }
  const lines = [
    `官方 session 共 ${String(sessions.length)} 条（${root}），与 Desktop / 官方 Web 共用。`,
    '',
  ]
  sessions.forEach((session, index) => {
    const mark = index === 0 ? '  ← 最近' : ''
    lines.push(
      `  ${String(index + 1).padStart(2, ' ')}  ${session.id}  ${session.projectKey}  ${formatOfficialSessionMtime(session.mtimeMs)}${mark}`,
    )
  })
  lines.push('')
  lines.push('恢复最近一条：')
  lines.push('  dsh-community-tui --resume last')
  lines.push('')
  lines.push('或选编号 / id：')
  lines.push('  dsh-community-tui --resume')
  lines.push(`  dsh-community-tui --resume ${sessions[0]!.id}`)
  lines.push('')
  return lines.join('\n')
}
