import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

function readRepo(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8')
}

describe('multi-agent unified control plane contracts', () => {
  it('exposes multi-agent engine & read-only Git review RPC methods and package exports', async () => {
    const adapterMod = (await import(
      pathToFileURL(join(repoRoot, 'packages/remote-adapter/dist/index.js')).href
    )) as {
      requiredCapability: Record<string, string | undefined>
      parseRemoteRequest: (input: unknown) => { method: string }
    }
    const backendsMod = (await import(
      pathToFileURL(join(repoRoot, 'packages/remote-adapter/dist/backends/index.js')).href
    )) as { MultiAgentHostRouter: unknown }
    const standaloneMod = (await import(
      pathToFileURL(join(repoRoot, 'packages/remote-adapter/dist/standalone-cli.js')).href
    )) as { runStandaloneMultiAgentHost: unknown }

    for (const method of ['engine.list', 'workspace.git.status', 'workspace.git.diff']) {
      expect(adapterMod.requiredCapability[method]).toBe('observe')
      const parsed = adapterMod.parseRemoteRequest({
        jsonrpc: '2.0',
        id: `req-${method}`,
        method,
        protocolVersion: 1,
        connectionEpoch: 1,
        requestSeq: 1,
        params: {},
      })
      expect(parsed.method).toBe(method)
    }

    const pkg = JSON.parse(readRepo('packages/remote-adapter/package.json')) as {
      exports: Record<string, unknown>
    }
    expect(pkg.exports['./backends']).toBeDefined()
    expect(pkg.exports['./standalone-cli']).toBeDefined()
    expect(pkg.exports['./remote-env']).toBeDefined()

    expect(typeof standaloneMod.runStandaloneMultiAgentHost).toBe('function')
    expect(typeof backendsMod.MultiAgentHostRouter).toBe('function')
  })

  it('scrubs remote host secrets from child agent subprocess environments', async () => {
    const backendsMod = (await import(
      pathToFileURL(join(repoRoot, 'packages/remote-adapter/dist/backends/index.js')).href
    )) as {
      sanitizeSubprocessEnv: (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
    }
    const envMod = (await import(
      pathToFileURL(join(repoRoot, 'packages/remote-adapter/dist/remote-env.js')).href
    )) as {
      parseAndScrubRemoteHostEnv: (env?: NodeJS.ProcessEnv) => { controlToken?: string | undefined }
    }
    const secretEnv: NodeJS.ProcessEnv = {
      HOME: '/tmp/dsh-contract-home',
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: 'keep-me',
      DSH_REMOTE_CONTROL_TOKEN: 'secret-control',
      DSH_REMOTE_RELAY_HOST_SECRET: 'secret-relay-host',
      DSH_REMOTE_RELAY_CLIENT_TOKEN: 'secret-relay-client',
      DSH_REMOTE_SIGNALING_HOST_SECRET: 'secret-sig-host',
      DSH_REMOTE_SIGNALING_JOIN_TOKEN: 'secret-sig-join',
    }
    const cleaned = backendsMod.sanitizeSubprocessEnv(secretEnv)
    expect(cleaned.PATH).toBe('/usr/bin')
    expect(cleaned.DEEPSEEK_API_KEY).toBe('keep-me')
    expect(cleaned.DSH_REMOTE_CONTROL_TOKEN).toBeUndefined()
    expect(cleaned.DSH_REMOTE_RELAY_HOST_SECRET).toBeUndefined()
    expect(cleaned.DSH_REMOTE_RELAY_CLIENT_TOKEN).toBeUndefined()
    expect(cleaned.DSH_REMOTE_SIGNALING_HOST_SECRET).toBeUndefined()
    expect(cleaned.DSH_REMOTE_SIGNALING_JOIN_TOKEN).toBeUndefined()

    const hostEnvCopy: NodeJS.ProcessEnv = { ...secretEnv }
    const parsed = envMod.parseAndScrubRemoteHostEnv(hostEnvCopy)
    expect(parsed.controlToken).toBe('secret-control')
    expect(hostEnvCopy.DSH_REMOTE_CONTROL_TOKEN).toBeUndefined()
    expect(hostEnvCopy.DSH_REMOTE_RELAY_HOST_SECRET).toBeUndefined()
    expect(hostEnvCopy.DSH_REMOTE_RELAY_CLIENT_TOKEN).toBeUndefined()
    expect(hostEnvCopy.DSH_REMOTE_SIGNALING_HOST_SECRET).toBeUndefined()
    expect(hostEnvCopy.DSH_REMOTE_SIGNALING_JOIN_TOKEN).toBeUndefined()
  })

  it('keeps Android real-device acceptance gate fail-closed while aligning multi-agent docs', () => {
    const dshApp = readRepo('apps/android/app/src/main/java/org/dsh/community/android/DshApp.kt')
    expect(dshApp).toContain('const val REAL_DEVICE_ACCEPTANCE_READY = false')

    const docChecks: Array<[string, RegExp[]]> = [
      ['ARCHITECTURE.md', [/Multi-Agent/u, /Claude Code/u, /Codex/u, /OpenCode/u, /workspace\.git\.status/u]],
      ['ECOSYSTEM.md', [/MultiAgentHostRouter/u, /Claude Code/u, /workspace\.git\.status/u]],
      ['docs/remote-host-client.md', [/engine\.list/u, /workspace\.git\.diff/u, /MultiAgentRemoteHost/u, /Claude Code/u]],
      ['docs/story.md', [/Multi-Agent/u, /Claude Code/u, /OpenCode/u]],
      ['README.md', [/Multi-Agent/u, /Claude Code/u, /workspace|remote start/u]],
    ]
    for (const [rel, patterns] of docChecks) {
      const content = readRepo(rel)
      for (const re of patterns) {
        expect(content, `${rel} matches ${re}`).toMatch(re)
      }
    }
  })
})
