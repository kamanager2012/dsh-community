import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

export const OFFICIAL_HOST_ARCHIVE = 'host/official-dsh.tar'
export const OFFICIAL_BIN_INSIDE = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
export const OFFICIAL_HOST_READY = '.dsh-host-ready'

export function officialHostArchive(resourcesPath: string): string {
  return join(resourcesPath, ...OFFICIAL_HOST_ARCHIVE.split('/'))
}

export function officialHostRoot(userData: string, pin: string): string {
  return join(userData, 'official-dsh', pin)
}

export function officialHostBin(root: string): string {
  return join(root, OFFICIAL_BIN_INSIDE)
}

export function officialHostReady(root: string): string {
  return join(root, OFFICIAL_HOST_READY)
}

export function isOfficialHostReady(destRoot: string): boolean {
  return existsSync(officialHostReady(destRoot)) && existsSync(officialHostBin(destRoot))
}

export function nodeModulesFromBin(binPath: string): string {
  return join(binPath, '..', '..', '..', '..')
}

function tarExecutable(): string {
  if (process.platform === 'win32') {
    const rooted = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    if (existsSync(rooted)) return rooted
  }
  return 'tar'
}

/**
 * Unpack the staged official runtime once per pin. The installer ships a
 * single tar so Windows NSIS does not copy tens of thousands of files.
 * A ready stamp is written last so a crashed extract is retried.
 */
export function ensureOfficialHostExtracted(input: {
  readonly archivePath: string
  readonly destRoot: string
}): string {
  const bin = officialHostBin(input.destRoot)
  if (isOfficialHostReady(input.destRoot)) return bin
  if (!existsSync(input.archivePath)) {
    throw new Error(`official dsh archive missing: ${input.archivePath}`)
  }
  rmSync(input.destRoot, { recursive: true, force: true })
  mkdirSync(input.destRoot, { recursive: true })
  process.stderr.write('dsh-community: extracting official runtime (first launch)…\n')
  const result = spawnSync(tarExecutable(), ['-xf', input.archivePath, '-C', input.destRoot], {
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw new Error(`extract official dsh failed: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`extract official dsh failed (${String(result.status)})`)
  }
  if (!existsSync(bin)) throw new Error(`extract official dsh missing ${bin}`)
  const appBoot = join(input.destRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json')
  if (!existsSync(appBoot)) {
    throw new Error(`extract official dsh is incomplete: missing ${appBoot}`)
  }
  writeFileSync(officialHostReady(input.destRoot), 'ok\n')
  return bin
}
