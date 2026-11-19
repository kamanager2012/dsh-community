import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const verifier = resolve(ROOT, 'scripts/verify-android-release-ready.mjs')

describe('Android R5 release readiness is fail-closed', () => {
  it('rejects physical-device promotion until real-device R6 Remote Acceptance passes, while allowing emulator-verified APK builds', () => {
    const result = spawnSync(process.execPath, [verifier], {
      cwd: ROOT,
      encoding: 'utf8',
      env: process.env,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('android-release-ready: BLOCKED')
    expect(result.stderr).toContain('REAL_DEVICE_ACCEPTANCE_READY != true')
    expect(result.stderr).toContain('Reality Gate status=EMULATOR_PASS_NOT_PHYSICAL_ARM64')
    expect(result.stderr).toContain('arm64 real-device APK smoke missing')

    const emuResult = spawnSync(process.execPath, [verifier, '--allow-emulator-verified'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: process.env,
    })
    expect(emuResult.status).toBe(0)
    expect(emuResult.stdout).toContain(
      'android-release-ready: PASS architecture=remote-only host=0.2.2-rc.5 mode=emulator-verified',
    )
  })

  it('keeps R5 Reality Gate schema explicit with verified CI emulator E2EE gates and unpromoted physical arm64 smoke', () => {
    const evidence = JSON.parse(
      readFileSync(resolve(ROOT, 'apps/android/evidence/reality-gate.json'), 'utf8'),
    ) as {
      schemaVersion?: number
      architecture?: string
      asOf?: string
      status?: string
      officialHostTarget?: string
      embeddedNodeRemoved?: boolean
      remoteAcceptance?: Record<string, string>
      apk?: Record<string, unknown>
      device?: Record<string, unknown> | null
    }

    expect(evidence.schemaVersion).toBe(2)
    expect(evidence.architecture).toBe('remote-only')
    expect(evidence.asOf).toBe('2026-11-19')
    expect(evidence.status).toBe('EMULATOR_PASS_NOT_PHYSICAL_ARM64')
    expect(evidence.officialHostTarget).toBe('0.2.2-rc.5')
    expect(evidence.embeddedNodeRemoved).toBe(true)
    expect(evidence.remoteAcceptance).toEqual({
      pairing: 'PASS',
      sessionListAndAttach: 'PASS',
      promptStreaming: 'PASS',
      approvalIdempotency: 'PASS',
      carrierFailover: 'PASS',
      backgroundBattery: 'PASS',
      deviceRevoke: 'PASS',
    })
    expect(evidence.apk).toEqual({
      sha256: '3828892fc1d67f749b5f05173fcef6ca3bcafb6d0b24e96b02534e43a9aee095',
      containsNodeRuntime: false,
      containsOfficialDsh: false,
      arm64RealDeviceSmoke: false,
      x86_64EmulatorSmoke: true,
    })
    expect(evidence.device?.isX86_64Emulator).toBe(true)
    expect(evidence.device?.isPhysicalArm64).toBe(false)
  })
})
