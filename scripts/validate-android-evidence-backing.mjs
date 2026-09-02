import { readdirSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const EXPECTED_DSH = '0.1.2-alpha.4'
const EXPECTED_NODE = {
  version: '22.19.0',
  sourceTag: 'v22.19.0',
  tagObjectSha: 'a9d4750074c7b5439c61daa28ea9afb5dc28e43e',
  sourceCommit: 'f8fe6858549f75a4b4e9633abf39dd2038dbf496',
}
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u

function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(name + ' requires a value')
  return value
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function fail(errors) {
  process.stderr.write('android-evidence-backing: BLOCKED\n')
  for (const error of errors) process.stderr.write(' - ' + error + '\n')
  process.exit(1)
}

function validTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && Number.isFinite(Date.parse(value))
}

function validateDevice(record, errors) {
  const device = record.device
  if (device === null || typeof device !== 'object') {
    errors.push(`${record.kind}: device identity is required`)
    return
  }
  if (typeof device.idHash !== 'string' || !SHA256.test(device.idHash)) {
    errors.push(`${record.kind}: device.idHash must be a SHA-256 digest, not a raw serial`)
  }
  if (!Number.isInteger(device.apiLevel) || device.apiLevel < 24) {
    errors.push(`${record.kind}: device.apiLevel must be an integer >= 24`)
  }
  if (!['arm64-v8a', 'x86_64'].includes(device.abi)) {
    errors.push(`${record.kind}: device.abi must be arm64-v8a or x86_64`)
  }
}

function validateArtifacts(record, errors) {
  if (!Array.isArray(record.artifacts) || record.artifacts.length === 0) {
    errors.push(`${record.kind}: at least one hashed artifact is required`)
    return
  }
  for (const artifact of record.artifacts) {
    if (artifact === null || typeof artifact !== 'object'
      || typeof artifact.name !== 'string' || artifact.name.length === 0
      || typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256)) {
      errors.push(`${record.kind}: every artifact needs name + SHA-256`)
    }
  }
}

function validateCommon(record, expectedKind, errors) {
  if (record?.schemaVersion !== 1) errors.push(`${expectedKind}: schemaVersion must be 1`)
  if (record?.kind !== expectedKind) errors.push(`${expectedKind}: record.kind mismatch`)
  if (record?.status !== 'PASS') errors.push(`${expectedKind}: record.status must be PASS`)
  if (record?.officialDsh !== EXPECTED_DSH) errors.push(`${expectedKind}: officialDsh must be ${EXPECTED_DSH}`)
  if (!validTimestamp(record?.capturedAt)) errors.push(`${expectedKind}: capturedAt must be offset-aware RFC3339`)
  if (typeof record?.communityCommit !== 'string' || !COMMIT.test(record.communityCommit)) {
    errors.push(`${expectedKind}: communityCommit must be a full Git SHA`)
  }
  if (typeof record?.producer !== 'string' || record.producer.length === 0) {
    errors.push(`${expectedKind}: producer is required`)
  }
  validateArtifacts(record, errors)
}

function artifact(record, name) {
  return record.artifacts?.find(item => item?.name === name)
}

const statePath = resolve(argValue('--state', resolve(ROOT, 'apps/android/evidence/reality-gate.json')))
const recordsDir = resolve(argValue('--records-dir', resolve(ROOT, 'apps/android/evidence/records')))
const compatibilityPath = resolve(argValue(
  '--compatibility',
  resolve(ROOT, 'apps/android/native-compatibility.json'),
))

const state = readJson(statePath)
const compatibility = readJson(compatibilityPath)
const errors = []
const records = new Map()

