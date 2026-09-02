import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const INSPECTOR = resolve(
  ROOT,
  'apps/android/nodejs-project/src/main/js/android-process-inspector.mjs',
)
const PROVIDER = resolve(
  ROOT,
  'apps/android/nodejs-project/src/main/js/android-subprocess-provider.mjs',
)
const HANDLE = resolve(
  ROOT,
  'apps/android/nodejs-project/src/main/js/android-terminal-handle.mjs',
)
const PATCH = resolve(
  ROOT,
  'apps/android/nodejs-project/src/main/js/android.cordis.patch.yml',
)
const DEVICE_PROBE = resolve(
  ROOT,
  'apps/android/nodejs-project/src/main/js/android-pty-provider-device-probe.mjs',
)

function procStat({
  pid,
  name = 'sh',
  state = 'S',
  parentPid = 1,
  processGroupId = pid,
  sessionId = pid,
  ttyDevice = 34816,
  foregroundGroupId = processGroupId,
  started,
}: {
  pid: number
  name?: string
  state?: string
  parentPid?: number
  processGroupId?: number
  sessionId?: number
  ttyDevice?: number
  foregroundGroupId?: number
  started: string
}): string {
  return [
    `${pid} (${name})`,
    state,
    parentPid,
    processGroupId,
    sessionId,
    ttyDevice,
    foregroundGroupId,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    20, 0, 1, 0,
    started,
  ].join(' ')
}

