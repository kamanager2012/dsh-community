import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCRIPT_PATH = resolve(ROOT, 'scripts/clean-build-artifacts.mjs')

interface CleanupReportItem {
  path: string
  category: string
  bytes: number
  files: number
  formattedBytes: string
}

interface CleanupReport {
  root: string
  scope: string
  dryRun: boolean
  keepDist: boolean
  keepRelease: boolean
  totalBytes: number
  totalFiles: number
  formattedTotalBytes: string
  removed: CleanupReportItem[]
}

const { cleanBuildArtifacts, formatBytes, resolveCleanupTargets } = (await import(
  pathToFileURL(SCRIPT_PATH).href
)) as {
  formatBytes: (bytes: number) => string
  resolveCleanupTargets: (opts?: {
    root?: string
    scope?: string
    keepDist?: boolean
    keepRelease?: boolean
  }) => Promise<Array<{ relativePath: string; fullPath: string; category: string }>>
  cleanBuildArtifacts: (opts?: {
    root?: string
    scope?: string
    dryRun?: boolean
    keepDist?: boolean
    keepRelease?: boolean
  }) => Promise<CleanupReport>
}

const tempRoots: string[] = []

function makeTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-clean-artifacts-'))
  tempRoots.push(dir)
  return dir
}

function seedFile(root: string, relPath: string, sizeBytes: number): void {
  const abs = join(root, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, Buffer.alloc(sizeBytes, 0x61))
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('build artifact cleanup utility', () => {
  it('formats byte sizes consistently across units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.00 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB')
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB')
  })

  it('supports dry-run accounting without deleting targets and preserves protected paths', async () => {
    const root = makeTempWorkspace()
    // Artifacts that should be discovered and cleaned
    seedFile(root, 'apps/desktop/runtime-stage/node_modules/pkg/index.js', 1000)
    seedFile(root, 'apps/desktop/runtime-host/official-dsh.tar', 2000)
    seedFile(root, 'apps/desktop/.pack-root/bundle.js', 300)
    seedFile(root, 'apps/desktop/remote-bundle/adapter.js', 400)
    seedFile(root, 'apps/desktop/release/dsh.AppImage', 5000)
    seedFile(root, 'apps/desktop/dist/main.js', 500)
    seedFile(root, 'apps/android/app/build/outputs/app.apk', 4000)
    seedFile(root, 'apps/android/build/tmp.bin', 200)
    seedFile(root, 'apps/android/.gradle/caches/entry.bin', 600)
    seedFile(root, 'packages/shared-types/dist/index.js', 700)
    seedFile(root, 'packages/shared-types/tsconfig.tsbuildinfo', 100)
    seedFile(root, 'contracts/tsconfig.tsbuildinfo', 50)
    seedFile(root, 'tsconfig.tsbuildinfo', 25)

    // Protected files that MUST NEVER be touched
    const protectedFiles = [
      'apps/desktop/src/pages.ts',
      'apps/desktop/runtime-lock/package-lock.json',
      'apps/desktop/node_modules/electron/dist/electron',
      'apps/android/evidence/reality-gate.json',
      'apps/android/app/src/main/java/DshApp.kt',
      'node_modules/vitest/dist/index.js',
      '.git/HEAD',
    ]
    for (const rel of protectedFiles) {
      seedFile(root, rel, 64)
    }

    const dry = await cleanBuildArtifacts({ root, scope: 'all', dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect(dry.totalBytes).toBe(14875)
    expect(dry.totalFiles).toBe(13)
    expect(dry.removed.map((item) => item.path)).not.toContain('apps/desktop/runtime-lock')
    expect(dry.removed.map((item) => item.path)).not.toContain('apps/android/evidence')
    expect(existsSync(join(root, 'apps/desktop/release/dsh.AppImage'))).toBe(true)

    const actual = await cleanBuildArtifacts({ root, scope: 'all', dryRun: false })
    expect(actual.totalBytes).toBe(14875)
    expect(actual.totalFiles).toBe(13)
    expect(existsSync(join(root, 'apps/desktop/runtime-stage'))).toBe(false)
    expect(existsSync(join(root, 'apps/desktop/release'))).toBe(false)
    expect(existsSync(join(root, 'apps/android/app/build'))).toBe(false)
    expect(existsSync(join(root, 'packages/shared-types/dist'))).toBe(false)
    expect(existsSync(join(root, 'packages/shared-types/tsconfig.tsbuildinfo'))).toBe(false)
    expect(existsSync(join(root, 'contracts/tsconfig.tsbuildinfo'))).toBe(false)
    expect(existsSync(join(root, 'tsconfig.tsbuildinfo'))).toBe(false)

    for (const rel of protectedFiles) {
      expect(existsSync(join(root, rel))).toBe(true)
    }
  })

  it('isolates scopes and respects --keep-dist and --keep-release', async () => {
    const root = makeTempWorkspace()
    seedFile(root, 'apps/desktop/runtime-stage/stage.txt', 100)
    seedFile(root, 'apps/desktop/release/dsh.AppImage', 200)
    seedFile(root, 'apps/desktop/dist/main.js', 300)
    seedFile(root, 'packages/tui/dist/cli.js', 400)
    seedFile(root, 'packages/tui/tsconfig.tsbuildinfo', 50)
    seedFile(root, 'apps/android/app/build/out.apk', 600)

    const androidReport = await cleanBuildArtifacts({ root, scope: 'android' })
    expect(androidReport.totalBytes).toBe(600)
    expect(existsSync(join(root, 'apps/android/app/build'))).toBe(false)
    expect(existsSync(join(root, 'apps/desktop/runtime-stage'))).toBe(true)

    const desktopKeep = await cleanBuildArtifacts({
      root,
      scope: 'desktop',
      keepDist: true,
      keepRelease: true,
    })
    expect(desktopKeep.removed.map((item) => item.path)).toEqual(['apps/desktop/runtime-stage'])
    expect(existsSync(join(root, 'apps/desktop/release/dsh.AppImage'))).toBe(true)
    expect(existsSync(join(root, 'apps/desktop/dist/main.js'))).toBe(true)

    const tsKeepDist = await resolveCleanupTargets({ root, scope: 'ts', keepDist: true })
    expect(tsKeepDist.map((item) => item.relativePath)).toEqual(['packages/tui/tsconfig.tsbuildinfo'])
  })

  it('supports CLI --dry-run --json execution and rejects invalid scopes', () => {
    const root = makeTempWorkspace()
    seedFile(root, 'apps/desktop/runtime-stage/a.bin', 2048)

    const jsonOut = execFileSync(
      process.execPath,
      [SCRIPT_PATH, '--root', root, '--dry-run', '--json'],
      { encoding: 'utf8' },
    )
    const parsed = JSON.parse(jsonOut) as CleanupReport
    expect(parsed.totalBytes).toBe(2048)
    expect(parsed.dryRun).toBe(true)
    expect(existsSync(join(root, 'apps/desktop/runtime-stage/a.bin'))).toBe(true)

    const bad = spawnSync(process.execPath, [SCRIPT_PATH, '--root', root, '--scope', 'unknown'], {
      encoding: 'utf8',
    })
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('Invalid scope')
  })

  it('wires package.json script and auto-prunes staging dirs unless opted out', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    expect(pkg.scripts?.['clean:artifacts']).toBe('node scripts/clean-build-artifacts.mjs')

    const stageScript = readFileSync(
      join(ROOT, 'apps/desktop/scripts/stage-official-runtime.mjs'),
      'utf8',
    )
    expect(stageScript).toContain('DSH_KEEP_RUNTIME_STAGE')
    expect(stageScript).toContain('rm(stageRoot')

    const packScript = readFileSync(join(ROOT, 'apps/desktop/scripts/package.mjs'), 'utf8')
    expect(packScript).toContain('DSH_KEEP_PACK_ROOT')
    expect(packScript).toContain('rm(packRoot')
  })
})
