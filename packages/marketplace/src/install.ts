/** Install a catalog plugin through the official `dsh plugin add` surface. */

import { spawnSync } from 'node:child_process'

export interface InstallPluginOptions {
  /** Official dsh bin.js path (resolveOfficialDsh from dsh-bridge). */
  dshBinPath: string
  /** Official profile the plugin is added to. */
  profile: string
  /** npm package name from the catalog. */
  packageName: string
  /** Optional exact version (`name@version`). */
  version?: string
  /** When false, don't run — only build the argv (tests). */
  dryRun?: boolean
}

export function installPluginArgv(options: InstallPluginOptions): string[] {
  const target = options.version === undefined ? options.packageName : `${options.packageName}@${options.version}`
  return ['plugin', '--profile', options.profile, 'add', target]
}

export interface InstallPluginResult {
  status: number | null
}

/** Run the official plugin install; stdio passthrough keeps dsh's own UX. */
export function installPlugin(options: InstallPluginOptions): InstallPluginResult {
  const argv = installPluginArgv(options)
  if (options.dryRun === true) return { status: 0 }
  const result = spawnSync(process.execPath, [options.dshBinPath, ...argv], { stdio: 'inherit', env: process.env })
  return { status: result.status }
}
