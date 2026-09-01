import { describe, expect, it } from 'vitest'
import { READINESS_PREFIX } from '../src/readiness.ts'
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
})
