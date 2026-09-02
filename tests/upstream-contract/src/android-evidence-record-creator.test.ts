import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const creator = resolve(ROOT, 'scripts/create-android-evidence-record.mjs')
const validator = resolve(ROOT, 'scripts/validate-android-evidence-backing.mjs')
const sourceState = resolve(ROOT, 'apps/android/evidence/reality-gate.json')
const compatibility = resolve(ROOT, 'apps/android/native-compatibility.json')
const DEVICE_HASH = 'a'.repeat(64)
const COMMIT = 'b'.repeat(40)

function sha256(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-evidence-record-'))
  const records = join(root, 'records')
  mkdirSync(records)
  return { root, records }
}

function commonArgs(kind: string, transcript: string, out: string) {
  return [
    creator,
    '--kind', kind,
    '--transcript', transcript,
    '--out', out,
    '--community-commit', COMMIT,
    '--captured-at', '2026-09-02T22:45:00+08:00',
    '--device-id-hash', DEVICE_HASH,
    '--api-level', '35',
    '--abi', 'arm64-v8a',
  ]
}

describe('Android evidence record creator', () => {
  it('creates preliminary carrier-shell evidence and marks it non-release', () => {
    const f = fixture()
    try {
      const transcript = join(f.root, 'carrier-shell.log')
      const carrier = join(f.root, 'node')
      const out = join(f.records, 'carrier-shell.json')
      writeFileSync(transcript, [
        'android-node22-probe: SOURCE_OK tag=v22.19.0',
        'android-node22-probe: BUILD_OK carrier=/tmp/node',
        'android-node22-probe: DEVICE_OK node=22.19.0 platform=android',
        'android-node22-probe: EVIDENCE_SCOPE=ADB_SHELL_PRELIMINARY_NOT_APK',
      ].join('\n'))
      writeFileSync(carrier, 'node-shell-bytes')

      const result = spawnSync(process.execPath, [
        ...commonArgs('carrier-shell', transcript, out),
        '--artifact', `node-shell=${carrier}`,
      ], { cwd: ROOT, encoding: 'utf8' })

      expect(result.status).toBe(0)
      const record = JSON.parse(readFileSync(out, 'utf8')) as {
        kind?: string
        executionContext?: string
        releaseEvidence?: boolean
        device?: { idHash?: string }
        artifacts?: Array<{ name?: string; sha256?: string }>
        nodeCarrier?: { sourceCommit?: string }
      }
      expect(record).toMatchObject({
        kind: 'carrier-shell',
        executionContext: 'ADB_REAL_DEVICE',
        releaseEvidence: false,
      })
      expect(record.device?.idHash).toBe(DEVICE_HASH)
      expect(record.nodeCarrier?.sourceCommit).toBe('f8fe6858549f75a4b4e9633abf39dd2038dbf496')
      expect(record.artifacts).toContainEqual({ name: 'node-shell', sha256: sha256(carrier) })
      expect(record.artifacts).toContainEqual({ name: 'transcript', sha256: sha256(transcript) })
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('creates carrier-apk evidence only from shared-build plus APK app-UID JNI markers', () => {
    const f = fixture()
    try {
      const transcript = join(f.root, 'carrier-apk.log')
      const libnode = join(f.root, 'libnode.so')
      const out = join(f.records, 'carrier-apk.json')
      writeFileSync(transcript, [
        'android-node22-apk-carrier-probe: PREFLIGHT_OK node=22.19.0 commit=f8fe6858549f75a4b4e9633abf39dd2038dbf496 abi=arm64-v8a api=26',
        'android-node22-apk-carrier-probe: APK_SHARED_BUILD_OK node=22.19.0 abi=arm64-v8a artifact=/tmp/libnode.so',
        'ANDROID_APK_NODE_CARRIER_OK node=22.19.0 platform=android',
      ].join('\n'))
      writeFileSync(libnode, 'libnode-shared-bytes')

      const result = spawnSync(process.execPath, [
        ...commonArgs('carrier-apk', transcript, out),
        '--artifact', `libnode=${libnode}`,
      ], { cwd: ROOT, encoding: 'utf8' })

      expect(result.status).toBe(0)
      expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({
        kind: 'carrier-apk',
        executionContext: 'APK_APP_UID',
        releaseEvidence: true,
        carrierForm: 'SHARED_LIBNODE',
        buildMode: 'OFFICIAL_NODE_SHARED',
        checks: {
          sourceIdentity: 'PASS',
          sharedBuild: 'PASS',
          jniLoad: 'PASS',
          platform: 'PASS',
        },
      })
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('creates an app-UID record only from the embedded preflight PASS payload', () => {
    const f = fixture()
    try {
      const transcript = join(f.root, 'app.log')
      const out = join(f.records, 'app-uid.json')
      writeFileSync(
        transcript,
        '[dsh-android] APP_UID_PREFLIGHT_OK {"schemaVersion":1,"platform":"android","arch":"arm64","hardlink":"PASS","sandbox":"PASS","landlockEnforcement":"full"}\n',
      )

      const result = spawnSync(
        process.execPath,
        commonArgs('app-uid-preflight', transcript, out),
        { cwd: ROOT, encoding: 'utf8' },
      )
      expect(result.status).toBe(0)
      expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({
        kind: 'app-uid-preflight',
        executionContext: 'APK_APP_UID',
        checks: { hardlink: 'PASS', sandbox: 'PASS' },
        landlockEnforcement: 'full',
      })
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('rejects raw device identifiers and unresolved ripgrep evidence', () => {
    const f = fixture()
    try {
      const transcript = join(f.root, 'probe.log')
      writeFileSync(transcript, 'anything')
      const rawDevice = spawnSync(process.execPath, [
        creator,
        '--kind', 'carrier-shell',
        '--transcript', transcript,
        '--out', join(f.records, 'carrier-shell.json'),
        '--community-commit', COMMIT,
        '--captured-at', '2026-09-02T22:45:00+08:00',
        '--device-id-hash', 'SERIAL123',
        '--api-level', '35',
        '--abi', 'arm64-v8a',
      ], { cwd: ROOT, encoding: 'utf8' })
      expect(rawDevice.status).not.toBe(0)
      expect(rawDevice.stderr).toContain('raw device serials are not accepted')

      const ripgrep = spawnSync(
        process.execPath,
        commonArgs('ripgrep', transcript, join(f.records, 'ripgrep.json')),
        { cwd: ROOT, encoding: 'utf8' },
      )
      expect(ripgrep.status).not.toBe(0)
      expect(ripgrep.stderr).toContain('official Android package/path seam is unresolved')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('carrier-apk record satisfies backing only when the APK carrier state is promoted consistently', () => {
    const f = fixture()
    try {
      const transcript = join(f.root, 'carrier-apk.log')
      const libnode = join(f.root, 'libnode.so')
      const out = join(f.records, 'carrier-apk.json')
      const statePath = join(f.root, 'reality-gate.json')
      writeFileSync(transcript, [
        'android-node22-apk-carrier-probe: PREFLIGHT_OK node=22.19.0 commit=f8fe6858549f75a4b4e9633abf39dd2038dbf496 abi=arm64-v8a api=26',
        'android-node22-apk-carrier-probe: APK_SHARED_BUILD_OK',
        'ANDROID_APK_NODE_CARRIER_OK node=22.19.0 platform=android',
      ].join('\n'))
      writeFileSync(libnode, 'verified-libnode-carrier')

      const create = spawnSync(process.execPath, [
        ...commonArgs('carrier-apk', transcript, out),
        '--artifact', `libnode=${libnode}`,
      ], { cwd: ROOT, encoding: 'utf8' })
      expect(create.status).toBe(0)

      const state = JSON.parse(readFileSync(sourceState, 'utf8'))
      state.gates.carrier = 'PASS'
      state.nodeCarrier.apkEmbedded.appUidVerified = true
      state.nodeCarrier.apkEmbedded.jniBridgeVerified = true
      state.nodeCarrier.apkEmbedded.sha256 = sha256(libnode)
      writeFileSync(statePath, JSON.stringify(state, null, 2))

      const validate = spawnSync(process.execPath, [
        validator,
        '--state', statePath,
        '--records-dir', f.records,
        '--compatibility', compatibility,
      ], { cwd: ROOT, encoding: 'utf8' })
      expect(validate.status).toBe(0)
      expect(validate.stderr).toBe('')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('never overwrites an existing evidence record', () => {
    const f = fixture()
    try {
      const transcript = join(f.root, 'app.log')
      const out = join(f.records, 'app-uid.json')
      writeFileSync(
        transcript,
        '[dsh-android] APP_UID_PREFLIGHT_OK {"platform":"android","hardlink":"PASS","sandbox":"PASS","landlockEnforcement":"full"}',
      )
      writeFileSync(out, 'existing-evidence')

      const result = spawnSync(
        process.execPath,
        commonArgs('app-uid-preflight', transcript, out),
        { cwd: ROOT, encoding: 'utf8' },
      )
      expect(result.status).not.toBe(0)
      expect(readFileSync(out, 'utf8')).toBe('existing-evidence')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })
})
