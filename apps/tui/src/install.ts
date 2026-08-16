import { spawnSync } from 'node:child_process'

export function profileNeedsInstall(_dir: string): boolean {
  return false
}

export function installProfileDeps(dir: string): { readonly ok: boolean; readonly status: number | null } {
  const result = spawnSync('pnpm', ['install'], {
    cwd: dir,
    stdio: 'inherit',
    env: process.env,
  })
  return { ok: result.status === 0, status: result.status }
}
