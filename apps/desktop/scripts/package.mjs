/**
 * Package without letting electron-builder run `pnpm install --production`
 * inside apps/desktop (that deletes Electron).
 */

import { cp, mkdir, rm, writeFile, access, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from './run-command.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = resolve(desktop, '../..')
const packRoot = join(desktop, '.pack-root')
const releaseDir = join(desktop, 'release')
const electronDir = join(desktop, 'node_modules/electron')
const require = createRequire(join(desktop, 'package.json'))
const desktopManifest = require('./package.json')
const electronVersion = require('electron/package.json').version
const packVersion = typeof desktopManifest.version === 'string' ? desktopManifest.version : '0.1.1'
const builderCli = join(desktop, 'node_modules/electron-builder/cli.js')

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function electronBinaryPath() {
  return join(electronDir, 'dist', 'electron')
}

function packagingTarget(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  if (args.includes('--win') || args.includes('--mac')) {
    throw new Error(
      'Windows and macOS desktop installers are retired under dsh-community Complementary Edition; use official deepseek-ai/deepseek-harness desktop releases.',
    )
  }
  if (args.includes('--appimage')) return 'appimage'
  return 'dir'
}

async function ensureElectronDist() {
  const electronBinary = electronBinaryPath()
  if (await exists(electronBinary)) return
  const cacheRoot = join(homedir(), '.cache/electron')
  if (await exists(cacheRoot)) {
    const zipName = `electron-v${electronVersion}-linux-x64.zip`
    for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const zip = join(cacheRoot, entry.name, zipName)
      if (!await exists(zip)) continue
      process.stdout.write(`unpacking Electron ${electronVersion} from cache…\n`)
      await mkdir(join(electronDir, 'dist'), { recursive: true })
      runCommand('unzip', ['-qo', zip, '-d', join(electronDir, 'dist')], { cwd: electronDir })
      if (await exists(electronBinary)) return
    }
  }
  process.stdout.write('downloading Electron dist…\n')
  runCommand(process.execPath, [join(electronDir, 'install.js')], { cwd: electronDir })
  if (!await exists(electronBinary)) {
    throw new Error(`Electron ${electronVersion} dist missing at ${electronBinary}. Set network access or cache ~/.cache/electron.`)
  }
}

function phase(message) {
  process.stdout.write(`[pack ${new Date().toISOString()}] ${message}\n`)
}

const targetFlag = packagingTarget(process.argv.slice(2))
if (process.platform !== 'linux') {
  throw new Error(
    `dsh-community Desktop packaging supports Linux (AppImage/dir) only; current platform is ${process.platform}.`,
  )
}

await ensureElectronDist()

// Call the scripts with node. Do not spawn `pnpm` here — on Windows that is
// pnpm.cmd and spawnSync without a shell exits with status null.
phase('building desktop main/preload')
runCommand(process.execPath, [join(desktop, 'scripts/write-tray-icon.mjs')], { cwd: desktop })
runCommand(process.execPath, [join(desktop, 'scripts/build.mjs')], { cwd: desktop })

const stagedTar = join(desktop, 'runtime-host/official-dsh.tar')
const stagedBytes = await exists(stagedTar) ? (await stat(stagedTar)).size : 0
if (!await exists(stagedTar) || stagedBytes < 80_000_000) {
  phase(stagedBytes > 0 ? `restaging official runtime (old tar ${String(stagedBytes)} bytes)` : 'staging official runtime')
  runCommand(process.execPath, [join(desktop, 'scripts/stage-official-runtime.mjs')], { cwd: desktop })
} else {
  phase(`official runtime already staged (${String(stagedBytes)} bytes)`)
}

await rm(packRoot, { recursive: true, force: true })
await mkdir(join(packRoot, 'dist'), { recursive: true })
await cp(join(desktop, 'dist'), join(packRoot, 'dist'), { recursive: true })
await cp(join(desktop, 'resources'), join(packRoot, 'resources'), { recursive: true })

const linuxTarget = targetFlag === 'appimage'
  ? [{ target: 'AppImage', arch: ['x64'] }]
  : [{ target: 'dir', arch: ['x64'] }]

const packManifest = {
  name: 'dsh-community-desktop',
  version: packVersion,
  private: true,
  type: 'module',
  packageManager: 'pnpm@11.21.0',
  main: 'dist/main.js',
  description: 'Community preview shell around official DeepSeek Harness.',
  author: 'dsh-community contributors',
  desktopName: 'dsh-community.desktop',
  dependencies: {},
  build: {
    appId: 'dev.dshcommunity.desktop',
    productName: 'DSH Community',
    artifactName: 'dsh-community-${version}.${ext}',
    copyright: 'Copyright 2026 dsh-community contributors',
    electronDist: join(electronDir, 'dist'),
    electronVersion,
    npmRebuild: false,
    nodeGypRebuild: false,
    asar: true,
    compression: 'normal',
    icon: 'resources/icon.png',
    directories: {
      output: releaseDir,
    },
    files: [
      'dist/**',
      'resources/**',
      'package.json',
    ],
    extraResources: [
      {
        from: join(desktop, 'runtime-host/official-dsh.tar'),
        to: 'host/official-dsh.tar',
      },
      {
        from: join(desktop, 'remote-bundle'),
        to: 'remote',
      },
      {
        from: join(workspace, 'contracts/compatibility/latest-tested.json'),
        to: 'contracts/latest-tested.json',
      },
      {
        from: join(workspace, 'contracts/compatibility/matrix.json'),
        to: 'contracts/matrix.json',
      },
    ],
    linux: {
      target: linuxTarget,
      category: 'Development',
      icon: 'resources/icon.png',
      executableName: 'dsh-community',
      syncDesktopName: true,
    },
  },
}

await writeFile(join(packRoot, 'package.json'), `${JSON.stringify(packManifest, null, 2)}\n`)
// Keep electron-builder bounded to this isolated staging workspace so
// packaging never traverses or weakens host monorepo trees.
await writeFile(join(packRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "."\n')
await mkdir(join(packRoot, 'node_modules'), { recursive: true })

const builderArgs = ['--linux', targetFlag === 'appimage' ? 'AppImage' : 'dir', '--publish', 'never', '--config.npmRebuild=false']

await rm(releaseDir, { recursive: true, force: true })
phase(`electron-builder ${builderArgs.join(' ')}`)
runCommand(process.execPath, [builderCli, ...builderArgs], { cwd: packRoot })
phase('electron-builder finished')

if (targetFlag === 'appimage') {
  const images = (await readdir(releaseDir)).filter((name) => name.endsWith('.AppImage'))
  if (images.length === 0) throw new Error(`AppImage missing in ${releaseDir}`)
  const imagePath = join(releaseDir, images[0] ?? '')
  process.stdout.write(`packaged ${imagePath}\n`)
} else {
  const unpackedRoot = join(releaseDir, 'linux-unpacked')
  const bin = join(unpackedRoot, 'dsh-community')
  const officialPath = join(unpackedRoot, 'resources/host/official-dsh.tar')
  if (!await exists(bin)) throw new Error(`packaged executable missing: ${bin}`)
  if (!await exists(officialPath)) throw new Error(`staged official dsh archive missing: ${officialPath}`)
  process.stdout.write(`packaged ${bin}\n`)
  process.stdout.write(`official  ${officialPath}\n`)
}
