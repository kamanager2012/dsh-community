/**
 * Stage the published official CLI as one portable tar of real files.
 * Do not extraResource a live pnpm tree — Windows NSIS dies on tens of
 * thousands of tiny files, and Windows tars must not keep symlinks.
 */

import { existsSync, lstatSync, statSync, writeFileSync } from 'node:fs'
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

// pnpm 11, even with node-linker=hoisted, leaves deps in .pnpm and only
// lifts the direct @deepseek-ai/dsh package. Node cannot resolve that after
// extract (v0.1.4: missing @deepseek-ai/dsh-app-boot). npm writes a classic
// node_modules that the official bin can import.
process.stdout.write(`staging official @deepseek-ai/dsh@${pin} with npm (classic node_modules)…\n`)
const installed = spawnSync('npm', [
  'install',
  '--omit=dev',
  '--ignore-scripts',
  '--no-fund',
  '--no-audit',
], {
  cwd: stageRoot,
  stdio: 'inherit',
  env: { ...process.env, npm_config_fund: 'false', npm_config_audit: 'false' },
  shell: process.platform === 'win32',
  windowsHide: true,
})
if (installed.error) throw new Error(`npm install failed: ${installed.error.message}`)
if (!existsSync(join(stageRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))) {
  throw new Error(`npm install left no official bin (status ${String(installed.status)})`)
}
if (installed.status !== 0) {
  throw new Error(`npm install failed (status ${String(installed.status)})`)
}

const ptyDir = join(stageRoot, 'node_modules/node-pty')
if (existsSync(ptyDir)) {
  const ptyPlatform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
  const ptyArch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const prebuilt = join(ptyDir, 'prebuilds', `${ptyPlatform}-${ptyArch}`, 'pty.node')
  const compiled = join(ptyDir, 'build/Release/pty.node')
  if (!existsSync(prebuilt) && !existsSync(compiled)) {
    const workspacePtyEntries = existsSync(join(workspaceRoot, 'node_modules/.pnpm'))
      ? await readdir(join(workspaceRoot, 'node_modules/.pnpm'))
      : []
    const ptyName = workspacePtyEntries.find((name) => name.startsWith('node-pty@'))
    const workspaceBinary = ptyName === undefined
      ? ''
      : join(workspaceRoot, 'node_modules/.pnpm', ptyName, 'node_modules/node-pty/build/Release/pty.node')
    if (workspaceBinary !== '' && existsSync(workspaceBinary)) {
      process.stdout.write('copying compiled node-pty from the workspace…\n')
      await mkdir(join(ptyDir, 'build/Release'), { recursive: true })
      await cp(workspaceBinary, compiled)
    }
  }
}

/**
 * pnpm 11 still parks almost every package in .pnpm even with
 * node-linker=hoisted. Node cannot resolve that store. Lift each
 * package once into a classic node_modules and drop the virtual store.
 */
async function materializeClassicModules(storeModules, destModules) {
  const pnpmDir = join(storeModules, '.pnpm')
  if (!existsSync(pnpmDir)) {
    for (const name of await readdir(storeModules)) {
      if (name.startsWith('.')) continue
      await cp(join(storeModules, name), join(destModules, name), {
        recursive: true,
        dereference: true,
      })
    }
    return
  }
  for (const entry of await readdir(pnpmDir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue
    const inner = join(pnpmDir, entry, 'node_modules')
    if (!existsSync(inner)) continue
    for (const name of await readdir(inner)) {
      if (name.startsWith('.')) continue
      const src = join(inner, name)
      if (name.startsWith('@')) {
        await mkdir(join(destModules, name), { recursive: true })
        for (const pkg of await readdir(src)) {
          const to = join(destModules, name, pkg)
          if (existsSync(to)) continue
          await cp(join(src, pkg), to, { recursive: true, dereference: true })
        }
      } else {
        const to = join(destModules, name)
        if (existsSync(to)) continue
        await cp(src, to, { recursive: true, dereference: true })
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
process.stdout.write('materializing a Node-resolvable node_modules from the pnpm store…\n')
await materializeClassicModules(join(stageRoot, 'node_modules'), flatModules)

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
const required = [
  '@deepseek-ai/dsh/lib/bin.js',
  '@deepseek-ai/dsh-app-boot/package.json',
  'commander/package.json',
]
const missing = required.filter((rel) => !existsSync(join(flatModules, rel)))
if (missing.length > 0) {
  throw new Error(`flattened official tree is not resolvable: missing ${missing.join(', ')}`)
}
const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { createRequire } from 'node:module'
const require = createRequire(${JSON.stringify(officialBin)})
for (const spec of ['@deepseek-ai/dsh-app-boot', 'commander']) {
  require.resolve(spec)
  process.stdout.write(spec + ' OK\\n')
}
`], { cwd: flatRoot, encoding: 'utf8' })
if (probe.status !== 0) {
  throw new Error(`flattened official tree cannot resolve dsh imports:\n${probe.stderr || probe.stdout}`)
}
process.stdout.write(probe.stdout ?? '')
const bytes = statSync(archive).size
if (bytes < 80_000_000) {
  throw new Error(`official dsh archive too small to hold the runtime: ${String(bytes)} bytes`)
}
process.stdout.write(`official dsh archive ${String(bytes)} bytes\n`)
process.stdout.write(`${archive}\n`)
process.stdout.write(`${officialBin}\n`)
