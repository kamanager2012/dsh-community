import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const verifier = resolve(ROOT, 'scripts/verify-android-release-ready.mjs')

describe('Android release readiness is fail-closed', () => {
  it('rejects publication while the real-device and native gates remain open', () => {
    const result = spawnSync(process.execPath, [verifier], {
      cwd: ROOT,
      encoding: 'utf8',
      env: process.env,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('android-release-ready: BLOCKED')
    expect(result.stderr).toContain('runtime substrate status=BLOCKED')
    expect(result.stderr).toContain('official CLI package closure status=BLOCKED')
    expect(result.stderr).toContain('carrier candidate status=PROBE_REQUIRED')
    expect(result.stderr).toContain('native blocker subprocess-local status=OPEN')
    expect(result.stderr).toContain('Android compatibility component node-pty status=CROSS_BUILD_PROBE_REQUIRED')
    expect(result.stderr).toContain('Android compatibility component sharp status=LOCKED_WASM_FALLBACK_MATERIALIZATION_AND_DEVICE_PROBE_REQUIRED')
    expect(result.stderr).toContain('Android compatibility component ripgrep status=UPSTREAM_PATH_SEAM_OR_ANDROID_PACKAGE_REQUIRED')
    expect(result.stderr).toContain('Android semantic blocker subprocess-terminal-inspector status=COMMUNITY_PROVIDER_WIRED_NODE_PTY_AND_APP_UID_PROC_PROBE_REQUIRED')
    expect(result.stderr).toContain('Android semantic blocker sandbox-platform-chain status=COMMUNITY_PROVIDER_WIRED_NDK_AND_APP_UID_PROBE_REQUIRED')
    expect(result.stderr).toContain('Android semantic blocker posix-hardlink-publication status=APP_UID_PREFLIGHT_WIRED_REAL_DEVICE_REQUIRED')
    expect(result.stderr).toContain('Android native evidence addonBuildAndLoad=NOT_RUN')
    expect(result.stderr).toContain('Reality Gate status=NOT_RUN')
    expect(result.stderr).toContain('arm64 real-device APK smoke missing')
    expect(result.stderr).toContain('Android app runtime gate is not promoted')
  })

  it('pins release identity to the exact verified Node tag object and commit', () => {
    const source = readFileSync(verifier, 'utf8')
    expect(source).toContain('a9d4750074c7b5439c61daa28ea9afb5dc28e43e')
    expect(source).toContain('f8fe6858549f75a4b4e9633abf39dd2038dbf496')
    expect(source).toContain("const EXPECTED_DSH = '0.1.2-alpha.4'")
    expect(source).toContain("const EXPECTED_NODE = '22.19.0'")
  })

  it('keeps empty Reality Gate evidence explicit rather than inferred', () => {
    const evidence = JSON.parse(
      readFileSync(resolve(ROOT, 'apps/android/evidence/reality-gate.json'), 'utf8'),
    ) as {
      status?: string
      gates?: Record<string, string>
      nodeCarrier?: { deviceVerified?: boolean; sha256?: string | null }
      dshBootVerified?: boolean
      nativeEvidence?: Record<string, string>
      device?: unknown
    }

    expect(evidence.status).toBe('NOT_RUN')
    expect(evidence.gates).toEqual({
      carrier: 'NOT_RUN',
      nativeClosure: 'BLOCKED',
      dshBoot: 'NOT_RUN',
      apk: 'NOT_RUN',
    })
    expect(evidence.nodeCarrier?.deviceVerified).toBe(false)
    expect(evidence.nodeCarrier?.sha256).toBeNull()
    expect(evidence.nativeEvidence).toEqual({
      addonBuildAndLoad: 'NOT_RUN',
      terminalInspector: 'BLOCKED',
      sandbox: 'BLOCKED',
      appPrivateHardlinks: 'NOT_RUN',
      sharpFallback: 'NOT_RUN',
      ripgrepPackaging: 'BLOCKED',
    })
    expect(evidence.dshBootVerified).toBe(false)
    expect(evidence.device).toBeNull()
  })
})
