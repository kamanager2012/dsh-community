import { describe, expect, it } from 'vitest'
import { createOfficialHost } from '../src/host-runtime.ts'
import { READINESS_PREFIX } from '../src/readiness.ts'
import { fakeChild } from './fake-child.ts'

describe('createOfficialHost', () => {
  it('starts, then restarts on a new origin', async () => {
    const host = createOfficialHost({
      spawn: () => {
        const generation = host.snapshot().generation
        const child = fakeChild(10 + generation)
        const port = 4000 + generation
        queueMicrotask(() => {
          child.emitData(`${READINESS_PREFIX}http://127.0.0.1:${String(port)}\n`)
        })
        return child
      },
    })

    await expect(host.start()).resolves.toBe('http://127.0.0.1:4001')
    expect(host.snapshot()).toMatchObject({ phase: 'ready', generation: 1, pid: 11 })
    await expect(host.restart()).resolves.toBe('http://127.0.0.1:4002')
    expect(host.snapshot()).toMatchObject({ phase: 'ready', generation: 2, origin: 'http://127.0.0.1:4002', pid: 12 })
  })

  it('surfaces an unexpected exit as failed so the shell can offer restart', async () => {
    const child = fakeChild()
    const host = createOfficialHost({ spawn: () => child })
    const started = host.start()
    child.emitData(`${READINESS_PREFIX}http://127.0.0.1:4010\n`)
    await started
    child.emitExit(1)
    expect(host.snapshot().phase).toBe('failed')
    if (host.snapshot().phase === 'failed') {
      expect(host.snapshot().error).toMatch(/exited unexpectedly/)
    }
  })

  it('keeps a log buffer and refuses start after shutdown', async () => {
    const child = fakeChild()
    const host = createOfficialHost({ spawn: () => child })
    const started = host.start()
    child.emitStderr('booting\n')
    child.emitData(`${READINESS_PREFIX}http://127.0.0.1:4011\n`)
    await started
    expect(host.logs()).toMatch(/booting/)
    await host.shutdown()
    expect(host.snapshot().phase).toBe('stopped')
    await expect(host.start()).rejects.toThrow(/stopped/)
  })
})
