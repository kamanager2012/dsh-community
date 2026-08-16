/**
 * Stage the published official CLI as one portable tar of REAL files.
 *
 * npm's classic node_modules (no symlinks, no virtual store) is the only
 * layout that is both Node-resolvable after extraction and safe for Windows
 * tar extraction. node-pty compiles natively on Linux during install
 * (its postinstall); darwin/win32 ship prebuilds in the npm tarball.
 *
 * v0.1.4 lesson: a tar that only carries @deepseek-ai/dsh and not its deps
 * boots nothing. v0.1.5 lesson: pnpm hoisted still parks deps in .pnpm and
 * symlinks the rest — broken on Windows extraction. Keep it classic.
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

process.stdout.write(`staging official @deepseek-ai/dsh@${pin} with npm (classic node_modules)…\n`)
const installed = spawnSync('npm', [
  'install',
  '--omit=dev',
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
if (installed.status !== 0) throw new Error(`npm install failed (status ${String(installed.status)})`)

const modules = join(stageRoot, 'node_modules')
const officialBin = join(modules, '@deepseek-ai/dsh/lib/bin.js')
if (!existsSync(officialBin)) throw new Error('npm install left no official bin')
if (lstatSync(officialBin).isSymbolicLink()) {
  throw new Error('official bin is a symlink; classic node_modules expected')
}

const required = [
  '@deepseek-ai/dsh/lib/bin.js',
  '@deepseek-ai/dsh-app-boot/package.json',
  'commander/package.json',
]
const missing = required.filter((rel) => !existsSync(join(modules, rel)))
if (missing.length > 0) {
  throw new Error(`staged tree is not resolvable: missing ${missing.join(', ')}`)
}

const ptyPlatform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
const ptyArch = process.arch === 'arm64' ? 'arm64' : 'x64'
const ptyBinary = join(modules, 'node-pty', 'prebuilds', `${ptyPlatform}-${ptyArch}`, 'pty.node')
const ptyCompiled = join(modules, 'node-pty', 'build/Release/pty.node')
if (!existsSync(ptyBinary) && !existsSync(ptyCompiled)) {
  throw new Error(`node-pty binary missing for ${ptyPlatform}-${ptyArch}`)
}

const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { createRequire } from 'node:module'
const require = createRequire(${JSON.stringify(officialBin)})
for (const spec of ['@deepseek-ai/dsh-app-boot', 'commander']) {
  require.resolve(spec)
  process.stdout.write(spec + ' OK\\n')
}
`], { cwd: stageRoot, encoding: 'utf8' })
if (probe.status !== 0) {
  throw new Error(`staged tree cannot resolve dsh imports:\n${probe.stderr || probe.stdout}`)
}
process.stdout.write(probe.stdout ?? '')

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
if (bytes < 80_000_000) {
  throw new Error(`official dsh archive too small to hold the runtime: ${String(bytes)} bytes`)
}
process.stdout.write(`official dsh archive ${String(bytes)} bytes\n`)
process.stdout.write(`${archive}\n`)
process.stdout.write(`${officialBin}\n`)
