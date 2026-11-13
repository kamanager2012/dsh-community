import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  dumpUsesOfficialSessionRoot,
  formatOfficialSessionMtime,
  listOfficialSessions,
  officialSessionRoot,
  peekOfficialSessionSummary,
} from '../src/session-store.ts'

describe('official session store', () => {
  it('lists jsonl transcripts under the official layout only', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sessions-'))
    const sessionDir = join(root, '--tmp-proj--', 'sess-abc')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.jsonl.zstd'), 'fake')
    writeFileSync(join(root, 'ignore-me.jsonl'), 'nope')
    const listed = listOfficialSessions(root)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe('sess-abc')
    expect(listed[0]?.projectKey).toBe('--tmp-proj--')
    expect(listed[0]?.transcript.endsWith('session.jsonl.zstd')).toBe(true)
    expect(officialSessionRoot('/home/dev/.dsh')).toBe('/home/dev/.dsh/sessions')
  })

  it('formats transcript mtime without decoding events', () => {
    expect(formatOfficialSessionMtime(0)).toBe('—')
    expect(formatOfficialSessionMtime(Date.UTC(2026, 7, 16, 0, 31, 15))).toBe('2026-08-16 00:31:15 UTC')
  })

  it('recognizes the official session root expression', () => {
    expect(dumpUsesOfficialSessionRoot("root: !!js dshHomePath('sessions')")).toBe(true)
    expect(dumpUsesOfficialSessionRoot('root: /tmp/other')).toBe(false)
  })

  it('discovers session.v4.jsonl.zstd and extracts read-only title, preview, cwd, and model', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-v4-'))
    const dir = join(root, '--tmp-repo--', 'sess-v4-1')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl.zstd')
    const lines = [
      JSON.stringify({ id: 'sess-v4-1', meta: { cwd: '/tmp/repo' } }),
      JSON.stringify({ seq: 0, type: 'session/title', data: { title: 'V4 Zstd Summary' } }),
      JSON.stringify({ seq: 1, type: 'session.model', data: { provider: 'deepseek', model: 'deepseek-reasoner' } }),
      JSON.stringify({ seq: 2, type: 'turn/start', data: {} }),
      JSON.stringify({ seq: 3, type: 'user/message', data: { message: { content: 'Inspect release binary' } } }),
      JSON.stringify({ seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Binary verified clean.' }] } } }),
    ].join('\n') + '\n'
    writeFileSync(file, zstdCompressSync(Buffer.from(lines, 'utf8')))

    const listed = listOfficialSessions(root)
    expect(listed.map((s) => s.id)).toEqual(['sess-v4-1'])
    expect(listed[0]?.transcript).toBe(file)

    const summary = peekOfficialSessionSummary(file)
    expect(summary).toEqual({
      title: 'V4 Zstd Summary',
      cwd: '/tmp/repo',
      preview: 'Binary verified clean.',
      model: 'deepseek-reasoner',
      turnCount: 1,
    })

    const corrupt = join(dir, 'corrupt.jsonl.zstd')
    writeFileSync(corrupt, 'not-zstd')
    expect(peekOfficialSessionSummary(corrupt)).toBeUndefined()

    const bomb = join(dir, 'bomb.v4.jsonl.zstd')
    writeFileSync(bomb, zstdCompressSync(Buffer.alloc(33 * 1024 * 1024, 'a')))
    expect(peekOfficialSessionSummary(bomb)).toBeUndefined()

    const multiDir = join(root, '--tmp-multi--', 'sess-v4-multi')
    mkdirSync(multiDir, { recursive: true })
    const multiFile = join(multiDir, 'session.v4.jsonl.zstd')
    const frame1 = zstdCompressSync(
      Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 'sess-v4-multi', cwd: '/tmp/multi' }) + '\n', 'utf8'),
    )
    const frame2 = zstdCompressSync(
      Buffer.from(
        [
          JSON.stringify({ seq: 0, type: 'turn/start', data: {} }),
          JSON.stringify({ seq: 1, type: 'session/title', data: { title: 'Multi Frame Title' } }),
          JSON.stringify({ seq: 2, type: 'assistant/message', data: { message: { content: 'Multi frame reply!' } } }),
        ].join('\n') + '\n',
        'utf8',
      ),
    )
    writeFileSync(multiFile, Buffer.concat([frame1, frame2]))
    expect(peekOfficialSessionSummary(multiFile)).toEqual({
      title: 'Multi Frame Title',
      cwd: '/tmp/multi',
      preview: 'Multi frame reply!',
      turnCount: 1,
    })
  })
})
