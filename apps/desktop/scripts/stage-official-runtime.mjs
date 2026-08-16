/**
 * Stage the published official CLI as one portable tar of real files.
 * Do not extraResource a live pnpm tree — Windows NSIS dies on tens of
 * thousands of tiny files, and Windows tars must not keep symlinks.
 */

import { existsSync, lstatSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from './run-command.mjs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = resolve(appRoot, '../..')
const stageRoot = resolve(appRoot, 'runtime-stage')
const extra = resolve(appRoot, 'runtime-host')
const archive = join(extra, 'official-dsh.tar')
const require = createRequire(join(appRoot, 'package.json'))
const desktopManifest = require('./package.json')
const pin = desktopManifest.dependencies['@deepseek-ai/dsh']
if (typeof pin !== 'string' || pin.length === 0) {
  throw new Error('apps/desktop/package.json is missing @deepseek-ai/dsh')
}

await rm(stageRoot, { recursive: true, force: true })
await mkdir(stageRoot, { recursive: true })
writeFileSync(join(stageRoot, 'package.json'), `${JSON.stringify({
  name: 'dsh-community-host',
  private: true,
  dependencies: { '@deepseek-ai/dsh': pin },
}, null, 2)}\n`)
writeFileSync(join(stageRoot, '.npmrc'), 'node-linker=hoisted\n')
writeFileSync(join(stageRoot, 'pnpm-workspace.yaml'), 'onlyBuiltDependencies:\n  - node-pty\n')

process.stdout.write(`staging official @deepseek-ai/dsh@${pin} (hoisted)…\n`)
const installed = spawnSync('pnpm', ['install', '--prod', '--ignore-workspace'], {
  cwd: stageRoot,
  stdio: 'inherit',
  env: { ...process.env, CI: 'true' },
  shell: process.platform === 'win32',
  windowsHide: true,
})
if (installed.error) throw new Error(`pnpm install failed: ${installed.error.message}`)
if (!existsSync(join(stageRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))) {
  throw new Error(`pnpm install left no official bin (status ${String(installed.status)})`)
}
if (installed.status !== 0) {
  process.stdout.write(`pnpm install exited ${String(installed.status)} after placing the tree (ignored native builds are ok)\n`)
}

const ptyStore = join(stageRoot, 'node_modules/.pnpm')
if (existsSync(ptyStore)) {
  const ptyEntries = await readdir(ptyStore)
  const ptyName = ptyEntries.find((name) => name.startsWith('node-pty@'))
  if (ptyName !== undefined) {
    const ptyDir = join(ptyStore, ptyName, 'node_modules/node-pty')
    const ptyPlatform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
    const ptyArch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const prebuilt = join(ptyDir, 'prebuilds', `${ptyPlatform}-${ptyArch}`, 'pty.node')
    const compiled = join(ptyDir, 'build/Release/pty.node')
    if (!existsSync(prebuilt) && !existsSync(compiled)) {
      const workspacePty = join(workspaceRoot, 'node_modules/.pnpm', ptyName, 'node_modules/node-pty')
      const workspaceBinary = join(workspacePty, 'build/Release/pty.node')
      if (existsSync(workspaceBinary)) {
        process.stdout.write('copying compiled node-pty from the workspace…\n')
        await mkdir(join(ptyDir, 'build/Release'), { recursive: true })
        await cp(workspaceBinary, compiled)
      }
    }
  }
}

const leaked = ['apps/cli', 'packages/core', 'vendor/deepseek-harness']
const names = await readdir(stageRoot)
const hit = leaked.filter((rel) => names.includes(rel))
if (hit.length > 0) throw new Error(`stage looks like a vendored official tree: ${hit.join(', ')}`)

const flatRoot = join(stageRoot, 'flat')
const flatModules = join(flatRoot, 'node_modules')
await mkdir(flatModules, { recursive: true })
process.stdout.write('flattening staged node_modules (no symlinks)…\n')
for (const name of await readdir(join(stageRoot, 'node_modules'))) {
  if (name === '.pnpm' || name.startsWith('.')) continue
  await cp(join(stageRoot, 'node_modules', name), join(flatModules, name), {
    recursive: true,
    dereference: true,
  })
}

const officialBin = join(flatModules, '@deepseek-ai/dsh/lib/bin.js')
if (!existsSync(officialBin)) throw new Error(`flattened official bin missing: ${officialBin}`)
if (lstatSync(officialBin).isSymbolicLink()) {
  throw new Error(`flattened official bin is still a symlink: ${officialBin}`)
}

await rm(extra, { recursive: true, force: true })
await mkdir(extra, { recursive: true })
process.stdout.write('archiving official runtime to a single tar…\n')
runCommand('tar', ['-cf', archive, 'node_modules'], { cwd: flatRoot })
if (!existsSync(archive)) throw new Error(`official dsh archive missing: ${archive}`)

const listed = runCommand('tar', ['-tf', archive, 'node_modules/@deepseek-ai'], {
  cwd: extra,
  stdio: 'pipe',
  encoding: 'utf8',
  maxBuffer: 256 * 1024,
})
const listing = String(listed.stdout ?? '')
if (!listing.includes('@deepseek-ai/dsh')) {
  throw new Error('official dsh archive does not contain @deepseek-ai/dsh')
}

process.stdout.write(`${archive}\n`)
process.stdout.write(`${officialBin}\n`)
