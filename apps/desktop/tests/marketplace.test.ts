import { describe, expect, it } from 'vitest'
import {
  parseInstalledPluginNames,
  parseMarketplaceCatalog,
  parseMarketplaceSnapshot,
  parsePluginActionRequest,
  pluginActionArgv,
} from '../src/marketplace.ts'
import { renderMarketplacePage } from '../src/pages.ts'

const VALID_CATALOG = {
  version: 1,
  updatedAt: '2026-08-16T00:00:00Z',
  plugins: [
    {
      name: 'dsh-plugin-hello',
      description: 'A minimal community plugin that adds a callable hello tool',
      author: 'jerrys888',
      repo: 'https://github.com/xu1132/dsh-plugin-hello',
      category: 'tool',
      versions: [
        { version: '0.1.0', testedDsh: '0.1.1-rc.1', notes: '安装 + 合成验证通过' },
      ],
    },
    {
      name: 'dsh-voice',
      description: 'Voice input (speech-to-text) and read-aloud for the composer',
      author: 'STARDUSTLC666',
      repo: 'https://github.com/STARDUSTLC666/dsh-voice',
      category: 'ui',
      versions: [
        { version: '0.1.0', testedDsh: '0.1.1-rc.1' },
      ],
    },
  ],
}

function marketplacePageModel(overrides: Record<string, unknown> = {}) {
  return {
    product: 'DSH Community',
    catalog: parseMarketplaceCatalog(VALID_CATALOG),
    source: 'live' as const,
    fetchedAt: '2026-08-16T01:00:00.000Z',
    registryUrl: 'https://github.com/kamanager2012/dsh-community/blob/main/packages/marketplace/catalog.json',
    installed: ['dsh-voice'],
    profile: 'web',
    ...overrides,
  }
}

describe('marketplace catalog parse', () => {
  it('accepts a valid registry catalog', () => {
    const catalog = parseMarketplaceCatalog(VALID_CATALOG)
    expect(catalog).toBeDefined()
    expect(catalog?.plugins).toHaveLength(2)
    expect(catalog?.plugins[0]?.name).toBe('dsh-plugin-hello')
    expect(catalog?.plugins[0]?.versions[0]?.notes).toBe('安装 + 合成验证通过')
  })

  it('rejects catalogs that are not version 1', () => {
    expect(parseMarketplaceCatalog({ ...VALID_CATALOG, version: 2 })).toBeUndefined()
    expect(parseMarketplaceCatalog({ ...VALID_CATALOG, version: '1' })).toBeUndefined()
  })

  it('rejects duplicate plugin names', () => {
    const dup = {
      ...VALID_CATALOG,
      plugins: [VALID_CATALOG.plugins[0], VALID_CATALOG.plugins[0]],
    }
    expect(parseMarketplaceCatalog(dup)).toBeUndefined()
  })

  it('rejects unknown categories and missing fields', () => {
    const badCategory = {
      ...VALID_CATALOG,
      plugins: [{ ...VALID_CATALOG.plugins[0], category: 'theme' }],
    }
    expect(parseMarketplaceCatalog(badCategory)).toBeUndefined()
    const missingRepo = {
      ...VALID_CATALOG,
      plugins: [{ ...VALID_CATALOG.plugins[0], repo: '' }],
    }
    expect(parseMarketplaceCatalog(missingRepo)).toBeUndefined()

    for (const hostileRepo of ['javascript:alert(1)', 'data:text/html,bad', 'http://insecure.org', 'not-a-url']) {
      const badRepo = {
        ...VALID_CATALOG,
        plugins: [{ ...VALID_CATALOG.plugins[0], repo: hostileRepo }],
      }
      expect(parseMarketplaceCatalog(badRepo)).toBeUndefined()
    }
  })

  it('accepts every official rc line family, old and current', () => {
    // The live registry (catalog.json) currently ships 0.1.1-rc.1 across all
    // plugins; older snapshots carry 0.1.0-rc.6. Both must parse — a frozen
    // allowlist turned the whole marketplace page permanently unavailable.
    const parseWith = (testedDsh: string) => parseMarketplaceCatalog({
      ...VALID_CATALOG,
      plugins: [{
        ...VALID_CATALOG.plugins[0]!,
        versions: [{ version: '0.1.0', testedDsh }],
      }],
    })
    expect(parseWith('0.1.0-rc.6')?.plugins[0]?.versions[0]?.testedDsh).toBe('0.1.0-rc.6')
    expect(parseWith('0.1.1-rc.1')?.plugins[0]?.versions[0]?.testedDsh).toBe('0.1.1-rc.1')
  })

  it('rejects versions without an official rc tested line', () => {
    const noTested = {
      ...VALID_CATALOG,
      plugins: [{
        ...VALID_CATALOG.plugins[0],
        versions: [{ version: '0.1.0' }],
      }],
    }
    expect(parseMarketplaceCatalog(noTested)).toBeUndefined()
    const looseLine = {
      ...VALID_CATALOG,
      plugins: [{
        ...VALID_CATALOG.plugins[0],
        versions: [{ version: '0.1.0', testedDsh: '0.1.0' }],
      }],
    }
    expect(parseMarketplaceCatalog(looseLine)).toBeUndefined()
  })

  it('rejects junk input', () => {
    expect(parseMarketplaceCatalog(null)).toBeUndefined()
    expect(parseMarketplaceCatalog('catalog')).toBeUndefined()
    expect(parseMarketplaceCatalog({ version: 1 })).toBeUndefined()
  })
})

