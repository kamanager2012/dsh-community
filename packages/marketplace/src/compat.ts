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

/** semver 语义比较:主版本按数值,release > 同版本号 prerelease(1.0.0 > 1.0.0-rc.1)。 */
export function compareVersions(a: string, b: string): number {
  const [aMain, aPre] = a.split('-', 2)
  const [bMain, bPre] = b.split('-', 2)
  const aParts = (aMain ?? '').split('.').map(Number)
  const bParts = (bMain ?? '').split('.').map(Number)
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0)
    if (diff !== 0) return diff
  }
  if (aPre === undefined && bPre !== undefined) return 1
  if (aPre !== undefined && bPre === undefined) return -1
  return (aPre ?? '').localeCompare(bPre ?? '')
}

export function classifyPlugin(plugin: PluginEntry, testedDshLine: string): ClassifiedPlugin {
  const sorted = [...plugin.versions].sort((a, b) => compareVersions(a.version, b.version))
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
