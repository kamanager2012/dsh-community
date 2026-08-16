/**
 * Stage the published official CLI as one portable tar.
 * Do not extraResource a pnpm node_modules tree — Windows NSIS dies on
 * tens of thousands of small files.
 */

import { existsSync, lstatSync, realpathSync, writeFileSync } from 'node:fs'
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

if (process.platform === 'win32') {
  /**
   * pnpm's hoisted linker creates symlinks on Windows CI, which need
   * Developer Mode. Copy the already-installed workspace package with
   * symlinks dereferenced instead — no links survive into the tar.
   */
  const workspaceInstall = realpathSync(join(appRoot, 'node_modules/@deepseek-ai/dsh'))
  await mkdir(join(stageRoot, 'node_modules/@deepseek-ai'), { recursive: true })
  process.stdout.write(`copying official @deepseek-ai/dsh@${pin} (dereferenced)…\n`)
  await cp(workspaceInstall, join(stageRoot, 'node_modules/@deepseek-ai/dsh'), {
    recursive: true,
    dereference: true,
  })
} else {
  /**
   * node-pty only ships prebuilds for darwin/win32; on Linux its install
   * script compiles pty.node from source. Allow exactly that one build.
   */
  writeFileSync(join(stageRoot, '.npmrc'), 'node-linker=hoisted\n')
  writeFileSync(join(stageRoot, 'pnpm-workspace.yaml'), 'onlyBuiltDependencies:\n  - node-pty\n')
  writeFileSync(join(stageRoot, 'package.json'), `${JSON.stringify({
    name: 'dsh-community-host',
    private: true,
    dependencies: { '@deepseek-ai/dsh': pin },
  }, null, 2)}\n`)
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
    process.stdout.write(`pnpm install exited ${String(installed.status)} after placing the tree (ignored builds are expected)\n`)
  }
  const ptyEntries = await readdir(join(stageRoot, 'node_modules/.pnpm'))
  const ptyName = ptyEntries.find((name) => name.startsWith('node-pty@'))
  if (ptyName === undefined) throw new Error('node-pty missing from the staged tree')
  const ptyDir = join(stageRoot, 'node_modules/.pnpm', ptyName, 'node_modules/node-pty')
  const ptyPlatform = process.platform === 'darwin' ? 'darwin' : 'linux'
  const ptyArch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const ptyBinary = join(ptyDir, 'prebuilds', `${ptyPlatform}-${ptyArch}`, 'pty.node')
  if (!existsSync(ptyBinary)) {
    /**
     * Linux pty.node is compiled during the workspace install (dev deps
     * provide node-gyp). The --prod stage cannot rebuild it, so copy the
     * already-compiled binary from the workspace virtual store.
     */
    const workspacePty = join(workspaceRoot, 'node_modules/.pnpm', ptyName, 'node_modules/node-pty')
    const workspaceBinary = join(workspacePty, 'build/Release/pty.node')
    if (existsSync(workspaceBinary)) {
      process.stdout.write('copying compiled node-pty from the workspace…\n')
      await mkdir(join(ptyDir, 'build/Release'), { recursive: true })
      await cp(workspaceBinary, join(ptyDir, 'build/Release/pty.node'))
    }
    if (!existsSync(ptyBinary) && !existsSync(join(ptyDir, 'build/Release/pty.node'))) {
      throw new Error(`node-pty binary missing for ${ptyPlatform}-${ptyArch}`)
    }
  }
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

// pnpm stores real packages under node_modules/.pnpm and links top-level names.
// List the @deepseek-ai subtree so the check works for both real and link entries.
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
