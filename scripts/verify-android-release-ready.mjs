import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const EXPECTED_DSH = '0.1.2-alpha.4'
const EXPECTED_NODE = '22.19.0'
const EXPECTED_NODE_TAG = 'v22.19.0'
const EXPECTED_NODE_TAG_OBJECT = 'a9d4750074c7b5439c61daa28ea9afb5dc28e43e'
const EXPECTED_NODE_COMMIT = 'f8fe6858549f75a4b4e9633abf39dd2038dbf496'

function readJson(rel) {
  return JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8'))
}

function fail(reasons) {
  process.stderr.write('android-release-ready: BLOCKED\n')
  for (const reason of reasons) process.stderr.write(' - ' + reason + '\n')
  process.exit(1)
}

const substrate = readJson('apps/android/runtime-substrate.json')
const native = readJson('apps/android/native-blockers.json')
const compatibility = readJson('apps/android/native-compatibility.json')
const evidence = readJson('apps/android/evidence/reality-gate.json')
const app = readFileSync(
  resolve(ROOT, 'apps/android/app/src/main/java/org/dsh/community/android/DshApp.kt'),
  'utf8',
)

const reasons = []

const evidenceBacking = spawnSync(
  process.execPath,
  [resolve(ROOT, 'scripts/validate-android-evidence-backing.mjs')],
  { cwd: ROOT, encoding: 'utf8' },
)
if (evidenceBacking.status !== 0) {
  const detail = (evidenceBacking.stderr || evidenceBacking.stdout || 'unknown evidence-backing failure').trim()
  reasons.push('evidence backing validation failed: ' + detail.replace(/\s+/gu, ' '))
}

if (substrate.status !== 'PASS') reasons.push(`runtime substrate status=${String(substrate.status)}`)
if (substrate.packageClosure?.status !== 'PASS') {
  reasons.push(`official CLI package closure status=${String(substrate.packageClosure?.status)}`)
}
if (substrate.packageClosure?.profileOnlyMitigation !== 'INEFFECTIVE') {
  reasons.push('official CLI package-closure mitigation contract drifted')
}
if (substrate.officialDsh?.version !== EXPECTED_DSH) reasons.push('runtime substrate DSH identity mismatch')
if (substrate.candidate?.status !== 'PASS') reasons.push(`carrier candidate status=${String(substrate.candidate?.status)}`)
if (substrate.candidate?.sourceTag !== EXPECTED_NODE_TAG) reasons.push('Node source tag mismatch')
if (substrate.candidate?.tagObjectSha !== EXPECTED_NODE_TAG_OBJECT) reasons.push('Node tag object mismatch')
if (substrate.candidate?.sourceCommit !== EXPECTED_NODE_COMMIT) reasons.push('Node source commit mismatch')
if (substrate.candidate?.tagSignatureVerifiedByGitHub !== true) reasons.push('Node tag verification evidence missing')

const releaseTarget = native.releaseTarget
if (typeof releaseTarget !== 'string' || releaseTarget === '') reasons.push('native releaseTarget missing')
else if (native[releaseTarget] !== 'PASS') reasons.push(`native release target ${releaseTarget} status=${String(native[releaseTarget])}`)

for (const blocker of native.blockers ?? []) {
  if (blocker.status !== 'RESOLVED') reasons.push(`native blocker ${String(blocker.id)} status=${String(blocker.status)}`)
}

for (const component of compatibility.components ?? []) {
  if (component.status !== 'PASS') {
    reasons.push(`Android compatibility component ${String(component.id)} status=${String(component.status)}`)
  }
}
for (const blocker of compatibility.semanticBlockers ?? []) {
  if (blocker.status !== 'PASS') {
    reasons.push(`Android semantic blocker ${String(blocker.id)} status=${String(blocker.status)}`)
  }
}

if (evidence.status !== 'PASS') reasons.push(`Reality Gate status=${String(evidence.status)}`)
for (const gate of ['carrier', 'nativeClosure', 'dshBoot', 'apk']) {
  if (evidence.gates?.[gate] !== 'PASS') reasons.push(`Reality Gate ${gate}=${String(evidence.gates?.[gate])}`)
}

if (evidence.officialDsh !== EXPECTED_DSH) reasons.push('Reality Gate DSH identity mismatch')
if (evidence.nodeCarrier?.version !== EXPECTED_NODE) reasons.push('Reality Gate Node version mismatch')
if (evidence.nodeCarrier?.sourceTag !== EXPECTED_NODE_TAG) reasons.push('Reality Gate Node tag mismatch')
if (evidence.nodeCarrier?.tagObjectSha !== EXPECTED_NODE_TAG_OBJECT) reasons.push('Reality Gate Node tag object mismatch')
if (evidence.nodeCarrier?.sourceCommit !== EXPECTED_NODE_COMMIT) reasons.push('Reality Gate Node source commit mismatch')
if (evidence.nodeCarrier?.apkEmbedded?.form !== 'SHARED_LIBNODE') {
  reasons.push('APK carrier form must be SHARED_LIBNODE')
}
if (evidence.nodeCarrier?.apkEmbedded?.appUidVerified !== true) {
  reasons.push('APK-embedded Node carrier was not verified under the app UID')
}
if (evidence.nodeCarrier?.apkEmbedded?.jniBridgeVerified !== true) {
  reasons.push('APK Node JNI bridge evidence missing')
}
if (typeof evidence.nodeCarrier?.apkEmbedded?.sha256 !== 'string'
  || !/^[a-f0-9]{64}$/u.test(evidence.nodeCarrier.apkEmbedded.sha256)) {
  reasons.push('APK libnode SHA-256 evidence missing')
}
const nativeEvidence = evidence.nativeEvidence ?? {}
for (const key of [
  'addonBuildAndLoad',
  'terminalInspector',
  'sandbox',
  'appPrivateHardlinks',
  'sharpFallback',
  'ripgrepPackaging',
]) {
  if (nativeEvidence[key] !== 'PASS') reasons.push(`Android native evidence ${key}=${String(nativeEvidence[key])}`)
}
if (evidence.dshBootVerified !== true) reasons.push('official DSH Android boot evidence missing')
if (evidence.device === null || typeof evidence.device !== 'object') reasons.push('real-device identity/evidence missing')
if (evidence.apk?.arm64RealDeviceSmoke !== true) reasons.push('arm64 real-device APK smoke missing')
if (evidence.apk?.x86_64EmulatorSmoke !== true) reasons.push('x86_64 emulator APK smoke missing')
if (typeof evidence.apk?.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(evidence.apk.sha256)) {
  reasons.push('APK SHA-256 evidence missing')
}

if (!/RUNTIME_SUBSTRATE_READY\s*=\s*true/u.test(app)) {
  reasons.push('Android app runtime gate is not promoted')
}

if (reasons.length > 0) fail(reasons)

process.stdout.write(
  `android-release-ready: PASS dsh=${EXPECTED_DSH} node=${EXPECTED_NODE} commit=${EXPECTED_NODE_COMMIT}\n`,
)
