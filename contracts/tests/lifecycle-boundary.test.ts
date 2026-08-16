import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DESKTOP_IPC_KEYS, LIFECYCLE_IPC_KEYS } from '../../apps/desktop/src/ipc-channels.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

const FORBIDDEN_PROTOCOL = [
  'agent/running',
  'agent/idle',
  'tool/start',
  'tool/end',
  'session/changed',
  'approval/request',
  'provider/status',
  'stdout JSON Lines',
  'Desktop Runtime Protocol',
]

function walk(dir: string, into: string[]): void {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === 'node_modules' || name.name === 'dist' || name.name === 'runtime-stage' || name.name === 'runtime-host') continue
    const full = join(dir, name.name)
    if (name.isDirectory()) walk(full, into)
    else if (name.isFile()) into.push(full)
  }
}

describe('do not invent a Desktop runtime protocol', () => {
  it('IPC is lifecycle-only', () => {
    expect([...LIFECYCLE_IPC_KEYS]).toEqual([
      'dsh:lifecycle:restart',
      'dsh:lifecycle:snapshot',
      'dsh:lifecycle:diagnostics',
      'dsh:lifecycle:open-official',
      'dsh:lifecycle:marketplace-refresh',
    ])
    expect([...DESKTOP_IPC_KEYS].every((key) => key.startsWith('dsh:desktop:'))).toBe(true)
    expect(DESKTOP_IPC_KEYS.join('\n')).not.toMatch(/agent|tool\/|approval/)
  })

  it('does not parse agent/tool/session business out of stdout', () => {
    const files: string[] = []
    walk(join(root, 'apps/desktop/src'), files)
    walk(join(root, 'packages/dsh-bridge/src'), files)
    const hits = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return FORBIDDEN_PROTOCOL.filter((token) => text.includes(token)).map((token) => `${file}:${token}`)
    })
    expect(hits).toEqual([])
  })

  it('does not keep a forked event-types.ts', () => {
    const files: string[] = []
    walk(root, files)
    const forks = files.filter((file) => file.endsWith('event-types.ts'))
    expect(forks).toEqual([])
  })
})
