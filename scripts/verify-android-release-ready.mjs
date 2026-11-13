import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const EXPECTED_HOST_TARGET = '0.2.2-rc.2'

function readJson(rel) {
  return JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8'))
}

function fail(reasons) {
  process.stderr.write('android-release-ready: BLOCKED\n')
  for (const reason of reasons) process.stderr.write(' - ' + reason + '\n')
  process.exit(1)
}

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'build' || entry.name === '.gradle') continue
      walkFiles(full, out)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

const reasons = []

// 1. Embedded Node / local DSH runtime must remain completely removed
if (existsSync(resolve(ROOT, 'apps/android/nodejs-project'))) {
  reasons.push('apps/android/nodejs-project still exists (embedded Node must be removed in R5)')
}

for (const file of walkFiles(resolve(ROOT, 'apps/android'))) {
  if (file.endsWith('.md')) continue
  if (file.endsWith('reality-gate.json')) continue
  const lower = file.toLowerCase()
  if (lower.endsWith('libnode.so') || lower.includes('nodejs-mobile')) {
    reasons.push(`forbidden embedded Node binary/path in apps/android: ${file}`)
  }
  if (file.endsWith('.kt') || file.endsWith('.kts') || file.endsWith('.xml') || file.endsWith('.json')) {
    const content = readFileSync(file, 'utf8')
    if (content.includes('com.github.nodejs-mobile')) {
      reasons.push(`forbidden nodejs-mobile dependency in ${file}`)
    }
    if (content.includes('@deepseek-ai/dsh')) {
      reasons.push(`forbidden @deepseek-ai/dsh package reference in ${file}`)
    }
  }
}

// 2. App entrypoint gate must be promote-ready only on explicit R6 acceptance
const dshAppPath = resolve(ROOT, 'apps/android/app/src/main/java/org/dsh/community/android/DshApp.kt')
const dshApp = readFileSync(dshAppPath, 'utf8')
if (!/REMOTE_CLIENT_MODE\s*=\s*true/u.test(dshApp)) {
  reasons.push('DshApp.REMOTE_CLIENT_MODE is not true')
}
if (!/EMBEDDED_NODE_RUNTIME\s*=\s*false/u.test(dshApp)) {
  reasons.push('DshApp.EMBEDDED_NODE_RUNTIME is not false')
}
if (!/REAL_DEVICE_ACCEPTANCE_READY\s*=\s*true/u.test(dshApp)) {
  reasons.push('Android real-device R6 Remote Acceptance gate is not promoted (REAL_DEVICE_ACCEPTANCE_READY != true)')
}

// 3. Machine-readable R5 remote Reality Gate must be PASS with verified real-device + APK evidence
const evidence = readJson('apps/android/evidence/reality-gate.json')
if (evidence.schemaVersion !== 2) {
  reasons.push(`Reality Gate schemaVersion=${String(evidence.schemaVersion)} (expected 2)`)
}
if (evidence.architecture !== 'remote-only') {
  reasons.push(`Reality Gate architecture=${String(evidence.architecture)} (expected remote-only)`)
}
if (evidence.officialHostTarget !== EXPECTED_HOST_TARGET) {
  reasons.push(`Reality Gate officialHostTarget mismatch: ${String(evidence.officialHostTarget)}`)
}
if (evidence.embeddedNodeRemoved !== true) {
  reasons.push('Reality Gate embeddedNodeRemoved must be true')
}
if (evidence.status !== 'PASS') {
  reasons.push(`Reality Gate status=${String(evidence.status)}`)
}

const remoteAcceptance = evidence.remoteAcceptance ?? {}
for (const gate of [
  'pairing',
  'sessionListAndAttach',
  'promptStreaming',
  'approvalIdempotency',
  'carrierFailover',
  'backgroundBattery',
  'deviceRevoke',
]) {
  if (remoteAcceptance[gate] !== 'PASS') {
    reasons.push(`Remote Acceptance ${gate}=${String(remoteAcceptance[gate])}`)
  }
}

if (evidence.device === null || typeof evidence.device !== 'object') {
  reasons.push('real-device identity/evidence missing')
}
if (evidence.apk?.containsNodeRuntime !== false) {
  reasons.push('APK Node runtime exclusion proof missing')
}
if (evidence.apk?.containsOfficialDsh !== false) {
  reasons.push('APK official DSH exclusion proof missing')
}
if (evidence.apk?.arm64RealDeviceSmoke !== true) {
  reasons.push('arm64 real-device APK smoke missing')
}
if (evidence.apk?.x86_64EmulatorSmoke !== true) {
  reasons.push('x86_64 emulator APK smoke missing')
}
if (typeof evidence.apk?.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(evidence.apk.sha256)) {
  reasons.push('APK SHA-256 evidence missing')
}

if (reasons.length > 0) fail(reasons)

process.stdout.write(
  `android-release-ready: PASS architecture=remote-only host=${EXPECTED_HOST_TARGET}\n`,
)
