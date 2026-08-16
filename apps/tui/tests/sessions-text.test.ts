import { describe, expect, it } from 'vitest'
import {
  formatHumanSessions,
  formatPorcelainSessions,
  newestOfficialSession,
  parsePickChoice,
  resolveResumeTarget,
} from '../src/sessions-text.ts'

const sessions = [
  {
    id: 'sess-new',
    projectKey: '--tmp--',
    transcript: '/tmp/sessions/--tmp--/sess-new/session.jsonl.zstd',
    mtimeMs: Date.UTC(2026, 7, 16, 8, 0, 0),
  },
  {
    id: 'sess-old',
    projectKey: 'home',
    transcript: '/tmp/sessions/home/sess-old/session.jsonl.zstd',
    mtimeMs: Date.UTC(2026, 7, 15, 8, 0, 0),
  },
] as const

describe('resume targets stay on the official store', () => {
  it('resolves last to the newest listed session', () => {
    expect(newestOfficialSession(sessions)?.id).toBe('sess-new')
    expect(newestOfficialSession([])).toBeUndefined()
    expect(resolveResumeTarget('last', sessions)).toEqual({ ok: true, id: 'sess-new' })
    expect(resolveResumeTarget('sess-old', sessions)).toEqual({ ok: true, id: 'sess-old' })
    expect(resolveResumeTarget('missing', sessions).ok).toBe(false)
    expect(resolveResumeTarget('last', []).ok).toBe(false)
  })

  it('accepts a list number or last when picking', () => {
    expect(parsePickChoice('1', sessions)).toEqual({ ok: true, id: 'sess-new' })
    expect(parsePickChoice('2', sessions)).toEqual({ ok: true, id: 'sess-old' })
    expect(parsePickChoice('last', sessions)).toEqual({ ok: true, id: 'sess-new' })
    expect(parsePickChoice('9', sessions).ok).toBe(false)
  })

  it('prints a human list that tells you how to continue', () => {
    const human = formatHumanSessions(sessions, '/tmp/.dsh/sessions')
    expect(human).toMatch(/sess-new/)
    expect(human).toMatch(/← 最近/)
    expect(human).toMatch(/--resume last/)
    expect(formatPorcelainSessions(sessions)).toMatch(/^sess-new\t--tmp--\t/)
    expect(formatHumanSessions([], '/tmp/.dsh/sessions')).toMatch(/还没有对话/)
  })
})
