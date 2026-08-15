import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetchCatalog } from '../src/client.js'
import { classifyPlugin, searchPlugins } from '../src/compat.js'
import { installPluginArgv } from '../src/install.js'

const sampleCatalog = {
  version: 1,
  updatedAt: 'x',
  plugins: [
    {
      name: 'plugin-a',
      description: 'Alpha 插件',
      author: 'a',
      repo: 'https://example.com/a',
      category: 'tool',
      versions: [{ version: '1.0.0', testedDsh: '0.1.0-rc.6' }],
    },
    {
      name: 'plugin-b',
      description: 'Beta 插件',
      author: 'b',
      repo: 'https://example.com/b',
      category: 'ui',
      versions: [
        { version: '0.9.0', testedDsh: '0.1.0-rc.6' },
        { version: '2.0.0', testedDsh: '0.1.0-rc.9' },
      ],
    },
  ],
}

describe('marketplace client and classification', () => {
  it('fetches and parses the catalog', async () => {
    const fetchImpl = async () => new Response(JSON.stringify(sampleCatalog), { status: 200 }) as unknown as Response
    const result = await fetchCatalog({ fetchImpl })
    expect(result.source).toBe('network')
    expect(result.catalog.plugins.length).toBe(2)
  })

  it('falls back to cache when the registry is unreachable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mkt-cache-'))
    try {
      const cachePath = join(dir, 'catalog.json')
      writeFileSync(cachePath, JSON.stringify(sampleCatalog))
      const fetchImpl = async () => { throw new Error('offline') }
      const result = await fetchCatalog({ fetchImpl, cachePath })
      expect(result.source).toBe('cache')
      expect(result.catalog.plugins[0]?.name).toBe('plugin-a')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('classifies latest versions against the tested rc line', () => {
    const a = classifyPlugin(sampleCatalog.plugins[0]!, '0.1.0-rc.6')
    expect(a.latest.status).toBe('tested')
    const b = classifyPlugin(sampleCatalog.plugins[1]!, '0.1.0-rc.6')
    expect(b.latest.status).toBe('untested')
    expect(b.hasTestedVersion).toBe(true)
  })

  it('searches by name and description', () => {
    const classified = sampleCatalog.plugins.map(plugin => classifyPlugin(plugin, '0.1.0-rc.6'))
    expect(searchPlugins(classified, 'beta').map(item => item.plugin.name)).toEqual(['plugin-b'])
    expect(searchPlugins(classified, '').length).toBe(2)
  })

  it('builds the official dsh plugin add argv', () => {
    expect(installPluginArgv({ dshBinPath: '/dsh/bin.js', profile: 'dsh-community-tui', packageName: 'plugin-a' }))
      .toEqual(['plugin', '--profile', 'dsh-community-tui', 'add', 'plugin-a'])
    expect(installPluginArgv({ dshBinPath: '/dsh/bin.js', profile: 'p', packageName: 'plugin-a', version: '1.0.0' }))
      .toEqual(['plugin', '--profile', 'p', 'add', 'plugin-a@1.0.0'])
  })
})
