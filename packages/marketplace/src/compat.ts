/**
 * Compatibility classification against the contract-validated upstream line.
 * "latest tested, not latest": a plugin version is only marked 已验证 when
 * its testedDsh matches the community contract's validated rc line.
 */
import type { PluginEntry, PluginVersion } from './catalog.js'

export type VersionStatus = 'tested' | 'untested'

export interface ClassifiedVersion {
  entry: PluginVersion
  status: VersionStatus
}

export function classifyVersion(version: PluginVersion, testedDshLine: string): VersionStatus {
  return version.testedDsh === testedDshLine ? 'tested' : 'untested'
}

export interface ClassifiedPlugin {
  plugin: PluginEntry
  /** Latest version declared in the catalog. */
  latest: ClassifiedVersion
  /** True when at least one version is contract-tested. */
  hasTestedVersion: boolean
}

export function classifyPlugin(plugin: PluginEntry, testedDshLine: string): ClassifiedPlugin {
  const sorted = [...plugin.versions].sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }))
  const latestEntry = sorted[sorted.length - 1]
  if (latestEntry === undefined) throw new Error(`plugin ${plugin.name} has no versions`)
  return {
    plugin,
    latest: { entry: latestEntry, status: classifyVersion(latestEntry, testedDshLine) },
    hasTestedVersion: plugin.versions.some(version => classifyVersion(version, testedDshLine) === 'tested'),
  }
}

export function searchPlugins(plugins: ClassifiedPlugin[], query: string): ClassifiedPlugin[] {
  const q = query.trim().toLowerCase()
  if (q === '') return plugins
  return plugins.filter(item =>
    item.plugin.name.toLowerCase().includes(q)
    || item.plugin.description.toLowerCase().includes(q),
  )
}
