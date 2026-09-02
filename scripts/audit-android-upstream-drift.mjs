import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const STATE_PATH = resolve(ROOT, 'apps/android/native-compatibility.json')
const RIPGREP_AUDIT = resolve(ROOT, 'scripts/audit-android-ripgrep-seam.mjs')

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(name + ' requires a value')
  return value
}

function read(path) {
  return readFileSync(path, 'utf8')
}

function readJson(path) {
  return JSON.parse(read(path))
}

function officialPath(root, relativePath) {
  return resolve(root, relativePath)
}

function possibleAndroidBranch(source) {
  return /\bcase\s+['"]android['"]\s*:/u.test(source)
    || /\bandroid\s*:\s*(?:\[|\{|\()/u.test(source)
    || /process\.platform\s*===?\s*['"]android['"]/u.test(source)
}

function usesHardlinkPublication(source) {
  return /\b(?:await\s+)?link\s*\(/u.test(source)
}

const officialSourceRoot = argValue('--official-source-root')
if (officialSourceRoot === undefined) {
  throw new Error('audit-android-upstream-drift: --official-source-root is required')
}

const sourceRoot = resolve(officialSourceRoot)
const state = readJson(STATE_PATH)
const baseline = state.upstreamDriftBaseline
if (baseline === undefined || typeof baseline !== 'object') {
  throw new Error('audit-android-upstream-drift: native-compatibility.json has no upstreamDriftBaseline')
}

const cliManifest = readJson(officialPath(sourceRoot, 'apps/cli/package.json'))
const subprocessSource = read(officialPath(
  sourceRoot,
  'packages/subprocess/subprocess-local/src/process-inspector.ts',
))
const sandboxSource = read(officialPath(
  sourceRoot,
  'packages/sandbox/sandbox-local/src/index.ts',
))
const fsSearchSourcePath = officialPath(
  sourceRoot,
  'packages/fs/tool-fs-search/src/search-core.ts',
)
const sessionSource = read(officialPath(
  sourceRoot,
  'packages/session/session-persistence-jsonl/src/index.ts',
))
const attachmentSource = read(officialPath(
  sourceRoot,
  'packages/attachment/attachment-local/src/store.ts',
))

const ripgrep = spawnSync(
  process.execPath,
  [RIPGREP_AUDIT, '--source', fsSearchSourcePath],
  { cwd: ROOT, encoding: 'utf8' },
)

let ripgrepResult
if (ripgrep.status === 0) {
  ripgrepResult = JSON.parse(ripgrep.stdout)
} else {
  ripgrepResult = {
    verdict: 'AUDIT_ERROR_REVIEW_REQUIRED',
    error: (ripgrep.stderr || ripgrep.stdout || 'ripgrep seam audit failed').trim(),
    androidPackagesPresent: [],
    sourceAudit: { semantics: { explicitPathSeam: false } },
  }
}

const signals = {
  subprocessOfficialAndroidInspector: possibleAndroidBranch(subprocessSource),
  sandboxOfficialAndroidChain: possibleAndroidBranch(sandboxSource),
  fsSearchExplicitPathSeam:
    ripgrepResult.sourceAudit?.semantics?.explicitPathSeam === true,
  fsSearchAndroidPlatformPackage:
    Array.isArray(ripgrepResult.androidPackagesPresent)
      && ripgrepResult.androidPackagesPresent.length > 0,
  sessionUsesHardlinkPublication: usesHardlinkPublication(sessionSource),
  attachmentUsesHardlinkPublication: usesHardlinkPublication(attachmentSource),
}

const reasons = []
for (const [name, observed] of Object.entries(signals)) {
  const expected = baseline[name]
  if (typeof expected !== 'boolean') {
    reasons.push(`baseline ${name} is missing or non-boolean`)
    continue
  }
  if (observed !== expected) {
    reasons.push(`${name} drifted: expected ${String(expected)}, observed ${String(observed)}`)
  }
}
if (ripgrepResult.verdict === 'AUDIT_ERROR_REVIEW_REQUIRED') {
  reasons.push(`ripgrep seam audit failed: ${ripgrepResult.error}`)
}

const verdict = reasons.length === 0 ? 'NO_DRIFT' : 'REVIEW_REQUIRED'
const result = {
  schemaVersion: 1,
  officialSourceRoot: sourceRoot,
  candidateSourceVersion: cliManifest.version ?? null,
  communityAndroidBaselineVersion: state.officialDsh ?? null,
  verdict,
  signals,
  baseline,
  ripgrepVerdict: ripgrepResult.verdict ?? null,
  reviewReasons: reasons,
  reviewRule: 'Any signal drift requires Android re-adjudication before Community adapters or blockers are carried forward to a new official DSH version.',
}

process.stdout.write(JSON.stringify(result, null, 2) + '\n')
if (verdict === 'REVIEW_REQUIRED') process.exitCode = 2
