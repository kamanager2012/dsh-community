import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const LOCK = 'apps/desktop/runtime-lock/package-lock.json'
const ANDROID_PACKAGE = 'apps/android/nodejs-project/package.json'
const BLOCKERS = 'apps/android/native-blockers.json'
const EXPECTED_DSH = '0.1.2-alpha.4'

function readJson(rel) {
  return JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8'))
}

function packagePath(name) {
  return 'node_modules/' + name
}

function requireEntry(packages, name) {
  const path = packagePath(name)
  const entry = packages[path]
  if (entry === undefined) throw new Error('android-cli-closure: missing lock entry ' + path)
  return entry
}

function requireEdge(packages, from, to) {
  const entry = requireEntry(packages, from)
  if (entry.dependencies?.[to] === undefined && entry.optionalDependencies?.[to] === undefined) {
    throw new Error(`android-cli-closure: missing dependency edge ${from} -> ${to}`)
  }
}

const lock = readJson(LOCK)
const android = readJson(ANDROID_PACKAGE)
const blockers = readJson(BLOCKERS)
const packages = lock.packages ?? {}

if (android.dependencies?.['@deepseek-ai/dsh'] !== EXPECTED_DSH) {
  throw new Error('android-cli-closure: Android target is not pinned to exact official DSH alpha.4')
}
const dsh = requireEntry(packages, '@deepseek-ai/dsh')
if (dsh.version !== EXPECTED_DSH) {
  throw new Error(`android-cli-closure: committed runtime lock has DSH ${String(dsh.version)}`)
}

const edges = [
  ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base'],
  ['@deepseek-ai/dsh', '@deepseek-ai/dsh-sdk-minimal'],
  ['@deepseek-ai/dsh', '@deepseek-ai/dsh-tool-fs-search'],
  ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-subprocess-local'],
  ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-attachment-local'],
  ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sandbox-local'],
  ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tool-fs-search'],
  ['@deepseek-ai/dsh-subprocess-local', 'node-pty'],
  ['@deepseek-ai/dsh-subprocess-local', 'koffi'],
  ['@deepseek-ai/dsh-attachment-local', 'sharp'],
  ['@deepseek-ai/dsh-sandbox-local', '@deepseek-ai/node-addon-landlock-run'],
  ['@deepseek-ai/dsh-sandbox-local', '@deepseek-ai/dsh-sandbox-windows-acl'],
  ['@deepseek-ai/dsh-sandbox-windows-acl', 'koffi'],
  ['@deepseek-ai/dsh-tool-fs-search', '@vscode/ripgrep'],
]

for (const [from, to] of edges) requireEdge(packages, from, to)

const blockerPackages = [
  '@deepseek-ai/dsh-subprocess-local',
  'node-pty',
  'koffi',
  '@deepseek-ai/dsh-attachment-local',
  'sharp',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/node-addon-landlock-run',
  '@deepseek-ai/dsh-sandbox-windows-acl',
  '@deepseek-ai/dsh-tool-fs-search',
  '@vscode/ripgrep',
]
for (const name of blockerPackages) requireEntry(packages, name)

const open = (blockers.blockers ?? []).filter(item => item.status !== 'RESOLVED').map(item => item.id)
const status = open.length === 0 ? 'NATIVE_CLOSURE_RESOLVED' : 'BLOCKED_BY_NATIVE_CLOSURE'

const result = {
  schemaVersion: 1,
  officialDsh: EXPECTED_DSH,
  sourceLock: LOCK,
  androidDependency: android.dependencies['@deepseek-ai/dsh'],
  status,
  profileOnlyMitigation: 'INEFFECTIVE',
  reason: 'The published top-level @deepseek-ai/dsh package eagerly depends on dsh-base/sdk-minimal/tool-fs-search, so disabling profile rows does not remove their npm installation closure.',
  verifiedEdges: edges.map(([from, to]) => ({ from, to })),
  blockerPackages: blockerPackages.map(name => ({
    name,
    version: requireEntry(packages, name).version,
  })),
  unresolvedBlockers: open,
}

process.stdout.write(JSON.stringify(result, null, 2) + '\n')
