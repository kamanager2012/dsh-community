import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertPinnedVersion,
  OFFICIAL_DSH_BIN_NAME,
  OFFICIAL_DSH_BIN_REL,
  OFFICIAL_DSH_PACKAGE,
  PINNED_DSH_VERSION,
} from './pin.js'

export interface OfficialDshInstall {
  readonly packageName: typeof OFFICIAL_DSH_PACKAGE
  readonly packageDir: string
  readonly version: string
  readonly binPath: string
  readonly pinned: typeof PINNED_DSH_VERSION
}

export interface ResolveOfficialDshOptions {
  /** Import meta URL or absolute file path used as the require origin. */
  readonly from?: string
  readonly env?: NodeJS.ProcessEnv
  readonly assertPin?: boolean
}

interface OfficialManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly bin?: unknown
}

function originPath(from: string): string {
  if (from.startsWith('file:')) return fileURLToPath(from)
  return from
}

function readManifest(packageJsonPath: string): OfficialManifest {
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')) as OfficialManifest
}

function binFromManifest(packageDir: string, manifest: OfficialManifest): string {
  const bin = manifest.bin
  if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
    const mapped = (bin as Record<string, unknown>)[OFFICIAL_DSH_BIN_NAME]
    if (typeof mapped === 'string' && mapped.length > 0) return join(packageDir, mapped)
  }
  if (typeof bin === 'string' && bin.length > 0) return join(packageDir, bin)
  return join(packageDir, OFFICIAL_DSH_BIN_REL)
}

/**
 * Locate the published official CLI. Override with `DSH_COMMUNITY_BIN` when
 * a packaging step stages the same `lib/bin.js` outside node_modules.
 */
export function resolveOfficialDsh(options: ResolveOfficialDshOptions = {}): OfficialDshInstall {
  const env = options.env ?? process.env
  const override = env.DSH_COMMUNITY_BIN
  const from = options.from ?? import.meta.url
  const require = createRequire(originPath(from))

  const packageJsonPath = override === undefined
    ? require.resolve(`${OFFICIAL_DSH_PACKAGE}/package.json`)
    : join(dirname(override), '..', 'package.json')

  if (override !== undefined) {
    if (!existsSync(override)) {
      throw new Error(`DSH_COMMUNITY_BIN does not exist: ${override}`)
    }
    if (!existsSync(packageJsonPath)) {
      throw new Error(
        `staged ${OFFICIAL_DSH_PACKAGE} runtime is incomplete: no package.json at ${packageJsonPath}. `
          + 'Stage the official package.json next to lib/ so the runtime version can be verified against '
          + `the pin (${PINNED_DSH_VERSION}), or clear DSH_COMMUNITY_BIN to resolve from node_modules.`,
      )
    }
    const manifest = readManifest(packageJsonPath)
    const version = typeof manifest.version === 'string' ? manifest.version : 'unknown'
    if (options.assertPin !== false) assertPinnedVersion(version, env)
    return {
      packageName: OFFICIAL_DSH_PACKAGE,
      packageDir: dirname(packageJsonPath),
      version,
      binPath: override,
      pinned: PINNED_DSH_VERSION,
    }
  }

  const manifest = readManifest(packageJsonPath)
  if (manifest.name !== OFFICIAL_DSH_PACKAGE) {
    throw new Error(`resolved package.json is not ${OFFICIAL_DSH_PACKAGE}: ${String(manifest.name)}`)
  }
  const version = typeof manifest.version === 'string' ? manifest.version : 'unknown'
  if (options.assertPin !== false) assertPinnedVersion(version, env)
  const packageDir = dirname(packageJsonPath)
  const binPath = binFromManifest(packageDir, manifest)
  if (!existsSync(binPath)) {
    throw new Error(`official ${OFFICIAL_DSH_PACKAGE} bin is missing: ${binPath}`)
  }
  return {
    packageName: OFFICIAL_DSH_PACKAGE,
    packageDir,
    version,
    binPath,
    pinned: PINNED_DSH_VERSION,
  }
}
