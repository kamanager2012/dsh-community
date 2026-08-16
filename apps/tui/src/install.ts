import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function profileNeedsInstall(dir: string): boolean {
  return !existsSync(join(dir, 'node_modules', '@dsh-community', 'tui-surface'))
}

export function installProfileDeps(dir: string): { readonly ok: boolean; readonly status: number | null } {
  const result = spawnSync('pnpm', ['install'], {
    cwd: dir,
    stdio: 'inherit',
    env: process.env,
  })
  return { ok: result.status === 0, status: result.status }
}
