import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SMOKE_SCRIPT_PATH = resolve(ROOT, 'scripts/linux-appimage-gui-smoke.mjs')

const {
  findOfficialWebOrigin,
  killProcessTree,
  parseDevToolsWsUrl,
  parseSmokeArgs,
  runAppImageGuiSmoke,
  selectMainShellTarget,
  validateRemotePairingDeepLink,
} = (await import(pathToFileURL(SMOKE_SCRIPT_PATH).href)) as {
  findOfficialWebOrigin: (targets: unknown) => string | undefined
  killProcessTree: (child: unknown, signal?: string, opts?: { forceGroup?: boolean }) => void
  parseDevToolsWsUrl: (text: string) => string | undefined
  parseSmokeArgs: (argv: string[]) => { executable: string; timeoutMs: number }
  runAppImageGuiSmoke: (opts: { executable: string; timeoutMs?: number }) => Promise<void>
  selectMainShellTarget: (targets: unknown) => { webSocketDebuggerUrl?: string } | undefined
  validateRemotePairingDeepLink: (
    deepLink: string,
    pairingJsonText?: string,
  ) => {
    protocolVersion: number
    hostPublicKeyHex: string
    hostFingerprint: string
    bootstrapToken: string
    endpointUrl: string
    expiresAt: number
  }
}

describe('linux-appimage-gui-smoke helpers', () => {
  it('parses CLI executable and bounded timeout arguments', () => {
    expect(parseSmokeArgs(['--executable', '/tmp/squashfs-root/dsh-community', '--timeout-ms', '120000'])).toEqual({
      executable: '/tmp/squashfs-root/dsh-community',
      timeoutMs: 120_000,
    })
    expect(parseSmokeArgs(['--timeout-ms', '100'])).toEqual({
      executable: '',
      timeoutMs: 90_000,
    })
  })

  it('extracts DevTools browser WebSocket URL from Chromium stderr', () => {
    const chunk = '\nDevTools listening on ws://127.0.0.1:41235/devtools/browser/abc-123\nother\n'
    expect(parseDevToolsWsUrl(chunk)).toBe('ws://127.0.0.1:41235/devtools/browser/abc-123')
    expect(parseDevToolsWsUrl('no devtools line here')).toBeUndefined()
  })

  it('selects the main DSH Community shell page target and detects official web origin', () => {
    const shellUrl = `data:text/html;charset=utf-8,${encodeURIComponent('<script>window.dshCommunity?.showRemote()</script>')}`
    const targets = [
      { type: 'page', url: 'http://127.0.0.1:39123/', webSocketDebuggerUrl: 'ws://127.0.0.1:9999/devtools/page/official' },
      { type: 'page', url: shellUrl, webSocketDebuggerUrl: 'ws://127.0.0.1:9999/devtools/page/shell' },
      { type: 'other', url: shellUrl, webSocketDebuggerUrl: 'ws://127.0.0.1:9999/devtools/page/ignored' },
    ]
    expect(selectMainShellTarget(targets)?.webSocketDebuggerUrl).toBe('ws://127.0.0.1:9999/devtools/page/shell')
    expect(findOfficialWebOrigin(targets)).toBe('http://127.0.0.1:39123')
  })

  it('validates pairing deep links and rejects mismatched or incomplete descriptors', () => {
    const payload = {
      protocolVersion: 1,
      hostFingerprint: 'b'.repeat(64),
      hostPublicKeyHex: 'a'.repeat(64),
      endpointUrl: 'ws://127.0.0.1:45123/remote',
      bootstrapToken: 'tok-1234567890abcdef',
      expiresAt: Date.now() + 60_000,
    }
    const encodeLink = (obj: Record<string, unknown>): string =>
      `dsh-remote://pair?data=${Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')}`
    const deepLink = encodeLink(payload)
    const parsed = validateRemotePairingDeepLink(deepLink, JSON.stringify(payload))
    expect(parsed.protocolVersion).toBe(1)
    expect(parsed.endpointUrl).toBe(payload.endpointUrl)
    expect(parsed.bootstrapToken).toBe(payload.bootstrapToken)
    expect(parsed.hostPublicKeyHex).toBe(payload.hostPublicKeyHex)
    expect(parsed.hostFingerprint).toBe(payload.hostFingerprint)

    expect(() => validateRemotePairingDeepLink('https://evil.example/?data=abc')).toThrow()
    expect(() => validateRemotePairingDeepLink(encodeLink({ ...payload, protocolVersion: 0 }))).toThrow(
      /protocolVersion/,
    )
    expect(() => validateRemotePairingDeepLink(encodeLink({ ...payload, hostPublicKeyHex: 'not-hex' }))).toThrow(
      /hostPublicKeyHex/,
    )
    expect(() => validateRemotePairingDeepLink(encodeLink({ ...payload, bootstrapToken: 'short' }))).toThrow(
      /bootstrapToken/,
    )
    expect(() =>
      validateRemotePairingDeepLink(
        deepLink,
        JSON.stringify({ ...payload, bootstrapToken: 'different-token-value-1234' }),
      ),
    ).toThrow(/Mismatch/)
  })

  it('reports pre-launch and early-exit failures with diagnostics and kills orphan stdio grandchildren', async () => {
    await expect(runAppImageGuiSmoke({ executable: '/nonexistent/dsh-community' })).rejects.toThrow(
      /Packaged executable not found/,
    )
    // Passing node as a dummy executable exercises sandbox/env setup, spawn, early-exit capture, and cleanup.
    await expect(runAppImageGuiSmoke({ executable: process.execPath, timeoutMs: 5_000 })).rejects.toThrow(
      /AppImage binary exited early/,
    )

    // Verify a child that spawns a long-lived grandchild holding inherited stdout/stderr does not hang CLI exit.
    const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-smoke-orphan-test-'))
    try {
      const dummyExec = join(tmpDir, 'spawn-orphan.js')
      writeFileSync(
        dummyExec,
        [
          `#!${process.execPath}`,
          "const { spawn } = require('node:child_process')",
          "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })",
          'process.exit(1)',
        ].join('\n'),
        'utf8',
      )
      chmodSync(dummyExec, 0o755)
      killProcessTree(null)
      let orphanErr: { code?: number; stderr?: string } = {}
      const startedAt = Date.now()
      try {
        await execFileAsync(process.execPath, [SMOKE_SCRIPT_PATH, '--executable', dummyExec], { timeout: 10_000 })
        throw new Error('Expected orphan-spawning executable to exit non-zero quickly')
      } catch (error) {
        orphanErr = error as { code?: number; stderr?: string }
      }
      expect(Date.now() - startedAt).toBeLessThan(8_000)
      expect(orphanErr.code).toBe(1)
      expect(String(orphanErr.stderr ?? '')).toContain('AppImage binary exited early')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }

    let stderr = ''
    try {
      await execFileAsync(process.execPath, [SMOKE_SCRIPT_PATH, '--executable', '/nonexistent/dsh-community'])
      throw new Error('Expected CLI invocation with missing executable to exit non-zero')
    } catch (error) {
      const err = error as { code?: number; stderr?: string }
      expect(err.code).toBe(1)
      stderr = String(err.stderr ?? '')
    }
    expect(stderr).toContain('[gui-smoke] FAIL:')
    expect(stderr).toContain('Packaged executable not found')
  })
})