describe('Android subprocess provider', () => {
  it('keeps provider and provider-level device-probe modules syntax-valid in ordinary CI', () => {
    for (const file of [INSPECTOR, PROVIDER, HANDLE, DEVICE_PROBE]) {
      const result = spawnSync(process.execPath, ['--check', file], {
        cwd: ROOT,
        encoding: 'utf8',
      })
      expect(result.status, `${file}: ${result.stderr}`).toBe(0)
    }
  })

  it('parses Android/Linux proc stat safely when comm contains parentheses', async () => {
    const mod = await import(pathToFileURL(INSPECTOR).href) as {
      parseAndroidProcStat(text: string): {
        pid: number
        parentPid: number
        processGroupId: number
        sessionId: number
        foregroundGroupId: number
        started: string
      } | undefined
    }

    expect(mod.parseAndroidProcStat(procStat({
      pid: 4321,
      name: 'shell (worker)',
      parentPid: 123,
      processGroupId: 4321,
      sessionId: 4321,
      foregroundGroupId: 4333,
      started: '987654',
    }))).toMatchObject({
      pid: 4321,
      parentPid: 123,
      processGroupId: 4321,
      sessionId: 4321,
      foregroundGroupId: 4333,
      started: '987654',
    })
  })

  it('tracks tree/session membership and fences PID reuse before signalling', async () => {
    const files = new Map<string, string>([
      ['/proc/100/stat', procStat({ pid: 100, parentPid: 1, sessionId: 100, started: '1000' })],
      ['/proc/101/stat', procStat({
        pid: 101,
        parentPid: 100,
        processGroupId: 101,
        sessionId: 100,
        foregroundGroupId: 101,
        started: '1001',
      })],
      ['/proc/102/stat', procStat({
        pid: 102,
        parentPid: 1,
        processGroupId: 102,
        sessionId: 100,
        foregroundGroupId: 102,
        started: '1002',
      })],
    ])
    const kills: Array<{ pid: number; signal: string }> = []

    const mod = await import(pathToFileURL(INSPECTOR).href) as {
      AndroidProcessInspector: new (internals: {
        readFile(path: string): string
        readDir(path: string): string[]
        kill(pid: number, signal: string): void
      }) => {
        snapshot(): {
          tree(pid: number): Array<{ pid: number; started: string }>
          session(id: number): Array<{ pid: number; started: string }>
        }
        foregroundPgid(pid: number): number | undefined
        isStdinWaiting(pgid: number, shellPid: number): boolean
        signalGroup(pgid: number, signal: string): void
        signalProcess(identity: { pid: number; started: string }, signal: string): void
      }
    }
    const inspector = new mod.AndroidProcessInspector({
      readFile(path) {
        const value = files.get(path)
        if (value === undefined) throw new Error('ENOENT')
        return value
      },
      readDir(path) {
        if (path !== '/proc') throw new Error('ENOENT')
        return ['self', '100', '101', '102']
      },
      kill(pid, signal) {
        kills.push({ pid, signal })
      },
    })

    const snapshot = inspector.snapshot()
    expect(snapshot.tree(100)).toEqual([
      { pid: 101, started: '1001' },
      { pid: 100, started: '1000' },
    ])
    expect(snapshot.session(100)).toEqual([
      { pid: 100, started: '1000' },
      { pid: 101, started: '1001' },
      { pid: 102, started: '1002' },
    ])
    expect(inspector.foregroundPgid(100)).toBe(100)
    expect(inspector.isStdinWaiting(100, 100)).toBe(false)

    inspector.signalGroup(101, 'SIGINT')
    expect(kills).toContainEqual({ pid: -101, signal: 'SIGINT' })

    inspector.signalProcess({ pid: 101, started: '1001' }, 'SIGTERM')
    expect(kills).toContainEqual({ pid: 101, signal: 'SIGTERM' })

    files.set('/proc/101/stat', procStat({
      pid: 101,
      parentPid: 1,
      processGroupId: 101,
      sessionId: 101,
      started: '9999',
    }))
    const before = kills.length
    inspector.signalProcess({ pid: 101, started: '1001' }, 'SIGKILL')
    expect(kills).toHaveLength(before)
  })

  it('keeps ordinary subprocess semantics in the official local provider and replaces only terminal allocation', () => {
    const provider = readFileSync(PROVIDER, 'utf8')
    const handle = readFileSync(HANDLE, 'utf8')

    expect(provider).toContain("import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'")
    expect(provider).toContain('export class AndroidSubprocessRuntime extends LocalSubprocessRuntime')
    expect(provider).toContain('async spawnTerminal(spec)')
    expect(provider).not.toContain('terminalInspector')
    expect(provider).not.toMatch(/\bspawn\s*\(spec\)/u)
    expect(provider).toContain("requireFromHere.resolve('@deepseek-ai/dsh-subprocess-local/package.json')")
    expect(provider).toContain("requireFromLocalProvider('node-pty')")

    expect(handle).toContain('inputWaiting: this.inspector.isStdinWaiting')
    expect(handle).toContain('refusing to SIGKILL the terminal shell')
    expect(handle).toContain('signalProcess(this.rootIdentity')
    expect(handle).toContain('observed.session(this.sessionId)')
  })

  it('keeps the preliminary device probe on the real Android inspector/handle without claiming app-UID acceptance', () => {
    const probe = readFileSync(DEVICE_PROBE, 'utf8')
    expect(probe).toContain("import { AndroidProcessInspector } from './android-process-inspector.mjs'")
    expect(probe).toContain("import { AndroidTerminalHandle } from './android-terminal-handle.mjs'")
    expect(probe).toContain("await handle.write(\"sleep 30\\n\")")
    expect(probe).toContain("await handle.signalForeground('SIGINT')")
    expect(probe).toContain('DSH_PROVIDER_AFTER_SIGNAL_OK')
    expect(probe).toContain('liveSessionMembers.length !== 0')
    expect(probe).toContain('ANDROID_PTY_PROVIDER_ADB_SHELL_OK_NOT_APP_UID_ACCEPTANCE')
    expect(probe).not.toMatch(/RUNTIME_SUBSTRATE_READY|reality-gate\.json/iu)
  })

  it('patches only execution-world providers and declares no third-party Android direct dependency', () => {
    const patch = readFileSync(PATCH, 'utf8')
    expect(patch).toContain("- id: subprocess")
    expect(patch).toContain("name: '@deepseek-ai/dsh-subprocess-local'")
    expect(patch).toContain('- id: android-subprocess')
    expect(patch).toContain('name: ./android-subprocess-provider.mjs')
    expect(patch).toContain("- id: sandbox")
    expect(patch).toContain('- id: android-sandbox')
    const ids = [...patch.matchAll(/^[ \t]*-[ \t]+id:[ \t]+([a-z0-9-]+)[ \t]*$/gmu)]
      .map(match => match[1])
    expect(ids).toEqual(['subprocess', 'sandbox', 'android-subprocess', 'android-sandbox'])

    const pkg = JSON.parse(
      readFileSync(resolve(ROOT, 'apps/android/nodejs-project/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    expect(pkg.dependencies?.['@deepseek-ai/dsh-subprocess']).toBe('0.1.2-alpha.4')
    expect(pkg.dependencies?.['@deepseek-ai/dsh-subprocess-local']).toBe('0.1.2-alpha.4')
    expect(pkg.dependencies?.['node-pty']).toBeUndefined()
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      expect(name).toMatch(/^@deepseek-ai\//u)
    }
  })
})
