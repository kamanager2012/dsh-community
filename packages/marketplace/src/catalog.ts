/** Catalog schema for the DSH 社区市场 registry (dsh-community-plugins). */

export const PLUGIN_CATEGORIES = ['ui', 'tool', 'provider', 'workflow', 'other'] as const
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number]

export interface PluginVersion {
  /** The npm version string of the plugin. */
  version: string
  /** The official DSH rc line this version was tested against (0.1.0-rc.N). */
  testedDsh: string
  notes?: string
}

export interface PluginEntry {
  /** npm package name — must be installable via `dsh plugin add <name>`. */
  name: string
  description: string
  author: string
  repo: string
  category: PluginCategory
  versions: PluginVersion[]
}

export interface PluginCatalog {
  version: 1
  updatedAt: string
  plugins: PluginEntry[]
}

const DSH_RC_LINE = /^0\.1\.0-rc\.\d+$/u

export function parseCatalog(raw: unknown): PluginCatalog | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (value.version !== 1) return undefined
  if (!Array.isArray(value.plugins)) return undefined
  const plugins: PluginEntry[] = []
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
    const versions: PluginVersion[] = []
    for (const versionItem of plugin.versions) {
      if (versionItem === null || typeof versionItem !== 'object') return undefined
      const version = versionItem as Record<string, unknown>
      if (typeof version.version !== 'string' || version.version === '') return undefined
      if (typeof version.testedDsh !== 'string' || !DSH_RC_LINE.test(version.testedDsh)) return undefined
      const entry: PluginVersion = { version: version.version, testedDsh: version.testedDsh }
      if (typeof version.notes === 'string' && version.notes !== '') entry.notes = version.notes
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
