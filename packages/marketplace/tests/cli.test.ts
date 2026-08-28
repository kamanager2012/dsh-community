import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import type { PluginEntry } from '../src/catalog.ts'
import { fetchCatalog } from '../src/client.ts'
import { runMarketplaceCli, DSH_TESTED_VERSION } from '../src/cli.ts'

const TESTED = DSH_TESTED_VERSION

function catalogWith(plugins: PluginEntry[]): { version: 1; updatedAt: string; plugins: PluginEntry[] } {
  return { version: 1, updatedAt: 'x', plugins }
}

const withIntegrity = (integrity: string) => ({ version: '1.0.0', testedDsh: TESTED, integrity })

const okFetchOf = (body: unknown) => (async () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 })) as unknown as typeof fetch

async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => { chunks.push(args.join(' ')) }
  try {
    const code = await fn()
    return { code, out: chunks.join('\n') }
  } finally {
    console.log = original
  }
}

const highSecurity = {
  risk: 'high' as const,
  requiresConfirmation: true,
  network: 'binds 0.0.0.0',
  dataEgress: 'LAN HTTP',
  credentials: 'none',
  filesystem: 'none extra',
  processExecution: 'none',
  persistence: 'none',
  manualReviewStatus: 'partial' as const,
  manualReviewNote: 'author README',
  lastReviewedAt: '2026-08-28',
}

describe('marketplace cli', () => {
  it('lists plugins with unverified marks', async () => {
    const result = await captureStdout(() => runMarketplaceCli({
      args: ['list'],
      fetchImpl: okFetchOf(catalogWith([{
        name: 'plugin-a', description: 'A 插件', author: 'a',
        repo: 'https://example.com/a', category: 'tool',
        versions: [{ version: '1.0.0', testedDsh: TESTED }, { version: '2.0.0', testedDsh: '0.1.0-rc.9' }],
      }])),
    }))
    assert.equal(result.code, 0)
    assert.match(result.out, /plugin-a/)
    assert.match(result.out, /未验证/)
  })

  it('ignores a lone -- so pnpm extra args still reach the command', async () => {
    const result = await captureStdout(() => runMarketplaceCli({
      args: ['--', 'list'],
      fetchImpl: okFetchOf(catalogWith([{
        name: 'plugin-a', description: 'A 插件', author: 'a',
        repo: 'https://example.com/a', category: 'tool',
        versions: [{ version: '1.0.0', testedDsh: TESTED }],
      }])),
    }))
    assert.equal(result.code, 0)
    assert.match(result.out, /plugin-a/)
  })

  it('rejects unknown commands and missing arguments', async () => {
    const code = await runMarketplaceCli({ args: ['bogus'], fetchImpl: okFetchOf(catalogWith([])) })
    assert.equal(code, 1)
    const codeInfo = await runMarketplaceCli({ args: ['info'], fetchImpl: okFetchOf(catalogWith([])) })
    assert.equal(codeInfo, 1)
    const codeInstall = await runMarketplaceCli({ args: ['install'], fetchImpl: okFetchOf(catalogWith([])) })
    assert.equal(codeInstall, 1)
  })

  it('refuses to install when the registry digest does not match npm', async () => {
    let installCalls = 0
    const code = await runMarketplaceCli({
      args: ['install', 'plugin-a@1.0.0'],
      fetchImpl: okFetchOf(catalogWith([{
        name: 'plugin-a', description: 'A 插件', author: 'a',
        repo: 'https://example.com/a', category: 'tool',
        versions: [withIntegrity('sha512-AAAA')],
      }])),
      npmViewIntegrity: () => 'sha512-BBBB',
      install: () => { installCalls += 1; return { status: 0 } },
    })
    assert.equal(code, 1)
    assert.equal(installCalls, 0)
  })

  it('installs after digest match and passes through installer status', async () => {
    const calls: Array<{ packageName: string; version: string }> = []
    const code = await runMarketplaceCli({
      args: ['install', 'plugin-a'],
      fetchImpl: okFetchOf(catalogWith([{
        name: 'plugin-a', description: 'A 插件', author: 'a',
        repo: 'https://example.com/a', category: 'tool',
        versions: [withIntegrity('sha512-AAAA')],
      }])),
      npmViewIntegrity: () => 'sha512-AAAA',
      install: (opts) => { calls.push(opts); return { status: null } },
    })
    assert.equal(code, 1) // spawn failure (null status) maps to non-zero
    assert.deepEqual(calls, [{ profile: 'dsh-community-tui', packageName: 'plugin-a', version: '1.0.0' }])
  })

  it('installs without registry digest via placeholder path', async () => {
    let called = false
    const code = await runMarketplaceCli({
      args: ['install', 'plugin-a@1.0.0'],
      fetchImpl: okFetchOf(catalogWith([{
        name: 'plugin-a', description: 'A 插件', author: 'a',
        repo: 'https://example.com/a', category: 'tool',
        versions: [{ version: '1.0.0', testedDsh: TESTED }],
      }])),
      npmViewIntegrity: () => undefined,
      install: () => { called = true; return { status: 0 } },
    })
    assert.equal(code, 0)
    assert.equal(called, true)
  })

  it('rejects malformed package names before touching the official chain', async () => {
    let called = false
    const code = await runMarketplaceCli({
      args: ['install', '--flag=value'],
      fetchImpl: okFetchOf(catalogWith([])),
      install: () => { called = true; return { status: 0 } },
    })
    assert.equal(code, 1)
    assert.equal(called, false)
  })

  it('refuses a high-risk install without --yes or confirm', async () => {
    let installCalls = 0
    const code = await runMarketplaceCli({
      args: ['install', 'plugin-a@1.0.0'],
      fetchImpl: okFetchOf(catalogWith([{
        name: 'plugin-a', description: 'A 插件', author: 'a',
        repo: 'https://example.com/a', category: 'tool',
        versions: [{ version: '1.0.0', testedDsh: TESTED, integrity: 'sha512-AAAA', security: highSecurity }],
      }])),
      npmViewIntegrity: () => 'sha512-AAAA',
      install: () => { installCalls += 1; return { status: 0 } },
    })
    assert.equal(code, 1)
    assert.equal(installCalls, 0)
  })

  it('installs a high-risk plugin only after --yes', async () => {
    let installCalls = 0
    const code = await runMarketplaceCli({
      args: ['install', '--yes', 'plugin-a@1.0.0'],
      fetchImpl: okFetchOf(catalogWith([{
        name: 'plugin-a', description: 'A 插件', author: 'a',
        repo: 'https://example.com/a', category: 'tool',
        versions: [{ version: '1.0.0', testedDsh: TESTED, integrity: 'sha512-AAAA', security: highSecurity }],
      }])),
      npmViewIntegrity: () => 'sha512-AAAA',
      install: () => { installCalls += 1; return { status: 0 } },
    })
    assert.equal(code, 0)
    assert.equal(installCalls, 1)
  })

  it('shows registry security on info and prefers it on audit', async () => {
    const catalog = catalogWith([{
      name: 'plugin-a', description: 'A 插件', author: 'a',
      repo: 'https://example.com/a', category: 'tool',
      versions: [{ version: '1.0.0', testedDsh: TESTED, security: highSecurity }],
    }])
    const info = await captureStdout(() => runMarketplaceCli({
      args: ['info', 'plugin-a'],
      fetchImpl: okFetchOf(catalog),
    }))
    assert.equal(info.code, 0)
    assert.match(info.out, /风险 high/)
    const audit = await captureStdout(() => runMarketplaceCli({
      args: ['audit', 'plugin-a'],
      fetchImpl: okFetchOf(catalog),
    }))
    assert.equal(audit.code, 0)
    assert.match(audit.out, /注册表安全披露/)
    assert.doesNotMatch(audit.out, /本地启发式/)
  })
})

