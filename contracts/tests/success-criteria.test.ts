import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

describe('six reconstruction success criteria are written down', () => {
  it('README and architecture state the six bars', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    const arch = readFileSync(join(root, 'ARCHITECTURE.md'), 'utf8')
    for (const text of [readme, arch]) {
      expect(text).toMatch(/官方源代码 vendor = 0|Official Source Ownership = 0/)
      expect(text).toMatch(/patch-surface|Patch Surface|官方 Cordis row/i)
      expect(text).toMatch(/不实现 Agent loop|do not implement[\s*]+Agent loop/i)
      expect(text).toMatch(/同一 Session|same session/i)
      expect(text).toMatch(/contract CI|契约/)
    }
  })
})
