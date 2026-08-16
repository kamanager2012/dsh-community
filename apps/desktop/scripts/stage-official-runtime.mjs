/**
 * Stage the published official CLI as one portable tar.
 * Do not extraResource a pnpm node_modules tree — Windows NSIS dies on
 * tens of thousands of small files.
 */

import { existsSync, lstatSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from './run-command.mjs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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
writeFileSync(join(stageRoot, '.npmrc'), 'node-linker=hoisted\nignore-scripts=true\n')

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

const officialBin = join(stageRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
if (!existsSync(officialBin)) throw new Error(`staged official bin missing: ${officialBin}`)
if (lstatSync(officialBin).isSymbolicLink()) {
  throw new Error(`staged official bin is a symlink: ${officialBin}`)
}

const leaked = ['apps/cli', 'packages/core', 'vendor/deepseek-harness']
const names = await readdir(stageRoot)
const hit = leaked.filter((rel) => names.includes(rel))
if (hit.length > 0) throw new Error(`stage looks like a vendored official tree: ${hit.join(', ')}`)

await rm(extra, { recursive: true, force: true })
await mkdir(extra, { recursive: true })
process.stdout.write('archiving official runtime to a single tar…\n')
runCommand('tar', ['-cf', archive, 'node_modules'], { cwd: stageRoot })
if (!existsSync(archive)) throw new Error(`official dsh archive missing: ${archive}`)
const bytes = statSync(archive).size
if (bytes < 1_000_000) throw new Error(`official dsh archive too small: ${archive} (${String(bytes)} bytes)`)
process.stdout.write(`official dsh archive ${String(bytes)} bytes\n`)

process.stdout.write(`${archive}\n`)
process.stdout.write(`${officialBin}\n`)
