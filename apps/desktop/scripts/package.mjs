/**
 * Package a Linux unpacked preview without letting electron-builder
 * run `pnpm install --production` inside apps/desktop (that deletes Electron).
 */

import { cp, mkdir, rm, writeFile, access, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

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

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'true' } })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${String(result.status)})`)
  }
}

async function ensureElectronDist() {
  const electronBinary = process.platform === 'win32'
    ? join(electronDir, 'dist', 'electron.exe')
    : process.platform === 'darwin'
      ? join(electronDir, 'dist', 'Electron.app')
      : join(electronDir, 'dist', 'electron')
  if (await exists(electronBinary)) return
  const cacheRoot = join(homedir(), '.cache/electron')
  if (await exists(cacheRoot)) {
    for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const zip = join(cacheRoot, entry.name, `electron-v${electronVersion}-linux-x64.zip`)
      if (!await exists(zip)) continue
      process.stdout.write(`unpacking Electron ${electronVersion} from cache…\n`)
      await mkdir(join(electronDir, 'dist'), { recursive: true })
      run('unzip', ['-qo', zip, '-d', join(electronDir, 'dist')], electronDir)
      if (await exists(electronBinary)) return
    }
  }
  process.stdout.write('downloading Electron dist…\n')
  run(process.execPath, [join(electronDir, 'install.js')], electronDir)
  if (!await exists(electronBinary)) {
    throw new Error(`Electron ${electronVersion} dist missing at ${electronBinary}. Set network access or cache ~/.cache/electron.`)
  }
}

await ensureElectronDist()

run('pnpm', ['--filter', '@dsh-community/desktop', 'build'], workspace)

if (!await exists(join(desktop, 'runtime-host/node_modules/@deepseek-ai/dsh/lib/bin.js'))) {
  run('pnpm', ['--filter', '@dsh-community/desktop', 'stage-host'], workspace)
}

await rm(packRoot, { recursive: true, force: true })
await mkdir(join(packRoot, 'dist'), { recursive: true })
await cp(join(desktop, 'dist'), join(packRoot, 'dist'), { recursive: true })
await cp(join(desktop, 'resources'), join(packRoot, 'resources'), { recursive: true })

const targetFlag = process.argv.includes('--appimage')
  ? 'appimage'
  : process.argv.includes('--win')
    ? 'win'
    : process.argv.includes('--mac')
      ? 'mac'
      : 'dir'

const linuxTarget = targetFlag === 'appimage'
  ? [{ target: 'AppImage', arch: ['x64'] }]
  : [{ target: 'dir', arch: ['x64'] }]

const packManifest = {
  name: 'dsh-community-desktop',
  version: packVersion,
  private: true,
  type: 'module',
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
      icon: join(desktop, 'resources/tray.png'),
      executableName: 'dsh-community',
      syncDesktopName: true,
    },
    win: {
      target: [{ target: 'dir', arch: ['x64'] }],
      icon: join(desktop, 'resources/tray.png'),
    },
    mac: {
      target: [{ target: 'dir' }],
      icon: join(desktop, 'resources/tray.png'),
      category: 'public.app-category.developer-tools',
    },
  },
}

await writeFile(join(packRoot, 'package.json'), `${JSON.stringify(packManifest, null, 2)}\n`)

const builderArgs = ['--publish', 'never', '--config.npmRebuild=false']
if (targetFlag === 'win') builderArgs.unshift('--win', 'dir', 'nsis', 'zip')
else if (targetFlag === 'mac') builderArgs.unshift('--mac', 'dir', 'dmg')
else builderArgs.unshift('--linux', targetFlag === 'appimage' ? 'AppImage' : 'dir')

await rm(releaseDir, { recursive: true, force: true })
run(process.execPath, [builderCli, ...builderArgs], packRoot)

if (targetFlag === 'appimage') {
  const images = (await readdir(releaseDir)).filter((name) => name.endsWith('.AppImage'))
  if (images.length === 0) throw new Error(`AppImage missing in ${releaseDir}`)
  process.stdout.write(`packaged ${join(releaseDir, images[0] ?? '')}\n`)
} else if (targetFlag === 'win') {
  const exe = (await readdir(releaseDir)).find((name) => name.endsWith('.exe'))
  const zip = (await readdir(releaseDir)).find((name) => name.endsWith('.zip'))
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
  const bin = join(releaseDir, 'mac', 'DSH Community.app')
  const officialPath = join(releaseDir, 'mac', 'DSH Community.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js')
  if (!await exists(bin)) throw new Error(`packaged executable missing: ${bin}`)
  if (!await exists(officialPath)) throw new Error(`staged official dsh missing: ${officialPath}`)
  process.stdout.write(`packaged ${join(releaseDir, dmg)}\n`)
} else {
  const unpackedRoot = targetFlag === 'win'
    ? join(releaseDir, 'win-unpacked')
    : targetFlag === 'mac'
      ? join(releaseDir, 'mac')
      : join(releaseDir, 'linux-unpacked')
  const bin = targetFlag === 'win'
    ? join(unpackedRoot, 'DSH Community.exe')
    : targetFlag === 'mac'
      ? join(unpackedRoot, 'DSH Community.app')
      : join(unpackedRoot, 'dsh-community')
  const officialPath = targetFlag === 'mac'
    ? join(unpackedRoot, 'DSH Community.app/Contents/Resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js')
    : join(unpackedRoot, 'resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js')
  if (!await exists(bin)) throw new Error(`packaged executable missing: ${bin}`)
  if (!await exists(officialPath)) throw new Error(`staged official dsh missing: ${officialPath}`)
  process.stdout.write(`packaged ${bin}\n`)
  process.stdout.write(`official  ${officialPath}\n`)
}
