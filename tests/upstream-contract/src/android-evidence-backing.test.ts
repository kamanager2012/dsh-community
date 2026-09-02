import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const validator = resolve(ROOT, 'scripts/validate-android-evidence-backing.mjs')
const sourceState = resolve(ROOT, 'apps/android/evidence/reality-gate.json')
const compatibility = resolve(ROOT, 'apps/android/native-compatibility.json')
const ZERO64 = '0'.repeat(64)
const ONE64 = '1'.repeat(64)

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-android-evidence-'))
  const records = join(root, 'records')
  const state = join(root, 'reality-gate.json')
  mkdirSync(records)
  cpSync(sourceState, state)
  return { root, records, state }
}

function run(state: string, records: string) {
  return spawnSync(process.execPath, [
    validator,
    '--state', state,
    '--records-dir', records,
    '--compatibility', compatibility,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
  })
}

function baseRecord(kind: string) {
  return {
    schemaVersion: 1,
    kind,
    status: 'PASS',
    officialDsh: '0.1.2-alpha.4',
    capturedAt: '2026-09-02T22:45:00+08:00',
    communityCommit: '1'.repeat(40),
    producer: 'manual-real-device-gate',
    artifacts: [{ name: 'transcript', sha256: ZERO64 }],
  }
}

describe('Android evidence backing', () => {
  it('accepts the committed all-unpromoted state with no real-device records', () => {
    const f = fixture()
    try {
      const result = run(f.state, f.records)
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('android-evidence-backing: PASS claims=0 records=0')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('rejects a manually promoted APK carrier claim without carrier-apk backing', () => {
    const f = fixture()
    try {
      const state = JSON.parse(readFileSync(f.state, 'utf8'))
      state.gates.carrier = 'PASS'
      state.nodeCarrier.apkEmbedded.appUidVerified = true
      state.nodeCarrier.apkEmbedded.jniBridgeVerified = true
      state.nodeCarrier.apkEmbedded.sha256 = ONE64
      writeFileSync(f.state, JSON.stringify(state, null, 2))

      const result = run(f.state, f.records)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('carrier-apk: PASS claim has no backing record')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('accepts a promoted APK carrier claim only with exact app-UID shared-lib backing', () => {
    const f = fixture()
    try {
      const state = JSON.parse(readFileSync(f.state, 'utf8'))
      state.gates.carrier = 'PASS'
      state.nodeCarrier.apkEmbedded.appUidVerified = true
      state.nodeCarrier.apkEmbedded.jniBridgeVerified = true
      state.nodeCarrier.apkEmbedded.sha256 = ONE64
      writeFileSync(f.state, JSON.stringify(state, null, 2))

      const record = {
        ...baseRecord('carrier-apk'),
        executionContext: 'APK_APP_UID',
        releaseEvidence: true,
        carrierForm: 'SHARED_LIBNODE',
        buildMode: 'OFFICIAL_NODE_SHARED',
        device: { idHash: ZERO64, apiLevel: 35, abi: 'arm64-v8a' },
        nodeCarrier: {
          version: '22.19.0',
          sourceTag: 'v22.19.0',
          tagObjectSha: 'a9d4750074c7b5439c61daa28ea9afb5dc28e43e',
          sourceCommit: 'f8fe6858549f75a4b4e9633abf39dd2038dbf496',
        },
        checks: { sharedBuild: 'PASS', jniLoad: 'PASS', platform: 'PASS' },
        artifacts: [
          { name: 'libnode', sha256: ONE64 },
          { name: 'transcript', sha256: ZERO64 },
        ],
      }
      writeFileSync(join(f.records, 'carrier-apk.json'), JSON.stringify(record, null, 2))

      const result = run(f.state, f.records)
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('claims=1 records=1')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('does not let adb-shell carrier evidence satisfy the APK carrier gate', () => {
    const f = fixture()
    try {
      const state = JSON.parse(readFileSync(f.state, 'utf8'))
      state.gates.carrier = 'PASS'
      state.nodeCarrier.shellProbe.adbVerified = true
      state.nodeCarrier.shellProbe.sha256 = ONE64
      state.nodeCarrier.apkEmbedded.appUidVerified = false
      state.nodeCarrier.apkEmbedded.jniBridgeVerified = false
      writeFileSync(f.state, JSON.stringify(state, null, 2))

      const shellRecord = {
        ...baseRecord('carrier-shell'),
        executionContext: 'ADB_REAL_DEVICE',
        releaseEvidence: false,
        device: { idHash: ZERO64, apiLevel: 35, abi: 'arm64-v8a' },
        nodeCarrier: {
          version: '22.19.0',
          sourceTag: 'v22.19.0',
          tagObjectSha: 'a9d4750074c7b5439c61daa28ea9afb5dc28e43e',
          sourceCommit: 'f8fe6858549f75a4b4e9633abf39dd2038dbf496',
        },
        artifacts: [
          { name: 'node-shell', sha256: ONE64 },
          { name: 'transcript', sha256: ZERO64 },
        ],
      }
      writeFileSync(join(f.records, 'carrier-shell.json'), JSON.stringify(shellRecord, null, 2))

      const result = run(f.state, f.records)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('carrier-apk: PASS claim has no backing record')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('requires APK app-UID evidence for sandbox/hard-link PASS', () => {
    const f = fixture()
    try {
      const state = JSON.parse(readFileSync(f.state, 'utf8'))
      state.nativeEvidence.sandbox = 'PASS'
      state.nativeEvidence.appPrivateHardlinks = 'PASS'
      writeFileSync(f.state, JSON.stringify(state, null, 2))

      const wrong = {
        ...baseRecord('app-uid-preflight'),
        executionContext: 'ADB_SHELL_REAL_DEVICE',
        device: { idHash: ZERO64, apiLevel: 35, abi: 'arm64-v8a' },
        checks: { hardlink: 'PASS', sandbox: 'PASS' },
        landlockEnforcement: 'full',
      }
      writeFileSync(join(f.records, 'app-uid.json'), JSON.stringify(wrong, null, 2))

      const result = run(f.state, f.records)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('executionContext must be APK_APP_UID')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('does not let a ripgrep record override the unresolved official seam/package blocker', () => {
    const f = fixture()
    try {
      const state = JSON.parse(readFileSync(f.state, 'utf8'))
      state.nativeEvidence.ripgrepPackaging = 'PASS'
      writeFileSync(f.state, JSON.stringify(state, null, 2))

      const record = {
        ...baseRecord('ripgrep'),
        checks: { glob: 'PASS', grep: 'PASS' },
      }
      writeFileSync(join(f.records, 'ripgrep.json'), JSON.stringify(record, null, 2))

      const result = run(f.state, f.records)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(
        'evidence cannot override an unresolved upstream path/package architecture blocker',
      )
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })
})