describe('marketplace snapshot cache', () => {
  it('round-trips a persisted snapshot', () => {
    const snapshot = {
      version: 1,
      updatedAt: '2026-08-16T00:00:00Z',
      plugins: VALID_CATALOG.plugins,
      source: 'live',
      fetchedAt: '2026-08-16T01:00:00.000Z',
      catalog: VALID_CATALOG,
    }
    expect(parseMarketplaceSnapshot(snapshot)).toBeDefined()
    expect(parseMarketplaceSnapshot({ ...snapshot, source: 'cache' })?.source).toBe('cache')
    expect(parseMarketplaceSnapshot({ source: 'live', fetchedAt: 'x' })).toBeUndefined()
    expect(parseMarketplaceSnapshot(null)).toBeUndefined()
  })
})

describe('installed plugins in the official profile', () => {
  it('reads dependency keys as installed names', () => {
    expect(parseInstalledPluginNames({
      name: 'test',
      dependencies: {
        'dsh-plugin-hello': '^0.1.0',
        'dsh-voice': '^0.1.0',
      },
    })).toEqual(['dsh-plugin-hello', 'dsh-voice'])
    expect(parseInstalledPluginNames({ name: 'no-deps' })).toEqual([])
    expect(parseInstalledPluginNames(null)).toEqual([])
    expect(parseInstalledPluginNames('junk')).toEqual([])
  })

  it('validates renderer plugin action requests', () => {
    expect(parsePluginActionRequest({ name: 'dsh-voice', action: 'install' })).toEqual({
      name: 'dsh-voice',
      action: 'install',
    })
    expect(parsePluginActionRequest({ name: 'dsh-voice', action: 'remove' })).toEqual({
      name: 'dsh-voice',
      action: 'remove',
    })
    expect(parsePluginActionRequest({ name: '', action: 'install' })).toBeUndefined()
    expect(parsePluginActionRequest({ name: 'x', action: 'rm -rf' })).toBeUndefined()
    expect(parsePluginActionRequest('install')).toBeUndefined()
  })

  it('spells official dsh plugin argv, not a homegrown installer', () => {
    expect(pluginActionArgv({ profile: 'web', action: 'install', name: 'dsh-voice' })).toEqual([
      'plugin', '--profile', 'web', 'add', 'dsh-voice',
    ])
    expect(pluginActionArgv({ profile: 'web', action: 'remove', name: 'dsh-voice' })).toEqual([
      'plugin', '--profile', 'web', 'remove', 'dsh-voice',
    ])
  })
})

