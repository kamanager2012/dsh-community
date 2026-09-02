import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const MODULE = pathToFileURL(
  resolve(ROOT, 'apps/android/nodejs-project/src/main/js/android-process-inspector.mjs'),
).href

function statLine({
  pid,
  parentPid,
  processGroupId,
  sessionId,
  state = 'S',
  foregroundProcessGroupId = processGroupId,
  started,
}: {
  pid: number
  parentPid: number
  processGroupId: number
  sessionId: number
  state?: string
  foregroundProcessGroupId?: number
  started: string
}): string {
  return [
    String(pid),
    '(dsh child)',
    state,
    String(parentPid),
    String(processGroupId),
    String(sessionId),
    '34817',
    String(foregroundProcessGroupId),
    '0', '0', '0', '0', '0', '0', '0', '0',
    '20', '0', '1', '0',
    started,
    '0', '0',
  ].join(' ')
}

describe('Android /proc process inspector', () => {
  it('parses Android/Linux proc stat fields without reading proc memory or syscall state', async () => {
    const mod = await import(MODULE) as {
      parseAndroidProcStat(text: string): {
        pid: number
        parentPid: number
        processGroupId: number
        sessionId: number
        state: string
        foregroundProcessGroupId: number
        started: string
      } | undefined
    }

    expect(mod.parseAndroidProcStat(statLine({
      pid: 41,
      parentPid: 1,
      processGroupId: 41,
      sessionId: 41,
      foregroundProcessGroupId: 72,
      started: '99123',
    }))).toMatchObject({
      pid: 41,
      parentPid: 1,
      processGroupId: 41,
      sessionId: 41,
      state: 'S',
      foregroundProcessGroupId: 72,
      started: '99123',
    })

    expect(mod.parseAndroidProcStat('malformed')).toBeUndefined()
  })

  it('tracks children-first trees, session members, foreground PGID, and PID-reuse identities', async () => {
    const mod = await import(MODULE) as {
      AndroidProcessInspector: new (internals: {
        readFile(path: string): string
        readDir(path: string): string[]
        kill(pid: number, signal: string): void
      }) => {
        foregroundPgid(pid: number): number | undefined
        isStdinWaiting(): boolean
        snapshot(): {
          tree(pid: number): Array<{ pid: number; started: string }>
          session(id: number): Array<{ pid: number; started: string }>
          alive(identity: { pid: number; started: string }): boolean
        }
        isAlive(identity: { pid: number; started: string }): boolean
        signalGroup(pgid: number, signal: string): void
        signalProcess(identity: { pid: number; started: string }, signal: string): void
      }
    }

    const rows = new Map<number, string>([
      [100, statLine({ pid: 100, parentPid: 1, processGroupId: 100, sessionId: 100, foregroundProcessGroupId: 201, started: '1000' })],
      [200, statLine({ pid: 200, parentPid: 100, processGroupId: 201, sessionId: 100, started: '2000' })],
      [201, statLine({ pid: 201, parentPid: 200, processGroupId: 201, sessionId: 100, started: '2010' })],
      [300, statLine({ pid: 300, parentPid: 1, processGroupId: 300, sessionId: 300, state: 'Z', started: '3000' })],
    ])
    const kills: Array<[number, string]> = []
    const inspector = new mod.AndroidProcessInspector({
      readFile(path) {
        const match = /^\/proc\/(\d+)\/stat$/u.exec(path)
        const row = match?.[1] === undefined ? undefined : rows.get(Number(match[1]))
        if (row === undefined) throw new Error('missing proc row')
        return row
      },
      readDir(path) {
        if (path !== '/proc') throw new Error('unexpected directory read')
        return ['self', ...[...rows.keys()].map(String)]
      },
      kill(pid, signal) {
        kills.push([pid, signal])
      },
    })

    expect(inspector.foregroundPgid(100)).toBe(201)
    expect(inspector.isStdinWaiting()).toBe(false)

    const snapshot = inspector.snapshot()
    expect(snapshot.tree(100)).toEqual([
      { pid: 201, started: '2010' },
      { pid: 200, started: '2000' },
      { pid: 100, started: '1000' },
    ])
    expect(snapshot.session(100)).toEqual([
      { pid: 100, started: '1000' },
      { pid: 200, started: '2000' },
      { pid: 201, started: '2010' },
    ])
    expect(snapshot.alive({ pid: 200, started: '2000' })).toBe(true)
    expect(snapshot.alive({ pid: 200, started: 'old' })).toBe(false)
    expect(snapshot.alive({ pid: 300, started: '3000' })).toBe(false)

    inspector.signalGroup(201, 'SIGTERM')
    inspector.signalProcess({ pid: 200, started: '2000' }, 'SIGKILL')
    inspector.signalProcess({ pid: 200, started: 'reused' }, 'SIGKILL')
    expect(kills).toEqual([
      [-201, 'SIGTERM'],
      [200, 'SIGKILL'],
    ])
  })

  it('keeps the implementation free of invasive proc-memory/syscall probing', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(
      resolve(ROOT, 'apps/android/nodejs-project/src/main/js/android-process-inspector.mjs'),
      'utf8',
    )
    expect(source).toContain('isStdinWaiting()')
    expect(source).not.toMatch(/\/proc\/[^'"`]*\/mem/u)
    expect(source).not.toMatch(/\/task\/[^'"`]*\/syscall/u)
  })
})
