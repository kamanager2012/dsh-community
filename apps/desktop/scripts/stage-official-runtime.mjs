/**
 * Stage the published official CLI for packaging.
 * Copies a production deploy of this app's dependencies — never a git checkout
 * of deepseek-ai/deepseek-harness.
 */

import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from './run-command.mjs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = resolve(appRoot, '../..')
const stageRoot = resolve(appRoot, 'runtime-stage')
const forbidden = [
  'apps/cli',
  'apps/web',
  'packages/core',
  'packages/session',
  'packages/agent',
  'packages/llm',
  'packages/bundle',
  'vendor/deepseek-harness',
]

await rm(stageRoot, { recursive: true, force: true })
await mkdir(stageRoot, { recursive: true })

process.stdout.write('staging official @deepseek-ai/dsh via pnpm deploy…\n')
runCommand(
  'pnpm',
  ['--filter', '@dsh-community/desktop', 'deploy', '--prod', '--legacy', stageRoot],
  { cwd: workspace },
)

const names = await readdir(stageRoot)
const leaked = forbidden.filter((rel) => names.includes(rel))
if (leaked.length > 0) {
  throw new Error(`stage looks like a vendored official tree: ${leaked.join(', ')}`)
}

const officialBin = join(stageRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
if (!existsSync(officialBin)) {
  throw new Error(`staged official bin missing: ${officialBin}`)
}

const extra = resolve(appRoot, 'runtime-host')
await rm(extra, { recursive: true, force: true })
await mkdir(join(extra, 'node_modules'), { recursive: true })
await cp(join(stageRoot, 'node_modules'), join(extra, 'node_modules'), { recursive: true })

process.stdout.write(`${officialBin}\n`)
