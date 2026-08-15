/** Registry client: fetch + parse the community catalog, with local cache fallback. */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseCatalog, type PluginCatalog } from './catalog.js'

export const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/kamanager2012/dsh-community-plugins/main/catalog.json'

export interface FetchCatalogOptions {
  /** Catalog URL; defaults to the dsh-community-plugins registry. */
  url?: string
  /** fetch implementation (injectable for tests). */
  fetchImpl?: typeof fetch
  /** Optional local cache file for offline fallback. */
  cachePath?: string
}

export interface FetchCatalogResult {
  catalog: PluginCatalog
  source: 'network' | 'cache'
}

export async function fetchCatalog(options: FetchCatalogOptions = {}): Promise<FetchCatalogResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const url = options.url ?? DEFAULT_REGISTRY_URL
  try {
    const response = await fetchImpl(url)
    if (!response.ok) throw new Error(`registry HTTP ${response.status}`)
    const catalog = parseCatalog(await response.json())
    if (catalog === undefined) throw new Error('registry catalog failed schema validation')
    if (options.cachePath !== undefined) {
      mkdirSync(dirname(options.cachePath), { recursive: true })
      writeFileSync(options.cachePath, JSON.stringify(catalog, null, 2))
    }
    return { catalog, source: 'network' }
  } catch (error) {
    if (options.cachePath !== undefined) {
      try {
        const cached = parseCatalog(JSON.parse(readFileSync(options.cachePath, 'utf8')))
        if (cached !== undefined) {
          console.warn(`[marketplace] registry unreachable (${error instanceof Error ? error.message : String(error)}), using cache`)
          return { catalog: cached, source: 'cache' }
        }
      } catch {
        // fall through to the throw below
      }
    }
    throw error
  }
}

/** Default cache location (~/.cache/dsh-community/marketplace-catalog.json). */
export function defaultCachePath(homeDir: string): string {
  return join(homeDir, '.cache', 'dsh-community', 'marketplace-catalog.json')
}
