import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { DSH_TESTED_VERSION } from '../src/cli.ts'
import { parseCatalog, type PluginCatalog } from '../src/catalog.ts'

const valid: PluginCatalog = {
  version: 1,
  updatedAt: '2026-08-15T00:00:00Z',
  plugins: [
    {
      name: '@dsh-community/tui',
      description: '社区版·终端',
      author: 'dsh-community',
      repo: 'https://github.com/kamanager2012/dsh-community',
      category: 'ui',
      versions: [{ version: '0.1.0', testedDsh: DSH_TESTED_VERSION, notes: 'ok' }],
    },
  ],
}

describe('catalog schema', () => {
  it('is immune to prototype pollution via catalog fields', () => {
    const hostile = JSON.parse(`{
      "version": 1,
      "updatedAt": "x",
      "__proto__": {"polluted": true},
      "plugins": [{
        "name": "plugin-a",
        "description": "A 插件",
        "author": "a",
        "repo": "https://example.com/a",
        "category": "tool",
        "__proto__": {"polluted": true},
        "versions": [{
          "version": "1.0.0",
          "testedDsh": ${JSON.stringify(DSH_TESTED_VERSION)},
          "__proto__": {"polluted": true}
        }]
      }]
    }`) as unknown
    const parsed = parseCatalog(hostile)
    assert.equal(parsed?.plugins[0]?.name, 'plugin-a')
    assert.equal((parsed as unknown as Record<string, unknown>)?.polluted, undefined)
    assert.equal((parsed?.plugins[0] as unknown as Record<string, unknown>)?.polluted, undefined)
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
  })

  it('accepts a well-formed catalog', () => {
    const catalog = parseCatalog(valid)
    assert.equal(catalog?.plugins[0]?.name, '@dsh-community/tui')
    assert.equal(catalog?.plugins[0]?.versions[0]?.notes, 'ok')
  })

  it('carries registry verification facts: integrity and provenance', () => {
    const withFacts = {
      ...valid,
      plugins: [{
        ...valid.plugins[0],
        versions: [{
          version: '0.1.0',
          testedDsh: DSH_TESTED_VERSION,
          integrity: 'sha512-abcdef',
          provenance: true,
        }],
      }],
    }
    const catalog = parseCatalog(withFacts)
    assert.equal(catalog?.plugins[0]?.versions[0]?.integrity, 'sha512-abcdef')
    assert.equal(catalog?.plugins[0]?.versions[0]?.provenance, true)
    const bare = parseCatalog(valid)
    assert.equal(bare?.plugins[0]?.versions[0]?.integrity, undefined)
    assert.equal(bare?.plugins[0]?.versions[0]?.provenance, undefined)
  })

  it('carries registry security metadata and rejects the risk/confirmation invariant', () => {
    const security = {
      risk: 'high' as const,
      requiresConfirmation: true,
      network: 'binds 0.0.0.0',
      dataEgress: 'LAN HTTP',
      credentials: 'none',
      filesystem: 'none extra',
      processExecution: 'none',
      persistence: 'none',
      manualReviewStatus: 'partial' as const,
      manualReviewNote: 'author README',
      lastReviewedAt: '2026-08-28',
    }
    const withSecurity = {
      ...valid,
      plugins: [{
        ...valid.plugins[0],
        versions: [{ version: '0.1.0', testedDsh: DSH_TESTED_VERSION, security }],
      }],
    }
    const catalog = parseCatalog(withSecurity)
    assert.equal(catalog?.plugins[0]?.versions[0]?.security?.risk, 'high')
    assert.equal(catalog?.plugins[0]?.versions[0]?.security?.requiresConfirmation, true)

    const broken = {
      ...withSecurity,
      plugins: [{
        ...valid.plugins[0],
        versions: [{
          version: '0.1.0',
          testedDsh: DSH_TESTED_VERSION,
          security: { ...security, requiresConfirmation: false },
        }],
      }],
    }
    assert.equal(parseCatalog(broken), undefined)
  })

  it('rejects duplicate plugin names', () => {
    const dup = { ...valid, plugins: [...valid.plugins, ...valid.plugins] }
    assert.equal(parseCatalog(dup), undefined)
  })

  it('rejects an untested rc line that is not 0.1.0-rc.N', () => {
    const bad = {
      version: 1 as const,
      updatedAt: 'x',
      plugins: [
        {
          name: 'x',
          description: 'x',
          author: 'x',
          repo: 'https://example.com/x',
          category: 'tool' as const,
          versions: [{ version: '1.0.0', testedDsh: '0.1.0' }],
        },
      ],
    }
    assert.equal(parseCatalog(bad), undefined)
  })

  it('rejects unknown categories', () => {
    const bad = {
      version: 1 as const,
      updatedAt: 'x',
      plugins: [
        {
          name: 'x',
          description: 'x',
          author: 'x',
          repo: 'https://example.com/x',
          category: 'game',
          versions: [{ version: '1.0.0', testedDsh: DSH_TESTED_VERSION }],
        },
      ],
    }
    assert.equal(parseCatalog(bad), undefined)
  })

  it('rejects empty versions', () => {
    const bad = {
      version: 1 as const,
      updatedAt: 'x',
      plugins: [
        {
          name: 'x',
          description: 'x',
          author: 'x',
          repo: 'https://example.com/x',
          category: 'tool' as const,
          versions: [],
        },
      ],
    }
    assert.equal(parseCatalog(bad), undefined)
  })
})