describe('client fallback branches', () => {
  const cacheDir = (): { dir: string; cachePath: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'mkt-client-'))
    const cachePath = join(dir, 'catalog.json')
    writeFileSync(cachePath, JSON.stringify(catalogWith([{
      name: 'cached-plugin', description: '缓存插件', author: 'c',
      repo: 'https://example.com/c', category: 'ui',
      versions: [{ version: '1.0.0', testedDsh: TESTED }],
    }])))
    return { dir, cachePath }
  }

  it('falls back to cache on HTTP error', async () => {
    const { dir, cachePath } = cacheDir()
    try {
      const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
      const result = await fetchCatalog({ fetchImpl, cachePath })
      assert.equal(result.source, 'cache')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('falls back to cache on invalid JSON', async () => {
    const { dir, cachePath } = cacheDir()
    try {
      const result = await fetchCatalog({ fetchImpl: okFetchOf('not-json{'), cachePath })
      assert.equal(result.source, 'cache')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('falls back to cache when schema validation fails', async () => {
    const { dir, cachePath } = cacheDir()
    try {
      const bad = catalogWith([{
        name: 'plugin-x', description: '坏分类', author: 'x',
        repo: 'https://example.com/x', category: 'bogus' as PluginEntry['category'],
        versions: [{ version: '1.0.0', testedDsh: TESTED }],
      }])
      const result = await fetchCatalog({ fetchImpl: okFetchOf(bad), cachePath })
      assert.equal(result.source, 'cache')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
