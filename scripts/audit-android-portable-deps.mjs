import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const LOCK = 'apps/desktop/runtime-lock/package-lock.json'

function readJson(rel) {
  return JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8'))
}

function entry(packages, name) {
  const value = packages['node_modules/' + name]
  if (value === undefined) throw new Error('android-portable-deps: missing lock entry ' + name)
  return value
}

function requireVersion(packages, name, version) {
  const value = entry(packages, name)
  if (value.version !== version) {
    throw new Error(`android-portable-deps: ${name}=${String(value.version)} expected ${version}`)
  }
  if (typeof value.resolved !== 'string' || !value.resolved.startsWith('https://registry.npmjs.org/')) {
    throw new Error('android-portable-deps: ' + name + ' has no registry provenance')
  }
  if (typeof value.integrity !== 'string' || !value.integrity.startsWith('sha512-')) {
    throw new Error('android-portable-deps: ' + name + ' has no sha512 integrity')
  }
  return value
}

const lock = readJson(LOCK)
const packages = lock.packages ?? {}

const sharp = requireVersion(packages, 'sharp', '0.35.4')
const sharpWasm = requireVersion(packages, '@img/sharp-wasm32', '0.35.4')
const emnapi = requireVersion(packages, '@emnapi/runtime', '1.11.3')
const ripgrep = requireVersion(packages, '@vscode/ripgrep', '1.18.0')

if (sharpWasm.dependencies?.['@emnapi/runtime'] === undefined) {
  throw new Error('android-portable-deps: sharp-wasm32 lost @emnapi/runtime dependency')
}

const androidRipgrepPackages = [
  '@vscode/ripgrep-android-arm64',
  '@vscode/ripgrep-android-x64',
]
const presentAndroidRipgrepPackages = androidRipgrepPackages.filter(
  name => packages['node_modules/' + name] !== undefined,
)
if (presentAndroidRipgrepPackages.length !== 0) {
  throw new Error(
    'android-portable-deps: Android ripgrep package unexpectedly appeared; re-adjudicate upstream support: '
      + presentAndroidRipgrepPackages.join(', '),
  )
}

const result = {
  schemaVersion: 1,
  sourceLock: LOCK,
  sharp: {
    version: sharp.version,
    status: 'LOCKED_WASM_FALLBACK_MATERIALIZATION_AND_DEVICE_PROBE_REQUIRED',
    wasmPackage: {
      name: '@img/sharp-wasm32',
      version: sharpWasm.version,
      integrity: sharpWasm.integrity,
      optionalInLock: sharpWasm.optional === true,
    },
    emnapi: {
      version: emnapi.version,
      integrity: emnapi.integrity,
    },
    note: 'The lock proves exact fallback provenance, not that a host-specific npm ci materialized optional WASM bytes.',
  },
  ripgrep: {
    wrapperVersion: ripgrep.version,
    status: 'WRAPPER_ADAPTER_OR_UPSTREAM_PACKAGE_REQUIRED',
    androidPackagesPresent: presentAndroidRipgrepPackages,
    expectedRuntimePackageNames: androidRipgrepPackages,
    wrapperResolutionContract: '@vscode/ripgrep-${process.platform}-${arch}',
    upstreamBinaryProvenance: {
      vscodeRipgrepVersion: '1.18.0',
      microsoftPrebuiltTag: 'v15.0.1',
      microsoftTagObjectSha: '05570a5ba5dd6e40c8ebc0d345c5679f94208681',
      microsoftCommit: '67202aaafb17aecd9b5b7046d5b7baa92b05237a',
      microsoftConfigBlobSha: '18ac3f94300c881b82721d4f0af096ac84206af6',
      microsoftPatchBlobSha: 'd7afb314f6171c129c33140de5feeb73f1a161d8',
      upstreamRipgrepTag: '15.0.0',
      upstreamTagObjectSha: '224a9ca894e2fcdc57fdd8bd9111d51558f83014',
      upstreamCommit: '3a612f88b805e14aef45bfa43e25a54abc6297fc',
      upstreamTagVerified: true,
    },
    forbiddenShortcuts: [
      'publish a fake package under the @vscode scope',
      'spoof process.pkg to force the single-file sidecar path',
      'depend on a Termux/system rg binary',
      'substitute an unpinned newer ripgrep binary',
    ],
  },
}

process.stdout.write(JSON.stringify(result, null, 2) + '\n')
