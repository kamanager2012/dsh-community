import { PassThrough } from 'node:stream'
import { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { READINESS_PREFIX } from '../src/readiness.ts'
import { adaptNodeChild } from '../src/spawn-web.ts'
import { createWebSupervisor } from '../src/supervisor.ts'
import { fakeChild } from './fake-child.ts'

describe('createWebSupervisor', () => {
  it('resolves with the official ready origin', async () => {
    const child = fakeChild()
    const supervisor = createWebSupervisor({ spawnHost: () => child })
    const started = supervisor.start()
    child.emitData(`${READINESS_PREFIX}http://127.0.0.1:4310\n`)
    await expect(started).resolves.toBe('http://127.0.0.1:4310')
    await supervisor.shutdown()
  })


  it('captures the bootstrap credential separately and redacts it from diagnostics', async () => {
    const child = fakeChild()
    const token = 'S'.repeat(43)
    const bootstraps: string[] = []
    let log = ''
    const supervisor = createWebSupervisor({
      spawnHost: () => child,
      onBrowserBootstrapUrl: (url) => {
        bootstraps.push(url)
      },
      log: (chunk) => {
        log += chunk
      },
    })
    const started = supervisor.start()
    child.emitData(`${READINESS_PREFIX}http://127.0.0.1:4311/?to`)
    child.emitData(`ken=${token}\n`)
    await expect(started).resolves.toBe('http://127.0.0.1:4311')
    expect(bootstraps).toEqual([`http://127.0.0.1:4311/?token=${token}`])
    expect(log).toContain('token=<redacted>')
    expect(log).not.toContain(token)
    await supervisor.shutdown()
  })

  it('fails if the child dies before ready', async () => {
    const child = fakeChild()
    const supervisor = createWebSupervisor({ spawnHost: () => child })
    const started = supervisor.start()
    child.emitExit(1)
    await expect(started).rejects.toThrow(/exited before readiness/)
  })

  it('keeps the start failure pending until the doomed child is confirmed dead', async () => {
    const child = fakeChild(4242, { killExits: false })
    const supervisor = createWebSupervisor({
      spawnHost: () => child,
      readinessTimeoutMs: 25,
    })
    const started = supervisor.start()

    await new Promise((resolve) => setTimeout(resolve, 60))
    let settled = false
    void started.catch(() => undefined).then(() => {
      settled = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(child.killedWith).toContain('SIGTERM')

    child.emitExit(0, 'SIGTERM')
    await expect(started).rejects.toThrow(/readiness timed out/)
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(true)
  })

  it('continues draining and redacting stdout/stderr after readiness without pausing pipes', async () => {
    const child = fakeChild()
    const secret = 'T'.repeat(32)
    let log = ''
    const supervisor = createWebSupervisor({
      spawnHost: () => child,
      log: (chunk) => {
        log += chunk
      },
    })
    const started = supervisor.start()
    child.emitData(`${READINESS_PREFIX}http://127.0.0.1:4312\n`)
    await expect(started).resolves.toBe('http://127.0.0.1:4312')

    child.emitData(`post-ready stdout http://127.0.0.1:4312/?token=${secret}\n`)
    child.emitStderr(`post-ready stderr https://localhost:4312/?foo=1&token=${secret}\n`)
    expect(log).toContain('post-ready stdout http://127.0.0.1:4312/?token=<redacted>')
    expect(log).toContain('post-ready stderr https://localhost:4312/?foo=1&token=<redacted>')
    expect(log).not.toContain(secret)
    await supervisor.shutdown()
  })

  it('decodes multi-byte UTF-8 characters split across child stdout chunks without replacement chars', () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const fakeProc = Object.assign(new EventEmitter(), {
      pid: 9999,
      stdout,
      stderr,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    }) as unknown as ChildProcess

    const adapted = adaptNodeChild(fakeProc)
    let received = ''
    adapted.stdout.onData((chunk) => {
      received += chunk
    })

    const utf8 = Buffer.from('你好🚀DSH\n', 'utf8')
    // Cut directly inside the 4-byte emoji sequence (bytes 6..9)
    stdout.write(utf8.subarray(0, 8))
    stdout.write(utf8.subarray(8))
    stdout.end()

    expect(received).toBe('你好🚀DSH\n')
    expect(received).not.toContain('\ufffd')
  })
})
