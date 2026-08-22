/** Read-only pointer at the community registry. Not a second installer. */
export const COMMUNITY_PLUGIN_CATALOG_URL =
  'https://raw.githubusercontent.com/kamanager2012/dsh-community-plugins/main/catalog.json'

export const COMMUNITY_PLUGIN_CATALOG_REPO =
  'https://github.com/kamanager2012/dsh-community-plugins'

export const HANDBOOK_REPO = 'https://github.com/kamanager2012/deepseek-harness-handbook'

export interface CatalogPlugin {
  readonly name: string
  readonly description: string
  readonly author: string
  readonly repo: string
  readonly category: string
  readonly version: string
  readonly testedDsh: string
}

export interface PluginCatalog {
  readonly updatedAt: string
  readonly plugins: readonly CatalogPlugin[]
}

const CATALOG_NAME_RE = /^[A-Za-z0-9@/._-]+$/

function isDisplaySafePluginName(name: string): boolean {
  return name.length > 0 && !name.startsWith('-') && CATALOG_NAME_RE.test(name)
}

export function officialPluginAddCommand(name: string): string {
  if (!isDisplaySafePluginName(name)) {
    throw new Error(`dsh plugin add needs a safe package name, got: ${JSON.stringify(name.slice(0, 64))}`)
  }
  return `dsh plugin add ${name}`
}

export function parsePluginCatalog(raw: unknown): PluginCatalog {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('plugin catalog is not an object')
  }
  const value = raw as { updatedAt?: unknown; plugins?: unknown }
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : ''
  if (!Array.isArray(value.plugins)) throw new Error('plugin catalog has no plugins array')
  const plugins: CatalogPlugin[] = []
  for (const item of value.plugins) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    if (typeof row.name !== 'string' || !isDisplaySafePluginName(row.name)) continue
    const versions = Array.isArray(row.versions) ? row.versions : []
    const latest = versions[0] as Record<string, unknown> | undefined
    plugins.push({
      name: row.name,
      description: typeof row.description === 'string' ? row.description : '',
      author: typeof row.author === 'string' ? row.author : '',
      repo: typeof row.repo === 'string' ? row.repo : '',
      category: typeof row.category === 'string' ? row.category : '',
      version: typeof latest?.version === 'string' ? latest.version : '',
      testedDsh: typeof latest?.testedDsh === 'string' ? latest.testedDsh : '',
    })
  }
  return { updatedAt, plugins }
}

export function formatPluginCatalog(catalog: PluginCatalog, source: string): string {
  const lines = [
    `社区插件目录（只读，来自 ${source}）`,
    '安装走官方：dsh plugin add <name>。本仓不做第二套安装器。',
    '',
  ]
  if (catalog.plugins.length === 0) {
    lines.push('目录是空的。')
    lines.push('')
    return lines.join('\n')
  }
  for (const plugin of catalog.plugins) {
    const tested = plugin.testedDsh === '' ? '' : `  tested ${plugin.testedDsh}`
    lines.push(`  ${plugin.name}  ${plugin.version}${tested}`)
    if (plugin.description !== '') lines.push(`    ${plugin.description}`)
    lines.push(`    ${officialPluginAddCommand(plugin.name)}`)
    lines.push('')
  }
  return lines.join('\n')
}

export async function fetchPluginCatalog(
  url = COMMUNITY_PLUGIN_CATALOG_URL,
  timeoutMs = 8_000,
): Promise<PluginCatalog> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) {
    throw new Error(`plugin catalog HTTP ${String(response.status)}`)
  }
  return parsePluginCatalog(await response.json())
}
