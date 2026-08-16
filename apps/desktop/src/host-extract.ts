import { existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

export const OFFICIAL_HOST_ARCHIVE = 'host/official-dsh.tar'
export const OFFICIAL_BIN_INSIDE = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

export function officialHostArchive(resourcesPath: string): string {
  return join(resourcesPath, ...OFFICIAL_HOST_ARCHIVE.split('/'))
}

export function officialHostRoot(userData: string, pin: string): string {
  return join(userData, 'official-dsh', pin)
}

export function officialHostBin(root: string): string {
  return join(root, OFFICIAL_BIN_INSIDE)
}

export function nodeModulesFromBin(binPath: string): string {
  return join(binPath, '..', '..', '..', '..')
}

/**
 * Unpack the staged official runtime once per pin. The installer ships a
 * single tar so Windows NSIS does not copy tens of thousands of files.
 */
export function ensureOfficialHostExtracted(input: {
  readonly archivePath: string
  readonly destRoot: string
}): string {
  const bin = officialHostBin(input.destRoot)
  if (existsSync(bin)) return bin
  if (!existsSync(input.archivePath)) {
    throw new Error(`official dsh archive missing: ${input.archivePath}`)
  }
  mkdirSync(input.destRoot, { recursive: true })
  const result = spawnSync('tar', ['-xf', input.archivePath, '-C', input.destRoot], {
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw new Error(`extract official dsh failed: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`extract official dsh failed (${String(result.status)})`)
  }
  if (!existsSync(bin)) throw new Error(`extract official dsh missing ${bin}`)
  return bin
}