for (const entry of readdirSync(recordsDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.json')) continue
  const record = readJson(resolve(recordsDir, entry.name))
  const kind = record?.kind
  if (typeof kind !== 'string' || kind.length === 0) {
    errors.push(`${entry.name}: record.kind is required`)
    continue
  }
  if (records.has(kind)) {
    errors.push(`${kind}: duplicate evidence records`)
    continue
  }
  records.set(kind, record)
}

function requireRecord(kind) {
  const record = records.get(kind)
  if (record === undefined) {
    errors.push(`${kind}: PASS claim has no backing record`)
    return undefined
  }
  validateCommon(record, kind, errors)
  return record
}

function validateCarrierShell(record = requireRecord('carrier-shell')) {
  if (record === undefined) return
  validateDevice(record, errors)
  if (record.executionContext !== 'ADB_REAL_DEVICE') {
    errors.push('carrier-shell: executionContext must be ADB_REAL_DEVICE')
  }
  if (record.releaseEvidence !== false) {
    errors.push('carrier-shell: releaseEvidence must be false')
  }
  for (const [key, expected] of Object.entries(EXPECTED_NODE)) {
    if (record.nodeCarrier?.[key] !== expected) errors.push(`carrier-shell: nodeCarrier.${key} mismatch`)
  }
  const carrierArtifact = artifact(record, 'node-shell')
  if (carrierArtifact === undefined) errors.push('carrier-shell: node-shell artifact is required')
  if (state.nodeCarrier?.shellProbe?.adbVerified === true
    && carrierArtifact?.sha256 !== state.nodeCarrier?.shellProbe?.sha256) {
    errors.push('carrier-shell: artifact SHA-256 must equal reality-gate nodeCarrier.shellProbe.sha256')
  }
}

function validateCarrierApk() {
  const record = requireRecord('carrier-apk')
  if (record === undefined) return
  validateDevice(record, errors)
  if (record.executionContext !== 'APK_APP_UID') {
    errors.push('carrier-apk: executionContext must be APK_APP_UID')
  }
  if (record.releaseEvidence !== true) errors.push('carrier-apk: releaseEvidence must be true')
  if (record.buildMode !== 'OFFICIAL_NODE_SHARED') {
    errors.push('carrier-apk: buildMode must be OFFICIAL_NODE_SHARED')
  }
  for (const [key, expected] of Object.entries(EXPECTED_NODE)) {
    if (record.nodeCarrier?.[key] !== expected) errors.push(`carrier-apk: nodeCarrier.${key} mismatch`)
  }
  if (record.carrierForm !== 'SHARED_LIBNODE') errors.push('carrier-apk: carrierForm must be SHARED_LIBNODE')
  if (record.checks?.sharedBuild !== 'PASS') errors.push('carrier-apk: checks.sharedBuild must be PASS')
  if (record.checks?.jniLoad !== 'PASS') errors.push('carrier-apk: checks.jniLoad must be PASS')
  if (record.checks?.platform !== 'PASS') errors.push('carrier-apk: checks.platform must be PASS')
  const carrierArtifact = artifact(record, 'libnode')
  if (carrierArtifact === undefined) errors.push('carrier-apk: libnode artifact is required')
  if (carrierArtifact?.sha256 !== state.nodeCarrier?.apkEmbedded?.sha256) {
    errors.push('carrier-apk: artifact SHA-256 must equal reality-gate nodeCarrier.apkEmbedded.sha256')
  }
}

function validateNativeAddon() {
  const record = requireRecord('native-addon')
  if (record === undefined) return
  validateDevice(record, errors)
  if (record.executionContext !== 'ADB_REAL_DEVICE') {
    errors.push('native-addon: executionContext must be ADB_REAL_DEVICE')
  }
  for (const key of ['nodePty', 'koffi', 'sharpWasm']) {
    if (record.checks?.[key] !== 'PASS') errors.push(`native-addon: checks.${key} must be PASS`)
  }
  for (const name of ['node-pty-addon', 'koffi-addon']) {
    if (artifact(record, name) === undefined) errors.push(`native-addon: ${name} artifact is required`)
  }
}

function validateAppUid() {
  const record = requireRecord('app-uid-preflight')
  if (record === undefined) return
  validateDevice(record, errors)
  if (record.executionContext !== 'APK_APP_UID') {
    errors.push('app-uid-preflight: executionContext must be APK_APP_UID')
  }
  if (record.checks?.hardlink !== 'PASS') errors.push('app-uid-preflight: hardlink must be PASS')
  if (record.checks?.sandbox !== 'PASS') errors.push('app-uid-preflight: sandbox must be PASS')
  if (record.landlockEnforcement !== 'full') {
    errors.push('app-uid-preflight: landlockEnforcement must be full')
  }
}

function validatePtyAppUid() {
  const record = requireRecord('pty-app-uid')
  if (record === undefined) return
  validateDevice(record, errors)
  if (record.executionContext !== 'APK_APP_UID') {
    errors.push('pty-app-uid: executionContext must be APK_APP_UID')
  }
  if (record.preset !== 'minimal') errors.push('pty-app-uid: preset must be minimal')
  if (record.checks?.provider !== 'PASS') errors.push('pty-app-uid: provider must be PASS')
  if (record.checks?.persistentTerminal !== 'PASS') {
    errors.push('pty-app-uid: persistentTerminal must be PASS')
  }
}

function validateRipgrep() {
  const record = requireRecord('ripgrep')
  if (record === undefined) return
  const component = compatibility.components?.find(item => item?.id === 'ripgrep')
  const seam = compatibility.providerSeams?.fsSearch
  if (component?.status !== 'PASS' || seam?.status !== 'PASS') {
    errors.push('ripgrep: evidence cannot override an unresolved upstream path/package architecture blocker')
  }
  if (record.checks?.glob !== 'PASS' || record.checks?.grep !== 'PASS') {
    errors.push('ripgrep: glob and grep must both be PASS')
  }
}

function validateDshBoot() {
  const record = requireRecord('dsh-boot')
  if (record === undefined) return
  validateDevice(record, errors)
  if (record.executionContext !== 'APK_APP_UID') {
    errors.push('dsh-boot: executionContext must be APK_APP_UID')
  }
  if (record.checks?.officialWebBoot !== 'PASS') errors.push('dsh-boot: officialWebBoot must be PASS')
  if (record.loopbackOnly !== true) errors.push('dsh-boot: loopbackOnly must be true')
}

function validateApk(kind, expectedAbi) {
  const record = requireRecord(kind)
  if (record === undefined) return
  validateDevice(record, errors)
  if (record.device?.abi !== expectedAbi) errors.push(`${kind}: device ABI mismatch`)
  if (record.checks?.smoke !== 'PASS') errors.push(`${kind}: checks.smoke must be PASS`)
  const apk = artifact(record, 'apk')
  if (apk === undefined) errors.push(`${kind}: apk artifact is required`)
  if (apk?.sha256 !== state.apk?.sha256) {
    errors.push(`${kind}: APK SHA-256 must equal reality-gate apk.sha256`)
  }
}

if (state.officialDsh !== EXPECTED_DSH) errors.push('reality-gate officialDsh mismatch')

const shellCarrierClaim = state.nodeCarrier?.shellProbe?.adbVerified === true
const shellRecord = records.get('carrier-shell')
if (shellCarrierClaim && shellRecord === undefined) {
  errors.push('carrier-shell: adbVerified has no backing record')
}
if (shellRecord !== undefined) validateCarrierShell(shellRecord)

const carrierClaim = state.gates?.carrier === 'PASS' || state.nodeCarrier?.apkEmbedded?.appUidVerified === true
if (state.gates?.carrier === 'PASS') {
  if (state.nodeCarrier?.apkEmbedded?.appUidVerified !== true) {
    errors.push('carrier: PASS requires nodeCarrier.apkEmbedded.appUidVerified=true')
  }
  if (state.nodeCarrier?.apkEmbedded?.jniBridgeVerified !== true) {
    errors.push('carrier: PASS requires nodeCarrier.apkEmbedded.jniBridgeVerified=true')
  }
}
if (carrierClaim || records.has('carrier-apk')) validateCarrierApk()

const native = state.nativeEvidence ?? {}
if (native.addonBuildAndLoad === 'PASS' || native.sharpFallback === 'PASS') validateNativeAddon()
if (native.sandbox === 'PASS' || native.appPrivateHardlinks === 'PASS') validateAppUid()
if (native.terminalInspector === 'PASS') validatePtyAppUid()
if (native.ripgrepPackaging === 'PASS') validateRipgrep()

if (state.dshBootVerified === true || state.gates?.dshBoot === 'PASS') validateDshBoot()
if (state.apk?.arm64RealDeviceSmoke === true) validateApk('apk-arm64', 'arm64-v8a')
if (state.apk?.x86_64EmulatorSmoke === true) validateApk('apk-x86_64', 'x86_64')

if (state.gates?.nativeClosure === 'PASS') {
  for (const key of [
    'addonBuildAndLoad',
    'terminalInspector',
    'sandbox',
    'appPrivateHardlinks',
    'sharpFallback',
    'ripgrepPackaging',
  ]) {
    if (native[key] !== 'PASS') errors.push(`nativeClosure PASS requires nativeEvidence.${key}=PASS`)
  }
}
if (state.gates?.apk === 'PASS') {
  if (state.apk?.arm64RealDeviceSmoke !== true) errors.push('apk PASS requires arm64 real-device smoke')
  if (state.apk?.x86_64EmulatorSmoke !== true) errors.push('apk PASS requires x86_64 emulator smoke')
  if (typeof state.apk?.sha256 !== 'string' || !SHA256.test(state.apk.sha256)) {
    errors.push('apk PASS requires an APK SHA-256')
  }
}
if (state.status === 'PASS') {
  for (const gate of ['carrier', 'nativeClosure', 'dshBoot', 'apk']) {
    if (state.gates?.[gate] !== 'PASS') errors.push(`overall PASS requires gates.${gate}=PASS`)
  }
}

for (const [kind, record] of records) {
  const recordErrors = []
  validateCommon(record, kind, recordErrors)
  if (recordErrors.length > 0) errors.push(...recordErrors)
}

if (errors.length > 0) fail([...new Set(errors)])

process.stdout.write(
  `android-evidence-backing: PASS claims=${[
    carrierClaim,
    native.addonBuildAndLoad === 'PASS' || native.sharpFallback === 'PASS',
    native.sandbox === 'PASS' || native.appPrivateHardlinks === 'PASS',
    native.terminalInspector === 'PASS',
    native.ripgrepPackaging === 'PASS',
    state.dshBootVerified === true || state.gates?.dshBoot === 'PASS',
    state.apk?.arm64RealDeviceSmoke === true,
    state.apk?.x86_64EmulatorSmoke === true,
  ].filter(Boolean).length} records=${records.size} state=${basename(statePath)}\n`,
)
