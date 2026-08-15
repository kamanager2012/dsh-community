import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createOfficialHost } from '../src/host-runtime.ts'
import { resolveOfficialDsh } from '../src/resolve-bin.ts'
import { spawnOfficialWeb } from '../src/spawn-web.ts'

/**
 * Lifecycle smoke: spawn published dsh web, accept the official ready URL,
 * GET the loopback page, shut down. No agent protocol.
 */
describe('official dsh web lifecycle', () => {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-community-smoke-'))
  let host: ReturnType<typeof createOfficialHost> | undefined

  afterAll(async () => {
    if (host !== undefined) await host.shutdown()
  })

  it('starts, serves loopback HTTP, and stops', { timeout: 120_000 }, async () => {
    const install = resolveOfficialDsh({ from: import.meta.url })
    host = createOfficialHost({
      spawn: () => spawnOfficialWeb({
        nodeExecutable: process.execPath,
        cliEntry: install.binPath,
        cwd: isolatedHome,
        env: { ...process.env, DSH_HOME: isolatedHome },
        bind: { host: '127.0.0.1', port: 0 },
      }),
      readinessTimeoutMs: 90_000,
    })

    const origin = await host.start()
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(host.snapshot().phase).toBe('ready')

    const response = await fetch(origin)
    expect(response.ok).toBe(true)
    const body = await response.text()
    expect(body.length).toBeGreaterThan(0)

    await host.shutdown()
    host = undefined
    expect((await fetch(origin).catch((error: unknown) => error)).toString()).toMatch(/fetch|ECONNREFUSED|network/i)
  })
})
