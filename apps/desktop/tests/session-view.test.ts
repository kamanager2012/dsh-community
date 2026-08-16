import { describe, expect, it } from 'vitest'
import { formatSessionMtime, officialResumeCommand } from '../src/session-view.ts'

describe('official session view helpers', () => {
  it('builds the community TUI resume command', () => {
    expect(officialResumeCommand('sess-abc')).toBe('dsh-community-tui --resume sess-abc')
    expect(() => officialResumeCommand('')).toThrow(/session id/)
    expect(() => officialResumeCommand('--help')).toThrow(/session id/)
  })

  it('prints transcript mtime as UTC without inventing a second store', () => {
    expect(formatSessionMtime(0)).toBe('—')
    expect(formatSessionMtime(Number.NaN)).toBe('—')
    expect(formatSessionMtime(Date.UTC(2026, 7, 16, 0, 31, 15))).toBe('2026-08-16 00:31:15 UTC')
  })
})
