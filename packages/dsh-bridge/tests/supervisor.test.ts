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

  it('fails if the child dies before ready', async () => {
    const child = fakeChild()
    const supervisor = createWebSupervisor({ spawnHost: () => child })
    const started = supervisor.start()
    child.emitExit(1)
    await expect(started).rejects.toThrow(/exited before readiness/)
  })
})
