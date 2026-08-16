/**
 * Package without letting electron-builder run `pnpm install --production`
 * inside apps/desktop (that deletes Electron).
 */

import { cp, mkdir, rm, writeFile, access, readdir } from 'node:fs/promises'
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
const productAppName = 'DSH Community.app'

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function electronBinaryPath() {
  if (process.platform === 'win32') return join(electronDir, 'dist', 'electron.exe')
  if (process.platform === 'darwin') return join(electronDir, 'dist', 'Electron.app')
  return join(electronDir, 'dist', 'electron')
}

function packagingTarget(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  if (args.includes('--appimage')) return 'appimage'
  if (args.includes('--win')) return 'win'
  if (args.includes('--mac')) return 'mac'
  return 'dir'
}

async function findMacApp(outDir) {
  const preferred = ['mac-arm64', 'mac', 'mac-universal', 'mac-x64']
  for (const name of preferred) {
    const app = join(outDir, name, productAppName)
    if (await exists(app)) return app
  }
  const entries = await readdir(outDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const app = join(outDir, entry.name, productAppName)
    if (await exists(app)) return app
  }
  return undefined
}

async function ensureElectronDist() {
  const electronBinary = electronBinaryPath()
  if (await exists(electronBinary)) return
  const cacheRoot = join(homedir(), '.cache/electron')
  if (process.platform !== 'win32' && await exists(cacheRoot)) {
    const zipName = process.platform === 'darwin'
      ? `electron-v${electronVersion}-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`
      : `electron-v${electronVersion}-linux-x64.zip`
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

await ensureElectronDist()

// Call the scripts with node. Do not spawn `pnpm` here — on Windows that is
// pnpm.cmd and spawnSync without a shell exits with status null.
process.stdout.write('building desktop main/preload…\n')
runCommand(process.execPath, [join(desktop, 'scripts/write-tray-icon.mjs')], { cwd: desktop })
runCommand(process.execPath, [join(desktop, 'scripts/build.mjs')], { cwd: desktop })

if (!await exists(join(desktop, 'runtime-host/node_modules/@deepseek-ai/dsh/lib/bin.js'))) {
  runCommand(process.execPath, [join(desktop, 'scripts/stage-official-runtime.mjs')], { cwd: desktop })
}

await rm(packRoot, { recursive: true, force: true })
await mkdir(join(packRoot, 'dist'), { recursive: true })
await cp(join(desktop, 'dist'), join(packRoot, 'dist'), { recursive: true })
await cp(join(desktop, 'resources'), join(packRoot, 'resources'), { recursive: true })

const targetFlag = packagingTarget(process.argv.slice(2))

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
        from: join(desktop, 'runtime-host/node_modules'),
        to: 'host/node_modules',
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
    win: {
      target: [{ target: 'dir', arch: ['x64'] }],
      icon: 'resources/icon.png',
      artifactName: 'dsh-community-${version}-win-x64.${ext}',
    },
    nsis: {
      artifactName: 'DSH Community Setup ${version}.${ext}',
      shortcutName: 'DSH Community',
    },
    mac: {
      target: [{ target: 'dir' }],
      icon: 'resources/icon.png',
      category: 'public.app-category.developer-tools',
      hardenedRuntime: false,
      gatekeeperAssess: false,
    },
  },
}

await writeFile(join(packRoot, 'package.json'), `${JSON.stringify(packManifest, null, 2)}\n`)
// Keep electron-builder inside this directory. If it walks up into the
// monorepo pnpm store, Windows Defender turns a 2-minute pack into a hang.
await writeFile(join(packRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "."\n')
await mkdir(join(packRoot, 'node_modules'), { recursive: true })

const builderArgs = ['--publish', 'never', '--config.npmRebuild=false']
if (targetFlag === 'win') builderArgs.unshift('--win', 'nsis', 'zip')
else if (targetFlag === 'mac') builderArgs.unshift('--mac', 'dir', 'dmg')
else builderArgs.unshift('--linux', targetFlag === 'appimage' ? 'AppImage' : 'dir')

await rm(releaseDir, { recursive: true, force: true })
process.stdout.write(`electron-builder ${builderArgs.join(' ')}\n`)
runCommand(process.execPath, [builderCli, ...builderArgs], { cwd: packRoot })

if (targetFlag === 'appimage') {
  const images = (await readdir(releaseDir)).filter((name) => name.endsWith('.AppImage'))
  if (images.length === 0) throw new Error(`AppImage missing in ${releaseDir}`)
  process.stdout.write(`packaged ${join(releaseDir, images[0] ?? '')}\n`)
} else if (targetFlag === 'win') {
  const names = await readdir(releaseDir)
  const exe = names.find((name) => name.endsWith('.exe') && name.includes('Setup'))
    ?? names.find((name) => name.endsWith('.exe'))
  const zip = names.find((name) => name.endsWith('.zip'))
  if (exe === undefined) throw new Error(`Windows installer missing in ${releaseDir}`)
  if (zip === undefined) throw new Error(`Windows zip missing in ${releaseDir}`)
  const bin = join(releaseDir, 'win-unpacked', 'DSH Community.exe')
  const officialPath = join(releaseDir, 'win-unpacked', 'resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js')
  if (!await exists(bin)) throw new Error(`packaged executable missing: ${bin}`)
  if (!await exists(officialPath)) throw new Error(`staged official dsh missing: ${officialPath}`)
  process.stdout.write(`packaged ${join(releaseDir, exe)}\n`)
  process.stdout.write(`packaged ${join(releaseDir, zip)}\n`)
} else if (targetFlag === 'mac') {
  const dmg = (await readdir(releaseDir)).find((name) => name.endsWith('.dmg'))
  if (dmg === undefined) throw new Error(`macOS dmg missing in ${releaseDir}`)
  const bin = await findMacApp(releaseDir)
  if (bin === undefined) throw new Error(`packaged executable missing under ${releaseDir} (looked for ${productAppName})`)
  const officialPath = join(bin, 'Contents/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js')
  if (!await exists(officialPath)) throw new Error(`staged official dsh missing: ${officialPath}`)
  process.stdout.write(`packaged ${join(releaseDir, dmg)}\n`)
} else {
  const unpackedRoot = join(releaseDir, 'linux-unpacked')
  const bin = join(unpackedRoot, 'dsh-community')
  const officialPath = join(unpackedRoot, 'resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js')
  if (!await exists(bin)) throw new Error(`packaged executable missing: ${bin}`)
  if (!await exists(officialPath)) throw new Error(`staged official dsh missing: ${officialPath}`)
  process.stdout.write(`packaged ${bin}\n`)
  process.stdout.write(`official  ${officialPath}\n`)
}
