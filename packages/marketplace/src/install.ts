/** Install a catalog plugin through the official `dsh plugin add` surface. */

import { spawnSync } from 'node:child_process'

export interface InstallPluginOptions {
  /** Official profile the plugin is added to (default: community-tui). */
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
  const result = spawnSync('dsh', argv, { stdio: 'inherit', env: process.env })
  if (result.error !== undefined) {
    const hint = (result.error as NodeJS.ErrnoException).code === 'ENOENT'
      ? '\n官方 dsh CLI 不在 PATH 里。先装一次:npm i -g @deepseek-ai/dsh(或 npx @deepseek-ai/dsh --help)'
      : `\n${result.error.message}`
    process.stderr.write(`dsh-marketplace: 无法启动官方 dsh:${hint}\n`)
    return { status: 1 }
  }
  return { status: result.status }
}
