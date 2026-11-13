import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  buildLoopbackPairingWarning,
  composeRemoteHostPatchYaml,
  detectLanIpv4Candidates,
  encodeQrMatrix,
  isPrivateOrTailscaleIpv4,
  liveControlFilePath,
  readLiveControlEndpoint,
  removeOwnLiveControlEndpoint,
  renderQrSvg,
  renderTerminalQr,
  waitForReadyFile,
  writeLiveControlEndpoint,
} from '../src/index.js'

describe('dsh-bridge shared qr and remote-host helpers', () => {
  it('renders crisp CSP-safe SVG QR without inline style attributes and matching dark module runs', () => {
    const payload = 'dshremote://pair?v=1&url=ws%3A%2F%2F192.168.1.42%3A9443&fp=abcdef'
    const matrix = encodeQrMatrix(payload, 'L')
    const quiet = 3
    const expectedTotal = matrix.size + quiet * 2
    const svg = renderQrSvg(payload, {
      eccLevel: 'L',
      quietZone: quiet,
      ariaLabel: 'Pair "<Phone>"',
    })

    expect(svg.startsWith('<svg ')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg).toContain(`viewBox="0 0 ${String(expectedTotal)} ${String(expectedTotal)}"`)
    expect(svg).toContain('aria-label="Pair &quot;&lt;Phone&gt;&quot;"')
    expect(svg).not.toMatch(/\bstyle=/i)

    // Sum horizontal dark run widths from SVG path and verify exact parity with QR matrix.
    const pathMatch = /<path d="([^"]+)"/.exec(svg)
    expect(pathMatch?.[1]).toBeTruthy()
    let svgDarkModules = 0
    for (const run of (pathMatch?.[1] ?? '').matchAll(/h(\d+)v1h-\1z/g)) {
      svgDarkModules += Number(run[1])
    }
    let matrixDarkModules = 0
    for (const row of matrix.modules) {
      for (const cell of row) {
        if (cell) matrixDarkModules += 1
      }
    }
    expect(svgDarkModules).toBe(matrixDarkModules)

    // Invalid CSS/SVG color falls back safely to hex defaults.
    const fallbackSvg = renderQrSvg('hello', { darkColor: 'red;position:fixed', lightColor: 'javascript:1' })
    expect(fallbackSvg).toContain('fill="#ffffff"')
    expect(fallbackSvg).toContain('fill="#101218"')

    expect(renderTerminalQr('hello').length).toBeGreaterThan(20)
  })

  it('composes headless remote host patch YAML without extra dependencies', () => {
    const yaml = composeRemoteHostPatchYaml({
      pluginUrl: 'file:///opt/dsh/remote/cordis-plugin.mjs',
      workspaceRoot: '/home/dev/project',
    })
    expect(yaml).toContain('id: dsh-community-remote')
    expect(yaml).toContain('file:///opt/dsh/remote/cordis-plugin.mjs')
    expect(yaml).toContain('workspaceRoot: "/home/dev/project"')
  })

  it('classifies private RFC1918 and Tailscale CGNAT IPv4 addresses', () => {
    expect(isPrivateOrTailscaleIpv4('192.168.1.5')).toBe(true)
    expect(isPrivateOrTailscaleIpv4('10.0.2.15')).toBe(true)
    expect(isPrivateOrTailscaleIpv4('172.16.0.1')).toBe(true)
    expect(isPrivateOrTailscaleIpv4('172.31.255.254')).toBe(true)
    expect(isPrivateOrTailscaleIpv4('100.64.1.2')).toBe(true)
    expect(isPrivateOrTailscaleIpv4('100.127.255.1')).toBe(true)
    expect(isPrivateOrTailscaleIpv4('172.32.0.1')).toBe(false)
    expect(isPrivateOrTailscaleIpv4('8.8.8.8')).toBe(false)

    const detected = detectLanIpv4Candidates({
      lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: null }],
      eth0: [
        { address: '192.168.50.10', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null },
        { address: '8.8.8.8', netmask: '255.255.255.0', family: 'IPv4', mac: '', internal: false, cidr: null },
      ],
      tailscale0: [
        { address: '100.88.1.7', netmask: '255.192.0.0', family: 'IPv4', mac: '', internal: false, cidr: null },
      ],
    })
    expect(detected).toEqual(['100.88.1.7', '192.168.50.10'])
  })

  it('emits loopback pairing warning only when bound to loopback without relay/signaling fallback', () => {
    expect(buildLoopbackPairingWarning({ lanUrl: 'ws://127.0.0.1:9000' }, ['192.168.1.20'])).toMatch(/192\.168\.1\.20/)
    expect(buildLoopbackPairingWarning({ lanUrl: 'ws://192.168.1.20:9000' }, ['192.168.1.20'])).toBeUndefined()
    expect(
      buildLoopbackPairingWarning({ lanUrl: 'ws://127.0.0.1:9000', relayUrl: 'wss://relay.example.com' }, ['192.168.1.20']),
    ).toBeUndefined()
  })

  it('writes, reads, validates, and cleanly removes live control endpoint metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-ctrl-'))
    try {
      const endpoint = {
        pid: process.pid,
        controlUrl: 'http://127.0.0.1:41234',
        controlToken: 'secret-token-value',
      }
      writeLiveControlEndpoint(dir, endpoint)
      expect(readLiveControlEndpoint(dir)).toEqual(endpoint)

      // Removing with a different pid must not delete our live control file.
      removeOwnLiveControlEndpoint(dir, process.pid + 99999)
      expect(readLiveControlEndpoint(dir)).toEqual(endpoint)

      // Removing with owner pid deletes .control.json cleanly.
      removeOwnLiveControlEndpoint(dir, process.pid)
      expect(readLiveControlEndpoint(dir)).toBeUndefined()

      // Non-loopback or dead-pid control endpoints are ignored.
      writeLiveControlEndpoint(dir, {
        pid: process.pid,
        controlUrl: 'http://192.168.1.50:41234',
        controlToken: 'bad',
      })
      expect(readLiveControlEndpoint(dir)).toBeUndefined()

      // waitForReadyFile rejects immediately when child exits prematurely.
      const fakeChild = new EventEmitter() as unknown as ChildProcess
      const waiting = waitForReadyFile(liveControlFilePath(dir) + '.ready', fakeChild, 5_000)
      fakeChild.emit('exit', 1, null)
      await expect(waiting).rejects.toThrow(/code=1/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
