import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveOfficialDsh } from '@dsh-community/dsh-bridge'
import { parseOfficialDump } from '../lib/parse-dump.ts'
import { runOfficial } from '../lib/run-official.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, rel), 'utf8')) as Record<string, unknown>
}

describe('official snapshots stay live', () => {
  it('pins the installed CLI to the exports snapshot', () => {
    const snap = readJson('contracts/upstream/exports.snapshot.json')
    const install = resolveOfficialDsh({ from: import.meta.url })
    expect(install.version).toBe(snap.pin)
    expect(install.packageName).toBe(snap.packageName)
    expect(runOfficial(['--version']).trim()).toBe(snap.version)
  })

  it('matches the official web default config row ids', () => {
    const snap = readJson('contracts/upstream/config-rows.snapshot.json')
    const rows = parseOfficialDump(runOfficial(['web', '--dump-default-config']))
    expect(rows.map((row) => row.id)).toEqual(snap.ids)
  })

  it('matches the official package names mounted by web', () => {
    const snap = readJson('contracts/upstream/packages.snapshot.json')
    const rows = parseOfficialDump(runOfficial(['web', '--dump-default-config']))
    const names = [...new Set(rows.map((row) => row.name).filter(Boolean))].sort()
    expect(names).toEqual(snap.names)
  })
})
