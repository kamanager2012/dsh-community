import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readJsonFile, writeJsonFile } from '../src/json-file.ts'

describe('json-file atomic persistence', () => {
  it('writes JSON atomically with owner-only permissions and leaves no temp files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-json-test-'))
    try {
      const target = join(dir, 'nested', 'state.json')
      writeJsonFile(target, { a: 1, b: 'two' })
      expect(readJsonFile(target)).toEqual({ a: 1, b: 'two' })
      writeJsonFile(target, { a: 2, b: 'three' })
      expect(readJsonFile(target)).toEqual({ a: 2, b: 'three' })

      const entries = readdirSync(join(dir, 'nested'))
      expect(entries).toEqual(['state.json'])
      if (process.platform !== 'win32') {
        const mode = statSync(target).mode & 0o777
        expect(mode).toBe(0o600)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