describe('marketplace page', () => {
  it('renders plugin cards grouped by category', () => {
    const html = renderMarketplacePage(marketplacePageModel())
    expect(html).toMatch(/社区市场/)
    expect(html).toMatch(/dsh-plugin-hello/)
    expect(html).toMatch(/dsh-voice/)
    expect(html).toMatch(/验证线 0\.1\.1-rc\.1/)
    expect(html).toMatch(/安装 \+ 合成验证通过/)
    expect(html).toMatch(/dsh plugin add dsh-plugin-hello/)
    expect(html).toMatch(/工具 · 1/)
    expect(html).toMatch(/界面 · 1/)
    expect(html).toMatch(/refreshMarketplace/)
    expect(html).toMatch(/openOfficial/)
    expect(html).not.toMatch(/工作流 · /)
    expect(html).not.toMatch(/模型 · /)
  })

  it('links the registry repo and plugin sources externally', () => {
    const html = renderMarketplacePage(marketplacePageModel())
    expect(html).toMatch(/github\.com\/kamanager2012\/dsh-community\/blob\/main\/packages\/marketplace\/catalog\.json/)
    expect(html).toMatch(/href="https:\/\/github\.com\/xu1132\/dsh-plugin-hello"/)
  })

  it('shows a cache fallback banner with the error', () => {
    const html = renderMarketplacePage(marketplacePageModel({
      source: 'cache',
      error: '在线抓取失败，展示最近一次缓存。',
    }))
    expect(html).toMatch(/缓存目录/)
    expect(html).toMatch(/在线抓取失败/)
  })

  it('shows an empty state when the catalog is unavailable', () => {
    const html = renderMarketplacePage(marketplacePageModel({
      catalog: undefined,
      source: 'none',
      fetchedAt: '',
      error: '无法抓取目录',
    }))
    expect(html).toMatch(/目录还没有内容/)
    expect(html).toMatch(/无法抓取目录/)
    expect(html).toMatch(/目录不可用/)
  })

  it('shows installed state and official plugin action buttons', () => {
    const html = renderMarketplacePage(marketplacePageModel())
    expect(html).toMatch(/已装/)
    expect(html).toMatch(/data-plugin-action="remove"/)
    expect(html).toMatch(/data-plugin-action="install"/)
    expect(html).toMatch(/pluginAction/)
    expect(html).toMatch(/dsh plugin --profile web add\|remove/)
    expect(html).toMatch(/已装 1 个（web profile）/)
  })

  it('disables actions while a plugin task is busy', () => {
    const html = renderMarketplacePage(marketplacePageModel({
      busy: { plugin: 'dsh-plugin-hello', action: 'install' },
    }))
    expect(html).toMatch(/正在安装 dsh-plugin-hello/)
    expect(html).toMatch(/disabled/)
  })

  it('shows a success result with a restart hint, and failure logs', () => {
    const ok = renderMarketplacePage(marketplacePageModel({
      result: { plugin: 'dsh-plugin-hello', action: 'install', ok: true, log: '' },
    }))
    expect(ok).toMatch(/安装完成/)
    expect(ok).toMatch(/重启官方运行时后生效/)
    expect(ok).toMatch(/restartHost/)
    const failed = renderMarketplacePage(marketplacePageModel({
      result: { plugin: 'dsh-plugin-hello', action: 'remove', ok: false, log: 'pnpm failed' },
    }))
    expect(failed).toMatch(/卸载失败/)
    expect(failed).toMatch(/pnpm failed/)
  })

  it('escapes plugin metadata instead of trusting the registry', () => {
    const html = renderMarketplacePage(marketplacePageModel({
      catalog: {
        version: 1,
        updatedAt: '',
        plugins: [{
          name: '<img src=x onerror=alert(1)>',
          description: '<script>bad()</script>',
          author: 'a&b',
          repo: 'https://example.com/" onmouseover="x',
          category: 'tool',
          versions: [{ version: '<b>', testedDsh: '0.1.1-rc.1' }],
        }],
      },
    }))
    expect(html).not.toMatch(/<img src=x/)
    expect(html).not.toMatch(/<script>bad/)
    expect(html).toMatch(/&lt;img src=x/)
    expect(html).toMatch(/a&amp;b/)
  })
})
