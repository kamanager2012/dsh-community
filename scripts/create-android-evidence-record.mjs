import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
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
const VALID_ABI = new Set(['arm64-v8a', 'x86_64'])

function values(name) {
  const found = []
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] !== name) continue
    const value = process.argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(name + ' requires a value')
    found.push(value)
  }
  return found
}

function value(name, fallback) {
  const found = values(name)
  if (found.length > 1) throw new Error(name + ' may be provided only once')
  return found[0] ?? fallback
}

function required(name) {
  const found = value(name)
  if (found === undefined || found === '') throw new Error(name + ' is required')
  return found
}

function sha256File(path) {
  const bytes = readFileSync(path)
  return createHash('sha256').update(bytes).digest('hex')
}

function timestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new Error('--captured-at must be offset-aware RFC3339')
  }
  return value
}

function device() {
  const idHash = required('--device-id-hash')
  if (!SHA256.test(idHash)) {
    throw new Error('--device-id-hash must be a 64-hex SHA-256 digest; raw device serials are not accepted')
  }
  const apiLevel = Number(required('--api-level'))
  if (!Number.isInteger(apiLevel) || apiLevel < 24) throw new Error('--api-level must be an integer >= 24')
  const abi = required('--abi')
  if (!VALID_ABI.has(abi)) throw new Error('--abi must be arm64-v8a or x86_64')
  return { idHash, apiLevel, abi }
}

function transcript() {
  const path = resolve(required('--transcript'))
  if (!statSync(path).isFile()) throw new Error('--transcript must name a file')
  return { path, text: readFileSync(path, 'utf8'), sha256: sha256File(path) }
}

function artifactMap(transcriptArtifact) {
  const artifacts = [{ name: 'transcript', sha256: transcriptArtifact.sha256 }]
  const names = new Set(['transcript'])
  for (const spec of values('--artifact')) {
    const eq = spec.indexOf('=')
    if (eq <= 0 || eq === spec.length - 1) {
      throw new Error('--artifact must be name=/absolute/or/relative/path')
    }
    const name = spec.slice(0, eq)
    const path = resolve(spec.slice(eq + 1))
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(name)) throw new Error('artifact name is invalid: ' + name)
    if (names.has(name)) throw new Error('duplicate artifact name: ' + name)
    if (!statSync(path).isFile()) throw new Error('artifact is not a file: ' + path)
    names.add(name)
    artifacts.push({ name, sha256: sha256File(path) })
  }
  return artifacts
}

function requireArtifact(artifacts, name) {
  const found = artifacts.find(item => item.name === name)
  if (found === undefined) throw new Error(`--artifact ${name}=<path> is required`)
  return found
}

function requireMarkers(text, markers, kind) {
  for (const marker of markers) {
    if (!text.includes(marker)) throw new Error(`${kind}: transcript is missing success marker: ${marker}`)
  }
}

function appUidPreflightResult(text) {
  const line = text.split(/\r?\n/u).find(item => item.includes('APP_UID_PREFLIGHT_OK '))
  if (line === undefined) throw new Error('app-uid-preflight: APP_UID_PREFLIGHT_OK marker is missing')
  const raw = line.slice(line.indexOf('APP_UID_PREFLIGHT_OK ') + 'APP_UID_PREFLIGHT_OK '.length).trim()
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('app-uid-preflight: APP_UID_PREFLIGHT_OK payload is not valid JSON')
  }
  if (parsed.platform !== 'android'
    || parsed.hardlink !== 'PASS'
    || parsed.sandbox !== 'PASS'
    || parsed.landlockEnforcement !== 'full') {
    throw new Error('app-uid-preflight: payload does not prove Android hardlink+sandbox full PASS')
  }
  return parsed
}

const kind = required('--kind')
const capturedAt = timestamp(required('--captured-at'))
const communityCommit = required('--community-commit')
if (!COMMIT.test(communityCommit)) throw new Error('--community-commit must be a full 40-hex Git SHA')
const producer = value('--producer', 'scripts/create-android-evidence-record.mjs')
if (producer.length === 0) throw new Error('--producer must be non-empty')

