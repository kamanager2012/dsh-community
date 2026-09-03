/** Catalog schema for the DSH community marketplace registry. */

export const PLUGIN_CATEGORIES = ['ui', 'tool', 'provider', 'workflow', 'other'] as const
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number]

export const RISK_LEVELS = ['low', 'medium', 'high'] as const
export type PluginRisk = (typeof RISK_LEVELS)[number]
export const MANUAL_REVIEW_STATUSES = ['unreviewed', 'partial', 'reviewed'] as const
export type ManualReviewStatus = (typeof MANUAL_REVIEW_STATUSES)[number]

const ISO_DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u
const SECURITY_TEXT_FIELDS = [
  'network',
  'dataEgress',
  'credentials',
  'filesystem',
  'processExecution',
  'persistence',
  'manualReviewNote',
] as const

/** Per-version security disclosure from the in-repo plugin catalog. */
export interface PluginSecurity {
  risk: PluginRisk
  requiresConfirmation: boolean
  network: string
  dataEgress: string
  credentials: string
  filesystem: string
  processExecution: string
  persistence: string
  manualReviewStatus: ManualReviewStatus
  manualReviewNote: string
  lastReviewedAt: string
}

export interface PluginVersion {
  /** The npm version string of the plugin. */
  version: string
  /** The official DSH rc line this version was tested against (0.1.x-rc.N). */
  testedDsh: string
  notes?: string
  /** npm dist.integrity (sha512) recorded by the registry verification. */
  integrity?: string
  /** npm provenance attestation present at verification time. */
  provenance?: boolean
  security?: PluginSecurity
}

export function needsInstallConfirmation(security: PluginSecurity | undefined): boolean {
  if (security === undefined) return false
  return security.requiresConfirmation === true || security.risk !== 'low'
}

function parseSecurity(raw: unknown): PluginSecurity | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  for (const field of SECURITY_TEXT_FIELDS) {
    if (typeof value[field] !== 'string' || value[field].trim() === '') return undefined
  }
  if (!RISK_LEVELS.includes(value.risk as PluginRisk)) return undefined
  if (typeof value.requiresConfirmation !== 'boolean') return undefined
  if (value.risk !== 'low' && value.requiresConfirmation !== true) return undefined
  if (!MANUAL_REVIEW_STATUSES.includes(value.manualReviewStatus as ManualReviewStatus)) return undefined
  if (typeof value.lastReviewedAt !== 'string' || !ISO_DATE_RE.test(value.lastReviewedAt)) return undefined
  return {
    risk: value.risk as PluginRisk,
    requiresConfirmation: value.requiresConfirmation,
    network: value.network as string,
    dataEgress: value.dataEgress as string,
    credentials: value.credentials as string,
    filesystem: value.filesystem as string,
    processExecution: value.processExecution as string,
    persistence: value.persistence as string,
    manualReviewStatus: value.manualReviewStatus as ManualReviewStatus,
    manualReviewNote: value.manualReviewNote as string,
    lastReviewedAt: value.lastReviewedAt,
  }
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

const DSH_RC_LINE = /^0\.1\.\d+-rc\.\d+$/u

/** Only https: repositories are accepted into the catalog (rejects javascript:, data:, http:, etc.). */
export function isValidPluginRepoUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && url.hostname.trim() !== ''
  } catch {
    return false
  }
}

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
      || typeof repo !== 'string' || !isValidPluginRepoUrl(repo)
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
      if (typeof version.integrity === 'string' && version.integrity !== '') entry.integrity = version.integrity
      if (version.provenance === true) entry.provenance = true
      if (version.security !== undefined) {
        const security = parseSecurity(version.security)
        if (security === undefined) return undefined
        entry.security = security
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
