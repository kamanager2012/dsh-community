import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listOfficialSessions } from '../src/session-store.ts'

const statRace = { failNext: false }

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: (path: Parameters<typeof actual.statSync>[0], options?: Parameters<typeof actual.statSync>[1]) => {
      if (statRace.failNext) {
        const error = new Error(`ENOENT: no such file or directory, stat '${String(path)}'`) as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
      return actual.statSync(path, options)
    },
  }
})

afterEach(() => {
  statRace.failNext = false
  vi.restoreAllMocks()
})

describe('official session listing races', () => {
  it('skips transcripts that vanish between existsSync and statSync', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sessions-race-'))
    const sessionDir = join(root, '--tmp-proj--', 'sess-abc')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.jsonl.zstd'), 'fake')
    writeFileSync(join(sessionDir, 'session.jsonl'), 'plain')

    statRace.failNext = true
    expect(listOfficialSessions(root)).toEqual([])
  })

  it('still lists sessions when no race happens in the same module graph', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sessions-race-'))
    const sessionDir = join(root, '--tmp-proj--', 'sess-abc')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.jsonl.zstd'), 'fake')

    const listed = listOfficialSessions(root)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe('sess-abc')
    expect(listed[0]?.mtimeMs).toBeGreaterThan(0)
  })
})
