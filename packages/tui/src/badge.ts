import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMUNITY_PRODUCT_LABEL = 'DeepSeek Harness Community'
const COMMUNITY_SUFFIX = /-community\.(?:0|[1-9]\d*)$/u
const require = createRequire(import.meta.url)

function communityVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const pkg = require(join(here, '..', 'package.json')) as { version?: unknown }
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
}

/**
 * Same Dual-Badge grammar as `@dsh-community/dsh-bridge`.
 * Keep this file free of workspace:* deps so official profile installs stay isolated.
 */
export function formatDualBadge(): string {
  const suiteVersion = communityVersion()
  let officialPackage = '@deepseek-ai/dsh'
  let officialVersion = suiteVersion.replace(COMMUNITY_SUFFIX, '')
  try {
    const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
    const manifest = require(manifestPath) as { name?: string; version?: string }
    if (typeof manifest.name === 'string') officialPackage = manifest.name
    if (typeof manifest.version === 'string') officialVersion = manifest.version
  } catch {
    // official host tree not linked yet during profile install probes
  }
  return `${COMMUNITY_PRODUCT_LABEL} v${suiteVersion} [Official Core: ${officialPackage}@${officialVersion}]`
}
