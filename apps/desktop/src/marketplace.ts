/**
 * Community marketplace catalog for the Desktop shell.
 *
 * The schema is owned by the registry repo (dsh-community-plugins/catalog.json).
 * This module only mirrors the read side: strict parse, snapshot for the
 * userData cache, and the source URL. Browsing is read-only; installs stay
 * in the official CLI / dsh-marketplace client.
 */

export const MARKETPLACE_CATALOG_URL =
  'https://raw.githubusercontent.com/kamanager2012/dsh-community-plugins/main/catalog.json'

export const MARKETPLACE_REGISTRY_URL = 'https://github.com/kamanager2012/dsh-community-plugins'

export const PLUGIN_CATEGORIES = ['ui', 'tool', 'provider', 'workflow', 'other'] as const
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number]

export const PLUGIN_CATEGORY_LABELS: Record<PluginCategory, string> = {
  ui: '界面',
  tool: '工具',
  provider: '模型',
  workflow: '工作流',
  other: '其它',
}

export interface MarketplacePluginVersion {
  readonly version: string
  readonly testedDsh: string
  readonly notes?: string
}

export interface MarketplacePlugin {
  readonly name: string
  readonly description: string
  readonly author: string
  readonly repo: string
  readonly category: PluginCategory
  readonly versions: readonly MarketplacePluginVersion[]
}

export interface MarketplaceCatalog {
  readonly version: 1
  readonly updatedAt: string
  readonly plugins: readonly MarketplacePlugin[]
}

const DSH_RC_LINE = /^0\.1\.0-rc\.\d+$/u

export function parseMarketplaceCatalog(raw: unknown): MarketplaceCatalog | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (value.version !== 1) return undefined
  if (!Array.isArray(value.plugins)) return undefined
  const plugins: MarketplacePlugin[] = []
  const names = new Set<string>()
  for (const item of value.plugins) {
    if (item === null || typeof item !== 'object') return undefined
    const plugin = item as Record<string, unknown>
    const { name, description, author, repo, category } = plugin
    if (
      typeof name !== 'string' || name === '' || names.has(name)
      || typeof description !== 'string' || description === ''
      || typeof author !== 'string' || author === ''
      || typeof repo !== 'string' || repo === ''
      || typeof category !== 'string' || !PLUGIN_CATEGORIES.includes(category as PluginCategory)
    ) return undefined
    names.add(name)
    if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) return undefined
    const versions: MarketplacePluginVersion[] = []
    for (const versionItem of plugin.versions) {
      if (versionItem === null || typeof versionItem !== 'object') return undefined
      const version = versionItem as Record<string, unknown>
      if (typeof version.version !== 'string' || version.version === '') return undefined
      if (typeof version.testedDsh !== 'string' || !DSH_RC_LINE.test(version.testedDsh)) return undefined
      const entry: MarketplacePluginVersion = {
        version: version.version,
        testedDsh: version.testedDsh,
        ...(typeof version.notes === 'string' && version.notes !== '' ? { notes: version.notes } : {}),
      }
      versions.push(entry)
    }
    plugins.push({
      name,
      description,
      author,
      repo,
      category: category as PluginCategory,
      versions,
    })
  }
  return { version: 1, updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '', plugins }
}

export type MarketplaceSource = 'live' | 'cache' | 'none'

export interface MarketplaceSnapshot {
  readonly catalog?: MarketplaceCatalog
  readonly source: MarketplaceSource
  readonly fetchedAt: string
  readonly error?: string
}

export function marketplaceSnapshot(input: {
  readonly catalog?: MarketplaceCatalog
  readonly source: MarketplaceSource
  readonly fetchedAt: string
  readonly error?: string
}): MarketplaceSnapshot {
  return {
    source: input.source,
    fetchedAt: input.fetchedAt,
    ...(input.catalog === undefined ? {} : { catalog: input.catalog }),
    ...(input.error === undefined || input.error === '' ? {} : { error: input.error }),
  }
}

/** Read a snapshot previously persisted in Electron userData. */
export function parseMarketplaceSnapshot(raw: unknown): MarketplaceSnapshot | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (
    typeof value.source !== 'string'
    || !['live', 'cache', 'none'].includes(value.source)
    || typeof value.fetchedAt !== 'string'
  ) return undefined
  const catalog = parseMarketplaceCatalog(value.catalog)
  if (catalog === undefined) return undefined
  return marketplaceSnapshot({
    ...(catalog === undefined ? {} : { catalog }),
    source: value.source as MarketplaceSource,
    fetchedAt: value.fetchedAt,
    ...(typeof value.error === 'string' && value.error !== '' ? { error: value.error } : {}),
  })
}
