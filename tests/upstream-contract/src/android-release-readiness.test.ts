import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const verifier = resolve(ROOT, 'scripts/verify-android-release-ready.mjs')

describe('Android R5 release readiness is fail-closed', () => {
  it('rejects publication until real-device R6 Remote Acceptance passes', () => {
    const result = spawnSync(process.execPath, [verifier], {
      cwd: ROOT,
      encoding: 'utf8',
      env: process.env,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('android-release-ready: BLOCKED')
    expect(result.stderr).toContain('REAL_DEVICE_ACCEPTANCE_READY != true')
    expect(result.stderr).toContain('Reality Gate status=NOT_RUN')
    expect(result.stderr).toContain('Remote Acceptance pairing=NOT_RUN')
    expect(result.stderr).toContain('Remote Acceptance carrierFailover=NOT_RUN')
    expect(result.stderr).toContain('Remote Acceptance approvalIdempotency=NOT_RUN')
    expect(result.stderr).toContain('Remote Acceptance backgroundBattery=NOT_RUN')
    expect(result.stderr).toContain('Remote Acceptance deviceRevoke=NOT_RUN')
    expect(result.stderr).toContain('arm64 real-device APK smoke missing')
  })

  it('keeps R5 Reality Gate schema explicit rather than inferring PASS', () => {
    const evidence = JSON.parse(
      readFileSync(resolve(ROOT, 'apps/android/evidence/reality-gate.json'), 'utf8'),
    ) as {
      schemaVersion?: number
      architecture?: string
      status?: string
      officialHostTarget?: string
      embeddedNodeRemoved?: boolean
      remoteAcceptance?: Record<string, string>
      apk?: Record<string, unknown>
      device?: unknown
    }

    expect(evidence.schemaVersion).toBe(2)
    expect(evidence.architecture).toBe('remote-only')
    expect(evidence.status).toBe('NOT_RUN')
    expect(evidence.officialHostTarget).toBe('0.2.2-rc.2')
    expect(evidence.embeddedNodeRemoved).toBe(true)
    expect(evidence.remoteAcceptance).toEqual({
      pairing: 'NOT_RUN',
      sessionListAndAttach: 'NOT_RUN',
      promptStreaming: 'NOT_RUN',
      approvalIdempotency: 'NOT_RUN',
      carrierFailover: 'NOT_RUN',
      backgroundBattery: 'NOT_RUN',
      deviceRevoke: 'NOT_RUN',
    })
    expect(evidence.apk).toEqual({
      sha256: null,
      containsNodeRuntime: false,
      containsOfficialDsh: false,
      arm64RealDeviceSmoke: false,
      x86_64EmulatorSmoke: false,
    })
    expect(evidence.device).toBeNull()
  })
})
