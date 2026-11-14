#!/usr/bin/env node
/**
 * Reclaim disk space from local generated build and packaging artifacts.
 *
 * Strictly targets allowlisted build/staging directories (`apps/desktop/{release,
 * runtime-host,runtime-stage,.pack-root,remote-bundle,dist}`, `apps/android/
 * {app/build,build,.gradle}`, workspace `dist/`, and `*.tsbuildinfo`). Never
 * modifies source files, `node_modules/`, `apps/desktop/runtime-lock/`,
 * `apps/android/evidence/`, or user home state under `~/.dsh`.
 */
import { lstat, readdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_REPO_ROOT = resolve(__dirname, '..')

export const VALID_SCOPES = new Set(['all', 'desktop', 'android', 'ts'])

export const WORKSPACE_CONTAINERS = ['apps', 'packages', 'tests', 'contracts']

export const DESKTOP_ARTIFACT_DIRS = [
  'apps/desktop/runtime-stage',
  'apps/desktop/runtime-host',
  'apps/desktop/.pack-root',
  'apps/desktop/remote-bundle',
]

export const ANDROID_ARTIFACT_DIRS = [
  'apps/android/app/build',
  'apps/android/build',
  'apps/android/.gradle',
]

const PROTECTED_SEGMENTS = new Set(['.git', 'node_modules', 'runtime-lock', 'evidence', 'src'])

/**
 * Format a byte count into a concise binary-unit string (B, KB, MB, GB).
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return unitIndex === 0 ? `${String(Math.round(value))} B` : `${value.toFixed(2)} ${units[unitIndex]}`
}

async function safeLstat(targetPath) {
  try {
    return await lstat(targetPath)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

/**
 * Measure total apparent bytes and file entries for a path without following symlinks.
 * @param {string} targetPath
 * @returns {Promise<{ bytes: number, files: number }>}
 */
export async function measureEntryBytes(targetPath) {
  const stats = await safeLstat(targetPath)
  if (!stats) return { bytes: 0, files: 0 }
  if (!stats.isDirectory()) {
    return { bytes: stats.size, files: 1 }
  }
  const entries = await readdir(targetPath)
  let totalBytes = 0
  let totalFiles = 0
  for (const name of entries) {
    const child = await measureEntryBytes(join(targetPath, name))
    totalBytes += child.bytes
    totalFiles += child.files
  }
  return { bytes: totalBytes, files: totalFiles }
}

function assertSafeTarget(resolvedRoot, relPosix) {
  if (!relPosix || relPosix.startsWith('..') || isAbsolute(relPosix)) {
    throw new Error(`Refusing unsafe cleanup path: ${relPosix}`)
  }
  const segments = relPosix.split('/')
  if (segments.some((segment) => PROTECTED_SEGMENTS.has(segment))) {
    throw new Error(`Refusing protected cleanup path: ${relPosix}`)
  }
  const fullPath = resolve(resolvedRoot, relPosix)
  if (fullPath !== resolvedRoot && !fullPath.startsWith(resolvedRoot + sep)) {
    throw new Error(`Refusing out-of-root cleanup path: ${fullPath}`)
  }
  return fullPath
}

async function addIfExists(targetMap, resolvedRoot, relPath, category) {
  const relPosix = relPath.split(sep).join('/')
  if (targetMap.has(relPosix)) return
  const fullPath = assertSafeTarget(resolvedRoot, relPosix)
  const stats = await safeLstat(fullPath)
  if (!stats) return
  targetMap.set(relPosix, { relativePath: relPosix, fullPath, category })
}

async function collectTsBuildInfoFiles(targetMap, resolvedRoot, relDir, category) {
  const absDir = join(resolvedRoot, relDir)
  const dirStats = await safeLstat(absDir)
  if (!dirStats || !dirStats.isDirectory()) return
  const entries = await readdir(absDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.tsbuildinfo')) {
      const relFile = relDir ? `${relDir}/${entry.name}` : entry.name
      await addIfExists(targetMap, resolvedRoot, relFile, category)
    }
  }
}

async function collectTsTargets(targetMap, resolvedRoot, keepDist) {
  await collectTsBuildInfoFiles(targetMap, resolvedRoot, '', 'ts')

  for (const container of WORKSPACE_CONTAINERS) {
    const containerPath = join(resolvedRoot, container)
    const stats = await safeLstat(containerPath)
    if (!stats || !stats.isDirectory()) continue

    await collectTsBuildInfoFiles(targetMap, resolvedRoot, container, 'ts')
    const entries = await readdir(containerPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || PROTECTED_SEGMENTS.has(entry.name)) {
        continue
      }
      const pkgRel = `${container}/${entry.name}`
      if (!keepDist) {
        await addIfExists(targetMap, resolvedRoot, `${pkgRel}/dist`, 'ts')
      }
      await collectTsBuildInfoFiles(targetMap, resolvedRoot, pkgRel, 'ts')
    }
  }
}

/**
 * Resolve all existing allowlisted build-artifact targets under `root`.
 * @param {{ root?: string, scope?: string, keepDist?: boolean, keepRelease?: boolean }} [options]
 * @returns {Promise<Array<{ relativePath: string, fullPath: string, category: string }>>}
 */
