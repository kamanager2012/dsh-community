import { Buffer } from 'node:buffer'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SMOKE_SCRIPT_PATH = resolve(ROOT, 'scripts/linux-appimage-gui-smoke.mjs')

const {
  findOfficialWebOrigin,
  parseDevToolsWsUrl,
  parseSmokeArgs,
  selectMainShellTarget,
  validateRemotePairingDeepLink,
} = (await import(pathToFileURL(SMOKE_SCRIPT_PATH).href)) as {
  findOfficialWebOrigin: (targets: unknown) => string | undefined
  parseDevToolsWsUrl: (text: string) => string | undefined
  parseSmokeArgs: (argv: string[]) => { executable: string; timeoutMs: number }
  selectMainShellTarget: (targets: unknown) => { webSocketDebuggerUrl?: string } | undefined
  validateRemotePairingDeepLink: (
    deepLink: string,
    pairingJsonText?: string,
  ) => { endpointUrl: string; token: string }
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
      version: 1,
      hostFingerprint: 'fp-abc123',
      hostStaticKey: 'static-key-xyz',
      endpointUrl: 'ws://127.0.0.1:45123/remote',
      token: 'tok-1234567890abcdef',
      expiresAt: Date.now() + 60_000,
    }
    const deepLink = `dsh-remote://pair?data=${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
    const parsed = validateRemotePairingDeepLink(deepLink, JSON.stringify(payload))
    expect(parsed.endpointUrl).toBe(payload.endpointUrl)
    expect(parsed.token).toBe(payload.token)

    expect(() => validateRemotePairingDeepLink('https://evil.example/?data=abc')).toThrow()
    expect(() =>
      validateRemotePairingDeepLink(
        deepLink,
        JSON.stringify({ ...payload, token: 'different-token-value' }),
      ),
    ).toThrow(/Mismatch/)
  })
})
