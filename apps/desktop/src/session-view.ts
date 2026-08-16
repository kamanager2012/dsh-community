export function officialResumeCommand(id: string): string {
  if (id.length === 0 || id.startsWith('-')) {
    throw new Error('official resume needs a session id')
  }
  return `dsh-community-tui --resume ${id}`
}

export function formatSessionMtime(mtimeMs: number): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return '—'
  return `${new Date(mtimeMs).toISOString().slice(0, 19).replace('T', ' ')} UTC`
}
