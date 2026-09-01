/**
 * Stage the published official CLI as one portable tar of REAL files.
 *
 * npm's classic node_modules (no symlinks, no virtual store) is the only
 * layout that is both Node-resolvable after extraction and safe for Windows
 * tar extraction. Lifecycle scripts are denied by default during npm ci and
 * then selectively rebuilt from runtime-lock/lifecycle-scripts.json.
 * node-pty may materialize a native binary during that reviewed rebuild;
 * darwin ships prebuilds in the npm tarball; Windows 1.2
 * ships `conpty.node` (not `pty.node`).
 *
 * v0.1.4 lesson: a tar that only carries @deepseek-ai/dsh and not its deps
 * boots nothing. v0.1.5 lesson: pnpm hoisted still parks deps in .pnpm and
 * symlinks the rest — broken on Windows extraction. Keep it classic.
 */

import { copyFileSync, existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
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
const runtimeLockRoot = join(appRoot, 'runtime-lock')
const runtimeManifestPath = join(runtimeLockRoot, 'package.json')
const runtimeLockPath = join(runtimeLockRoot, 'package-lock.json')
const lifecyclePolicyPath = join(runtimeLockRoot, 'lifecycle-scripts.json')
const require = createRequire(join(appRoot, 'package.json'))
const desktopManifest = require('./package.json')
const pin = desktopManifest.dependencies['@deepseek-ai/dsh']
if (typeof pin !== 'string' || pin.length === 0) {
  throw new Error('apps/desktop/package.json is missing @deepseek-ai/dsh')
}

const runtimeManifest = JSON.parse(readFileSync(runtimeManifestPath, 'utf8'))
if (runtimeManifest.dependencies?.['@deepseek-ai/dsh'] !== pin) {
  throw new Error(
    `runtime-lock/package.json pins ${String(runtimeManifest.dependencies?.['@deepseek-ai/dsh'])}; expected ${pin}`,
  )
}
const runtimeLock = JSON.parse(readFileSync(runtimeLockPath, 'utf8'))
if (runtimeLock.lockfileVersion !== 3) {
  throw new Error(`runtime package-lock must use lockfileVersion 3, got ${String(runtimeLock.lockfileVersion)}`)
}
if (runtimeLock.packages?.['']?.dependencies?.['@deepseek-ai/dsh'] !== pin) {
  throw new Error('runtime package-lock root dependency does not match Desktop official pin')
}
const lockedDsh = runtimeLock.packages?.['node_modules/@deepseek-ai/dsh']
if (lockedDsh?.version !== pin || typeof lockedDsh.integrity !== 'string' || typeof lockedDsh.resolved !== 'string') {
  throw new Error('runtime package-lock does not contain the exact official DSH package with registry integrity')
}

const lifecyclePolicy = JSON.parse(readFileSync(lifecyclePolicyPath, 'utf8'))
if (lifecyclePolicy.schemaVersion !== 1 || !Array.isArray(lifecyclePolicy.allowed) || !Array.isArray(lifecyclePolicy.denied)) {
  throw new Error('runtime lifecycle policy must use schemaVersion 1 with allowed/denied arrays')
}

function packageNameFromLockPath(lockPath) {
  const marker = 'node_modules/'
  const index = lockPath.lastIndexOf(marker)
  return index === -1 ? null : lockPath.slice(index + marker.length)
}

const observedLifecycle = Object.entries(runtimeLock.packages ?? {})
  .filter(([, entry]) => entry?.hasInstallScript === true)
  .map(([lockPath, entry]) => {
    const name = packageNameFromLockPath(lockPath)
    if (!name || typeof entry.version !== 'string') {
      throw new Error(`invalid lifecycle-script lock entry: ${lockPath}`)
    }
    return `${name}@${entry.version}`
  })
  .sort()
const reviewedLifecycle = [...lifecyclePolicy.allowed, ...lifecyclePolicy.denied]
  .map((entry) => `${entry.name}@${entry.version}`)
  .sort()
if (JSON.stringify(observedLifecycle) !== JSON.stringify(reviewedLifecycle)) {
  throw new Error(
    `runtime lifecycle-script surface drifted; observed=${observedLifecycle.join(', ')} reviewed=${reviewedLifecycle.join(', ')}`,
  )
}

await rm(stageRoot, { recursive: true, force: true })
await mkdir(stageRoot, { recursive: true })
copyFileSync(runtimeManifestPath, join(stageRoot, 'package.json'))
copyFileSync(runtimeLockPath, join(stageRoot, 'package-lock.json'))

process.stdout.write(
  `staging official @deepseek-ai/dsh@${pin} with npm ci --ignore-scripts from committed package-lock (classic node_modules)…\n`,
)
const nodeOptions = process.env.NODE_OPTIONS ?? ''
const heapFlag = '--max-old-space-size=4096'
const npmEnv = {
  ...process.env,
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  NODE_OPTIONS: nodeOptions.includes('max-old-space-size') ? nodeOptions : `${nodeOptions} ${heapFlag}`.trim(),
}

function runNpm(args, label) {
  const result = spawnSync('npm', args, {
    cwd: stageRoot,
    stdio: 'inherit',
    env: npmEnv,
    shell: process.platform === 'win32',
    windowsHide: true,
  })
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label} failed (status ${String(result.status)})`)
}

runNpm([
  'ci',
  '--ignore-scripts',
  '--omit=dev',
  '--no-fund',
  '--no-audit',
], 'npm ci --ignore-scripts')

for (const entry of lifecyclePolicy.allowed) {
  const manifestPath = join(stageRoot, 'node_modules', entry.name, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`reviewed lifecycle package missing after npm ci: ${entry.name}`)
  }
  const installedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (installedManifest.version !== entry.version) {
    throw new Error(
      `reviewed lifecycle package version drifted: ${entry.name}@${String(installedManifest.version)} expected ${entry.version}`,
    )
  }
  process.stdout.write(`rebuilding reviewed runtime package ${entry.name}@${entry.version}…\n`)
  runNpm([
    'rebuild',
    entry.name,
    '--no-fund',
    '--no-audit',
  ], `npm rebuild ${entry.name}`)
}

const modules = join(stageRoot, 'node_modules')
const officialBin = join(modules, '@deepseek-ai/dsh/lib/bin.js')
if (!existsSync(officialBin)) throw new Error('npm ci left no official bin')
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
const ptyDir = join(modules, 'node-pty', 'prebuilds', `${ptyPlatform}-${ptyArch}`)
const ptyNative = ptyPlatform === 'win32' ? 'conpty.node' : 'pty.node'
const ptyBinary = join(ptyDir, ptyNative)
const ptyCompiled = join(modules, 'node-pty', 'build/Release', ptyNative)
if (!existsSync(ptyBinary) && !existsSync(ptyCompiled)) {
  throw new Error(`node-pty binary missing for ${ptyPlatform}-${ptyArch} (${ptyNative})`)
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
