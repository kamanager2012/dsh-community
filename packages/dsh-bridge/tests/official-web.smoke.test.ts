import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createOfficialHost } from '../src/host-runtime.ts'
import { resolveOfficialDsh } from '../src/resolve-bin.ts'
import { spawnOfficialWeb } from '../src/spawn-web.ts'

/**
 * Lifecycle smoke: spawn published dsh web, exchange alpha.3's process token
 * once for the official signed browser cookie, GET the clean loopback page,
 * then shut down. No agent protocol and no provider/model call.
 */
describe('official dsh web lifecycle', () => {
  const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-community-smoke-'))
  let host: ReturnType<typeof createOfficialHost> | undefined

  afterAll(async () => {
    if (host !== undefined) await host.shutdown()
  })

  it('starts, bootstraps browser auth, serves clean loopback HTTP, and stops', { timeout: 120_000 }, async () => {
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
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    expect(host.snapshot().phase).toBe('ready')

    const bootstrap = host.takeBrowserBootstrapUrl()
    if (bootstrap === undefined) throw new Error('official alpha.3 Web omitted browser bootstrap URL')
    const bootstrapUrl = new URL(bootstrap)
    const token = bootstrapUrl.searchParams.get('token')
    expect(bootstrapUrl.origin).toBe(origin)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(host.takeBrowserBootstrapUrl()).toBeUndefined()
    expect(JSON.stringify(host.snapshot())).not.toContain(token)
    expect(host.logs()).not.toContain(token)

    const exchange = await fetch(bootstrap, { redirect: 'manual' })
    expect(exchange.status).toBe(303)
    expect(exchange.headers.get('location')).toBe('/')
    const setCookie = exchange.headers.get('set-cookie')
    if (setCookie === null) throw new Error('official token exchange omitted Set-Cookie')
    const cookie = setCookie.split(';', 1)[0]
    if (cookie === undefined || cookie.length === 0) {
      throw new Error('official token exchange returned an empty cookie')
    }

    const response = await fetch(origin, { headers: { cookie } })
    expect(response.ok).toBe(true)
    const body = await response.text()
    expect(body.length).toBeGreaterThan(0)

    await host.shutdown()
    host = undefined
    expect((await fetch(origin).catch((error: unknown) => error)).toString())
      .toMatch(/fetch|ECONNREFUSED|network/i)
  })
})
