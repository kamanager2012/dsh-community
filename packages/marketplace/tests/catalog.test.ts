import { describe, expect, it } from 'vitest'
import { parseCatalog } from '../src/catalog.js'

const valid = {
  version: 1,
  updatedAt: '2026-08-15T00:00:00Z',
  plugins: [
    {
      name: '@dsh-community/tui',
      description: '社区版·终端',
      author: 'dsh-community',
      repo: 'https://github.com/kamanager2012/dsh-community',
      category: 'ui',
      versions: [{ version: '0.1.0', testedDsh: '0.1.0-rc.6', notes: 'ok' }],
    },
  ],
}

describe('catalog schema', () => {
  it('accepts a well-formed catalog', () => {
    const catalog = parseCatalog(valid)
    expect(catalog?.plugins[0]?.name).toBe('@dsh-community/tui')
    expect(catalog?.plugins[0]?.versions[0]?.notes).toBe('ok')
  })

  it('rejects duplicate plugin names', () => {
    const dup = { ...valid, plugins: [...valid.plugins, ...valid.plugins] }
    expect(parseCatalog(dup)).toBeUndefined()
  })

  it('rejects an untested rc line that is not 0.1.0-rc.N', () => {
    const bad = structuredClone(valid)
    bad.plugins[0].versions[0].testedDsh = '0.1.0'
    expect(parseCatalog(bad)).toBeUndefined()
  })

  it('rejects unknown categories', () => {
    const bad = structuredClone(valid)
    bad.plugins[0].category = 'game'
    expect(parseCatalog(bad)).toBeUndefined()
  })

  it('rejects empty versions', () => {
    const bad = structuredClone(valid)
    bad.plugins[0].versions = []
    expect(parseCatalog(bad)).toBeUndefined()
  })
})
