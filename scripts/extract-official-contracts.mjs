/**
 * Snapshot the published official surface. Do not turn this into a community
 * event/type system — compare the next official rc against these files.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'contracts/upstream')
const require = createRequire(join(root, 'packages/dsh-bridge/package.json'))
const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
const manifest = require(manifestPath)
const binPath = join(dirname(manifestPath), manifest.bin.dsh)

function runOfficial(args) {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-community-extract-'))
  return execFileSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, DSH_HOME: isolatedHome },
  })
}

function parseDump(text) {
  const rows = []
  let source
  let current
  for (const line of text.split('\n')) {
    const heading = /^# == (.+)$/.exec(line)
    if (heading) {
      source = heading[1].trim()
      continue
    }
    const id = /^- id: (\S+)$/.exec(line)
    if (id) {
      if (current) rows.push(current)
      current = { id: id[1], source }
      continue
    }
    if (current === undefined) continue
    const name = /^ {2}name: (.+)$/.exec(line)
    if (name) current.name = name[1].trim().replaceAll(/^['"]|['"]$/g, '')
    const disabled = /^ {2}disabled: (\S+)$/.exec(line)
    if (disabled) current.disabled = disabled[1] === 'true'
  }
  if (current) rows.push(current)
  return rows
}

const help = runOfficial(['--help'])
const version = runOfficial(['--version']).trim()
const webHelp = runOfficial(['web', '--help'])
const dump = runOfficial(['web', '--dump-default-config'])
const rows = parseDump(dump)
const packages = [...new Set(rows.map((row) => row.name).filter(Boolean))].sort()

await mkdir(dest, { recursive: true })

const exportsSnapshot = {
  pin: manifest.version,
  packageName: manifest.name,
  version,
  bin: manifest.bin,
  type: manifest.type,
  files: manifest.files ?? [],
}
const cliSnapshot = {
  pin: manifest.version,
  version,
  helpMustContain: ['--profile', '--dump-config', '--dump-default-config', 'web', 'plugin'],
  webHelpMustContain: ['--host', '--port', '--no-open'],
  readinessPrefix: 'dsh web: ',
}
const rowsSnapshot = {
  pin: manifest.version,
  profile: 'web',
  count: rows.length,
  ids: rows.map((row) => row.id),
}
const packagesSnapshot = {
  pin: manifest.version,
  count: packages.length,
  names: packages,
}

await writeFile(join(dest, 'exports.snapshot.json'), `${JSON.stringify(exportsSnapshot, null, 2)}\n`)
await writeFile(join(dest, 'cli.snapshot.json'), `${JSON.stringify(cliSnapshot, null, 2)}\n`)
await writeFile(join(dest, 'config-rows.snapshot.json'), `${JSON.stringify(rowsSnapshot, null, 2)}\n`)
await writeFile(join(dest, 'packages.snapshot.json'), `${JSON.stringify(packagesSnapshot, null, 2)}\n`)

if (!cliSnapshot.helpMustContain.every((token) => help.includes(token))) {
  throw new Error('official --help is missing a snapshotted token')
}
if (!cliSnapshot.webHelpMustContain.every((token) => webHelp.includes(token))) {
  throw new Error('official web --help is missing a snapshotted token')
}

process.stdout.write(`wrote ${dest} for ${manifest.name}@${manifest.version}\n`)
