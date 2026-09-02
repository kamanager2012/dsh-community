import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const LOCK = 'apps/desktop/runtime-lock/package-lock.json'
const EXPECTED_WRAPPER = '1.18.0'

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(name + ' requires a value')
  return value
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function gitBlobSha(text) {
  const bytes = Buffer.from(text, 'utf8')
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

function sourceVerdict(source) {
  const resolver = /export\s+function\s+resolveRgPath\s*\(([^)]*)\)/u.exec(source)
  const resolverParameters = resolver?.[1]?.trim() ?? null
  const resolverAcceptsInput = resolverParameters !== null && resolverParameters !== ''
  const configPathField = /\b(?:rgPath|ripgrepPath)\s*\??\s*:\s*(?:string|z\.)/u.test(source)
  const explicitEnvPath = /process\.env\.[A-Z0-9_]*(?:RIPGREP|RG_PATH)[A-Z0-9_]*/u.test(source)
  const directVscodeImport = /import\(['"]@vscode\/ripgrep['"]\)/u.test(source)
  const pkgSidecarGate = /['"]pkg['"]\s+in\s+process/u.test(source)
  const explicitPathSeam = resolverAcceptsInput || configPathField || explicitEnvPath

  return {
    resolverParameters,
    resolverAcceptsInput,
    configPathField,
    explicitEnvPath,
    explicitPathSeam,
    directVscodeImport,
    pkgSidecarGate,
  }
}

const lock = readJson(resolve(ROOT, LOCK))
const packages = lock.packages ?? {}
const wrapper = packages['node_modules/@vscode/ripgrep']
if (wrapper?.version !== EXPECTED_WRAPPER) {
  throw new Error(`android-ripgrep-seam: wrapper=${String(wrapper?.version)} expected ${EXPECTED_WRAPPER}; re-adjudicate`)
}

const androidPackagesPresent = Object.keys(packages)
  .filter(key => /^node_modules\/@vscode\/ripgrep-android-/u.test(key))
  .map(key => key.slice('node_modules/'.length))
  .sort()

const sourcePathArg = argValue('--source')
const expectedBlob = argValue('--expected-git-blob')
let sourceAudit = {
  status: 'SOURCE_NOT_PROVIDED',
  gitBlobSha: null,
  expectedGitBlobSha: expectedBlob ?? null,
  exactBlobMatch: null,
  semantics: null,
}

if (sourcePathArg !== undefined) {
  const sourcePath = resolve(sourcePathArg)
  const source = readFileSync(sourcePath, 'utf8')
  const blob = gitBlobSha(source)
  const semantics = sourceVerdict(source)
  sourceAudit = {
    status: 'AUDITED',
    gitBlobSha: blob,
    expectedGitBlobSha: expectedBlob ?? null,
    exactBlobMatch: expectedBlob === undefined ? null : blob === expectedBlob,
    semantics,
  }
  if (expectedBlob !== undefined && blob !== expectedBlob) {
    throw new Error(`android-ripgrep-seam: official source blob drifted: ${blob} expected ${expectedBlob}; re-adjudicate before changing Android status`)
  }
}

let verdict = 'SOURCE_AUDIT_REQUIRED'
if (androidPackagesPresent.length > 0) {
  verdict = 'UPSTREAM_ANDROID_PACKAGE_PRESENT_REVIEW_REQUIRED'
} else if (sourceAudit.status === 'AUDITED') {
  verdict = sourceAudit.semantics.explicitPathSeam
    ? 'UPSTREAM_EXPLICIT_PATH_SEAM_PRESENT_REVIEW_REQUIRED'
    : 'NO_LEGITIMATE_ANDROID_EXECUTABLE_PATH'
}

process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  sourceLock: LOCK,
  wrapperVersion: wrapper.version,
  androidPackagesPresent,
  sourceAudit,
  verdict,
  allowedUnlockConditions: [
    'upstream Android @vscode/ripgrep platform package',
    'explicit official tool-fs-search executable-path seam',
  ],
  forbiddenShortcuts: [
    'fake @vscode/ripgrep-android-* package',
    'process.pkg spoofing',
    'Termux/system rg dependency',
    'copy/fork official glob/grep implementation solely to replace binary resolution',
  ],
}, null, 2) + '\n')
