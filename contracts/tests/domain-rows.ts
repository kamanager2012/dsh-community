import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runOfficial } from '../lib/run-official.ts'
import { parseOfficialDump } from '../lib/parse-dump.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

let cachedIds: string[] | undefined
let cachedDump: string | undefined

export function officialWebDump(): string {
  cachedDump ??= runOfficial(['web', '--dump-default-config'])
  return cachedDump
}

export function officialWebRowIds(): string[] {
  cachedIds ??= parseOfficialDump(officialWebDump()).map((row) => row.id)
  return cachedIds
}

export function domainMustExist(domain: 'session' | 'agent' | 'approval' | 'plugin'): string[] {
  const snap = JSON.parse(readFileSync(join(root, 'contracts/upstream/domains.snapshot.json'), 'utf8')) as {
    readonly [key: string]: { mustExist?: string[] }
  }
  return snap[domain]?.mustExist ?? []
}
