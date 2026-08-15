import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  dumpUsesOfficialSessionRoot,
  listOfficialSessions,
  officialSessionRoot,
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

  it('recognizes the official session root expression', () => {
    expect(dumpUsesOfficialSessionRoot("root: !!js dshHomePath('sessions')")).toBe(true)
    expect(dumpUsesOfficialSessionRoot('root: /tmp/other')).toBe(false)
  })
})
