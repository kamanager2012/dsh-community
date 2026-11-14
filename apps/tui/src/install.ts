import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Returns non-interactive env vars so `pnpm install` never prompts or prints update banners inside TUI PTYs. */
export function profileInstallEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    CI: 'true',
    npm_config_update_notifier: 'false',
    pnpm_config_update_notifier: 'false',
  }
}

export function profileNeedsInstall(dir: string): boolean {
  return !existsSync(join(dir, 'node_modules', '@dsh-community', 'tui-surface'))
}

export function installProfileDeps(dir: string): { readonly ok: boolean; readonly status: number | null } {
  const result = spawnSync('pnpm', ['install'], {
    cwd: dir,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: profileInstallEnv(),
    shell: process.platform === 'win32',
    windowsHide: true,
  })
  return { ok: result.status === 0, status: result.status }
}
