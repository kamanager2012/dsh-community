import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const MODULE = pathToFileURL(
  resolve(ROOT, 'apps/android/nodejs-project/src/main/js/android-terminal-handle.mjs'),
).href

class FakePty {
  pid = 123
  writes: string[] = []
  kills: string[] = []
  private dataListeners: Array<(data: string) => void> = []
  private exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = []

  onData(listener: (data: string) => void) {
    this.dataListeners.push(listener)
    return { dispose: () => { this.dataListeners = this.dataListeners.filter(x => x !== listener) } }
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.push(listener)
    return { dispose: () => { this.exitListeners = this.exitListeners.filter(x => x !== listener) } }
  }

  write(data: string) {
    this.writes.push(data)
  }

  kill(signal: string) {
    this.kills.push(signal)
    if (signal === 'SIGTERM') {
      for (const listener of [...this.exitListeners]) listener({ exitCode: 0, signal: 0 })
    }
  }

  emitData(data: string) {
    for (const listener of [...this.dataListeners]) listener(data)
  }
}

function fakeInspector() {
  const groupSignals: Array<[number, string]> = []
  return {
    groupSignals,
    foregroundPgid: () => 456,
    isStdinWaiting: () => false,
    snapshot: () => ({
      tree: (pid: number) => pid === 123 ? [{ pid: 123, started: 'root-start' }] : [],
      session: () => [{ pid: 123, started: 'root-start' }],
      alive: (identity: { pid: number; started: string }) =>
        identity.pid === 123 && identity.started === 'root-start',
    }),
    isAlive: (identity: { pid: number; started: string }) =>
      identity.pid === 123 && identity.started === 'root-start',
    signalGroup: (pgid: number, signal: string) => { groupSignals.push([pgid, signal]) },
    signalProcess: () => {},
  }
}

describe('Android terminal handle', () => {
  it('provides ordered output, writes, foreground signalling, and conservative stdin-wait facts', async () => {
    const mod = await import(MODULE) as {
      AndroidTerminalHandle: new (pty: FakePty, inspector: ReturnType<typeof fakeInspector>, graceMs: number) => {
        pid: number
        output: NodeJS.ReadableStream
        done: Promise<{ exitCode: number | null; signal: string | null }>
        write(data: string): Promise<void>
        inspectForeground(): Promise<{ processGroupId: number; inputWaiting: boolean } | undefined>
        signalForeground(signal: string): Promise<number>
        terminate(): Promise<void>
      }
    }
    const pty = new FakePty()
    const inspector = fakeInspector()
    const handle = new mod.AndroidTerminalHandle(pty, inspector, 10)

    let output = ''
    handle.output.on('data', chunk => { output += chunk.toString() })
    pty.emitData('hello')
    await handle.write('echo ok\r')
    expect(pty.writes).toEqual(['echo ok\r'])
    expect(await handle.inspectForeground()).toEqual({
      processGroupId: 456,
      inputWaiting: false,
    })
    await expect(handle.signalForeground('SIGINT')).resolves.toBe(456)
    expect(inspector.groupSignals).toEqual([[456, 'SIGINT']])
    expect(output).toBe('hello')

    const first = handle.terminate()
    const second = handle.terminate()
    expect(second).toBe(first)
    await first
    expect(pty.kills).toEqual(['SIGTERM'])
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
  })

  it('refuses foreground SIGKILL when the terminal shell itself owns the group', async () => {
    const mod = await import(MODULE) as {
      AndroidTerminalHandle: new (pty: FakePty, inspector: ReturnType<typeof fakeInspector>, graceMs: number) => {
        signalForeground(signal: string): Promise<number>
      }
    }
    const pty = new FakePty()
    const inspector = fakeInspector()
    inspector.foregroundPgid = () => 123
    const handle = new mod.AndroidTerminalHandle(pty, inspector, 10)

    await expect(handle.signalForeground('SIGKILL')).rejects.toThrow(
      /refusing to SIGKILL the terminal shell/u,
    )
    expect(inspector.groupSignals).toEqual([])
  })
  it('terminates captured descendants by exact identity before closing the terminal shell', async () => {
    const mod = await import(MODULE) as {
      AndroidTerminalHandle: new (pty: FakePty, inspector: unknown, graceMs: number) => {
        terminate(): Promise<void>
      }
    }
    const pty = new FakePty()
    const alive = new Set(['123:root-start', '222:child-start'])
    const processSignals: Array<[number, string, string]> = []
    const snapshot = () => ({
      tree: (pid: number) => pid === 123
        ? [
            { pid: 222, started: 'child-start' },
            { pid: 123, started: 'root-start' },
          ]
        : [],
      session: () => [
        { pid: 123, started: 'root-start' },
        { pid: 222, started: 'child-start' },
      ],
      alive: (identity: { pid: number; started: string }) =>
        alive.has(`${identity.pid}:${identity.started}`),
    })
    const inspector = {
      foregroundPgid: () => 222,
      isStdinWaiting: () => false,
      snapshot,
      isAlive: (identity: { pid: number; started: string }) =>
        alive.has(`${identity.pid}:${identity.started}`),
      signalGroup: () => {},
      signalProcess: (identity: { pid: number; started: string }, signal: string) => {
        if (!alive.has(`${identity.pid}:${identity.started}`)) return
        processSignals.push([identity.pid, identity.started, signal])
        if (identity.pid === 222) alive.delete('222:child-start')
      },
    }

    const handle = new mod.AndroidTerminalHandle(pty, inspector, 10)
    await handle.terminate()

    expect(processSignals).toEqual([[222, 'child-start', 'SIGTERM']])
    expect(pty.kills).toEqual(['SIGTERM'])
  })

})