const transcriptArtifact = transcript()
const artifacts = artifactMap(transcriptArtifact)
const target = resolve(required('--out'))
const deviceIdentity = device()

const record = {
  schemaVersion: 1,
  kind,
  status: 'PASS',
  officialDsh: EXPECTED_DSH,
  capturedAt,
  communityCommit,
  producer,
  artifacts,
  device: deviceIdentity,
}

switch (kind) {
  case 'carrier': {
    requireMarkers(transcriptArtifact.text, [
      'android-node22-probe: SOURCE_OK',
      'android-node22-probe: BUILD_OK',
      'android-node22-probe: DEVICE_OK node=22.19.0 platform=android',
    ], kind)
    requireArtifact(artifacts, 'node-carrier')
    Object.assign(record, {
      executionContext: 'ADB_REAL_DEVICE',
      nodeCarrier: EXPECTED_NODE,
      checks: { sourceIdentity: 'PASS', build: 'PASS', device: 'PASS' },
    })
    break
  }
  case 'native-addon': {
    requireMarkers(transcriptArtifact.text, [
      'android-native-addon-probe: NODE_PTY_BUILD_OK',
      'android-native-addon-probe: KOFFI_BUILD_OK',
      'KOFFI_DEVICE_OK',
      'NODE_PTY_DEVICE_OK',
      'SHARP_WASM_DEVICE_OK',
    ], kind)
    requireArtifact(artifacts, 'node-pty-addon')
    requireArtifact(artifacts, 'koffi-addon')
    Object.assign(record, {
      executionContext: 'ADB_REAL_DEVICE',
      checks: { nodePty: 'PASS', koffi: 'PASS', sharpWasm: 'PASS' },
    })
    break
  }
  case 'app-uid-preflight': {
    const parsed = appUidPreflightResult(transcriptArtifact.text)
    Object.assign(record, {
      executionContext: 'APK_APP_UID',
      checks: { hardlink: 'PASS', sandbox: 'PASS' },
      landlockEnforcement: 'full',
      runtime: { platform: parsed.platform, arch: parsed.arch ?? deviceIdentity.abi },
    })
    break
  }
  case 'pty-app-uid': {
    requireMarkers(transcriptArtifact.text, ['ANDROID_PTY_APP_UID_MINIMAL_OK'], kind)
    Object.assign(record, {
      executionContext: 'APK_APP_UID',
      preset: 'minimal',
      checks: { provider: 'PASS', persistentTerminal: 'PASS' },
    })
    break
  }
  case 'dsh-boot': {
    requireMarkers(transcriptArtifact.text, ['ANDROID_DSH_WEB_APP_UID_BOOT_OK loopback=127.0.0.1'], kind)
    Object.assign(record, {
      executionContext: 'APK_APP_UID',
      loopbackOnly: true,
      checks: { officialWebBoot: 'PASS' },
    })
    break
  }
  case 'apk-arm64': {
    if (deviceIdentity.abi !== 'arm64-v8a') throw new Error('apk-arm64 requires --abi arm64-v8a')
    requireMarkers(transcriptArtifact.text, ['ANDROID_APK_ARM64_SMOKE_OK'], kind)
    requireArtifact(artifacts, 'apk')
    Object.assign(record, { executionContext: 'APK_APP_UID', checks: { smoke: 'PASS' } })
    break
  }
  case 'apk-x86_64': {
    if (deviceIdentity.abi !== 'x86_64') throw new Error('apk-x86_64 requires --abi x86_64')
    requireMarkers(transcriptArtifact.text, ['ANDROID_APK_X86_64_SMOKE_OK'], kind)
    requireArtifact(artifacts, 'apk')
    Object.assign(record, { executionContext: 'ANDROID_EMULATOR', checks: { smoke: 'PASS' } })
    break
  }
  case 'ripgrep':
    throw new Error('ripgrep evidence creation is blocked while the official Android package/path seam is unresolved')
  default:
    throw new Error('unsupported --kind: ' + kind)
}

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
process.stdout.write(`android-evidence-record: CREATED kind=${kind} out=${target}\n`)
