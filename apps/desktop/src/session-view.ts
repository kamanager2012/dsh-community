export { formatOfficialSessionMtime as formatSessionMtime } from '@dsh-community/dsh-bridge'

export function officialResumeCommand(id: string): string {
  if (id.length === 0 || id.startsWith('-')) {
    throw new Error('official resume needs a session id')
  }
  return `dsh-community-tui --resume ${id}`
}