export async function resolveCleanupTargets(options = {}) {
  const {
    root = DEFAULT_REPO_ROOT,
    scope = 'all',
    keepDist = false,
    keepRelease = false,
  } = options

  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`Invalid scope "${scope}". Expected one of: all, desktop, android, ts`)
  }

  const resolvedRoot = resolve(root)
  const targetMap = new Map()

  if (scope === 'all' || scope === 'desktop') {
    for (const rel of DESKTOP_ARTIFACT_DIRS) {
      await addIfExists(targetMap, resolvedRoot, rel, 'desktop')
    }
    if (!keepRelease) {
      await addIfExists(targetMap, resolvedRoot, 'apps/desktop/release', 'desktop')
    }
    if (!keepDist) {
      await addIfExists(targetMap, resolvedRoot, 'apps/desktop/dist', 'desktop')
    }
  }

  if (scope === 'all' || scope === 'android') {
    for (const rel of ANDROID_ARTIFACT_DIRS) {
      await addIfExists(targetMap, resolvedRoot, rel, 'android')
    }
  }

  if (scope === 'all' || scope === 'ts') {
    await collectTsTargets(targetMap, resolvedRoot, keepDist)
  }

  return Array.from(targetMap.values()).sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

/**
 * Clean allowlisted generated build artifacts under `root` and return per-target byte accounting.
 * @param {{ root?: string, scope?: string, dryRun?: boolean, keepDist?: boolean, keepRelease?: boolean }} [options]
 */
export async function cleanBuildArtifacts(options = {}) {
  const {
    root = DEFAULT_REPO_ROOT,
    scope = 'all',
    dryRun = false,
    keepDist = false,
    keepRelease = false,
  } = options

  const resolvedRoot = resolve(root)
  const targets = await resolveCleanupTargets({ root: resolvedRoot, scope, keepDist, keepRelease })

  let totalBytes = 0
  let totalFiles = 0
  const removed = []

  for (const target of targets) {
    const relCheck = relative(resolvedRoot, target.fullPath).split(sep).join('/')
    assertSafeTarget(resolvedRoot, relCheck)
    const { bytes, files } = await measureEntryBytes(target.fullPath)
    if (!dryRun) {
      await rm(target.fullPath, { recursive: true, force: true })
    }
    totalBytes += bytes
    totalFiles += files
    removed.push({
      path: target.relativePath,
      category: target.category,
      bytes,
      files,
      formattedBytes: formatBytes(bytes),
    })
  }

  return {
    root: resolvedRoot,
    scope,
    dryRun,
    keepDist,
    keepRelease,
    totalBytes,
    totalFiles,
    formattedTotalBytes: formatBytes(totalBytes),
    removed,
  }
}

export function parseCliArgs(argv) {
  const opts = {
    root: DEFAULT_REPO_ROOT,
    scope: 'all',
    dryRun: false,
    keepDist: false,
    keepRelease: false,
    json: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      opts.dryRun = true
    } else if (arg === '--keep-dist') {
      opts.keepDist = true
    } else if (arg === '--keep-release') {
      opts.keepRelease = true
    } else if (arg === '--json') {
      opts.json = true
    } else if (arg === '-h' || arg === '--help') {
      opts.help = true
    } else if (arg === '--scope') {
      const next = argv[i + 1]
      if (!next || next.startsWith('-')) throw new Error('Missing value for --scope')
      opts.scope = next
      i += 1
    } else if (arg.startsWith('--scope=')) {
      opts.scope = arg.slice('--scope='.length)
    } else if (arg === '--root') {
      const next = argv[i + 1]
      if (!next || next.startsWith('-')) throw new Error('Missing value for --root')
      opts.root = next
      i += 1
    } else if (arg.startsWith('--root=')) {
      opts.root = arg.slice('--root='.length)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!VALID_SCOPES.has(opts.scope)) {
    throw new Error(`Invalid scope "${opts.scope}". Expected one of: all, desktop, android, ts`)
  }
  return opts
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/clean-build-artifacts.mjs [options]

Reclaim disk space from local generated build/packaging artifacts without touching
source files, node_modules, runtime-lock, Android evidence, or ~/.dsh state.

Options:
  --scope <all|desktop|android|ts>  Restrict cleanup scope (default: all)
  --dry-run                         Report reclaimable targets and bytes without deleting
  --keep-dist                       Preserve */dist TypeScript build outputs
  --keep-release                    Preserve apps/desktop/release outputs
  --json                            Emit machine-readable JSON output
  --root <dir>                      Override repository root directory
  -h, --help                        Show this help message
`)
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2))
  if (opts.help) {
    printHelp()
    return
  }

  const report = await cleanBuildArtifacts(opts)
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }

  if (report.removed.length === 0) {
    process.stdout.write(`No matching build artifacts found (scope: ${report.scope}).\n`)
    return
  }

  const verb = report.dryRun ? 'would remove' : 'removed'
  for (const item of report.removed) {
    process.stdout.write(`- ${verb} ${item.path} (${item.formattedBytes}, ${String(item.files)} files)\n`)
  }
  const summaryVerb = report.dryRun ? 'Dry run: would reclaim' : 'Cleaned: reclaimed'
  process.stdout.write(
    `${summaryVerb} ${report.formattedTotalBytes} across ${String(report.removed.length)} target(s).\n`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`clean:artifacts failed: ${message}\n`)
    process.exit(1)
  })
}
