/**
 * Consolidated local 0.2.2-rc.3 integration acceptance gate.
 * Runs ordered verification without release, PR, or model provider side effects.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_TARGET = '0.2.2-rc.3'
const PREVIOUS_ACCEPTED = '0.2.2-rc.2'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const auditRegistry = 'https://registry.npmjs.org/'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function capture(command, args, cwd = root, env = process.env) {
  const res = spawnSync(command, args, { cwd, env, encoding: 'utf8' })
  if (res.status !== 0) {
    fail(`${command} ${args.join(' ')} failed (${String(res.status)}): ${res.stderr || res.stdout}`)
  }
  return res.stdout.trim()
}

function run(command, args, cwd = root, env = process.env) {
  const res = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (res.status !== 0) {
    fail(`${command} ${args.join(' ')} failed with exit code ${String(res.status)}`)
  }
}

function providerSafeEnv() {
  const next = { ...process.env }
  for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
    delete next[key]
  }
  next.DSH_DISABLE_PROVIDER_CALLS = '1'
  return next
}

function packageNameFromLockPath(lockPath) {
  const marker = 'node_modules/'
  const index = lockPath.lastIndexOf(marker)
  return index === -1 ? '' : lockPath.slice(index + marker.length)
}

function assertCleanTree(context) {
  const status = capture('git', ['status', '--porcelain'])
  if (status.length > 0) {
    fail(`${context}: working tree is not clean:\n${status}`)
  }
}

const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch === 'main' || branch === 'master' || branch === 'HEAD') {
  fail('run 0.2.2-rc.3 integration acceptance on a non-main integration branch')
}

assertCleanTree('pre-acceptance check')

const headCommit = capture('git', ['rev-parse', 'HEAD'])
const watch = JSON.parse(
  readFileSync(join(root, 'contracts/compatibility/upstream-candidate-watch.json'), 'utf8'),
)
const gate = JSON.parse(
  readFileSync(join(root, 'contracts/compatibility/remote-integration-gate.json'), 'utf8'),
)

if (watch.previousAccepted?.version !== PREVIOUS_ACCEPTED) {
  fail(`expected previousAccepted=${PREVIOUS_ACCEPTED}, got ${String(watch.previousAccepted?.version)}`)
}
if (watch.frozenTarget?.version !== EXPECTED_TARGET || watch.frozenTarget?.registryGate?.status !== 'PASS') {
  fail('0.2.2-rc.3 exact npm registry gate is not PASS')
}

const baselineCommit = gate.acceptedBaseline?.commit
if (typeof baselineCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(baselineCommit)) {
  fail('remote integration gate has no exact accepted 0.2.2-rc.3 baseline commit')
}
if (gate.acceptedBaseline?.branch !== 'upgrade/dsh-0.2.2-rc.3') {
  fail(`unexpected acceptedBaseline branch: ${String(gate.acceptedBaseline?.branch)}`)
}
run('git', ['merge-base', '--is-ancestor', baselineCommit, 'HEAD'])

const acceptanceStatus = gate.finalAcceptance?.status
if (gate.finalAcceptance?.version !== EXPECTED_TARGET) {
  fail('0.2.2-rc.3 final acceptance state does not match the frozen target')
}
if (acceptanceStatus !== 'PENDING' && acceptanceStatus !== 'PASS') {
  fail(`unexpected finalAcceptance status: ${String(acceptanceStatus)}`)
}

const env = providerSafeEnv()

// 1. Validate release tag + Published Latest identity
run(process.execPath, ['scripts/validate-release-tag.mjs', `v${EXPECTED_TARGET}`], root, env)
run(process.execPath, ['scripts/validate-published-latest.mjs'], root, env)

// 2. Realize committed workspace lock and audit workspace deps
run('pnpm', ['install', '--frozen-lockfile', '--registry', auditRegistry], root, env)
run('pnpm', ['audit', '--audit-level', 'high', '--registry', auditRegistry], root, env)

// 3. Extract official contracts and ensure zero drift
run('pnpm', ['contracts:extract'], root, env)
assertCleanTree('post-contracts-extract drift check')

// 4. Mirror clean runtime-lock install + audit in isolated staging directory
const lockRoot = join(root, 'apps/desktop/runtime-lock')
const lockJson = JSON.parse(readFileSync(join(lockRoot, 'package-lock.json'), 'utf8'))
const dshEntries = Object.entries(lockJson.packages ?? {})
  .filter(([lockPath]) => {
    const name = packageNameFromLockPath(lockPath)
    return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
  })
const badVersions = dshEntries.filter(([, entry]) => entry?.version !== EXPECTED_TARGET)
if (badVersions.length > 0) {
  fail(`runtime lock contains mixed DSH family versions: ${badVersions.map(([p, e]) => `${p}@${String(e?.version)}`).join(', ')}`)
}
process.stdout.write(`runtime-lock exact family verified (${dshEntries.length} DSH entries at ${EXPECTED_TARGET})\n`)

const stageDir = mkdtempSync(join(tmpdir(), 'dsh-rc3-stage-'))
try {
  copyFileSync(join(lockRoot, 'package.json'), join(stageDir, 'package.json'))
  copyFileSync(join(lockRoot, 'package-lock.json'), join(stageDir, 'package-lock.json'))
  run('npm', ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--registry', auditRegistry], stageDir, env)
  run('npm', ['audit', '--package-lock-only', '--omit=dev', '--audit-level', 'high', '--registry', auditRegistry], stageDir, env)
} finally {
  rmSync(stageDir, { recursive: true, force: true })
}

// 5. Verify Android remains fail-closed BLOCKED (never inferred PASS)
const androidRes = spawnSync(process.execPath, ['scripts/verify-android-release-ready.mjs'], {
  cwd: root,
  env,
  encoding: 'utf8',
})
if (androidRes.status === 0) {
  fail('expected verify-android-release-ready.mjs to fail closed while Android is NOT_RUN')
}

// 6. Typecheck, full test suite, and offline marketplace verification
run('pnpm', ['typecheck'], root, env)
run('pnpm', ['test'], root, env)
run(process.execPath, ['packages/marketplace/scripts/verify.mjs', '--offline'], root, env)

assertCleanTree('post-acceptance clean tree check')
process.stdout.write(`0.2.2-rc.3 consolidated acceptance head=${headCommit} RC3_INTEGRATION_ACCEPTANCE=PASS\n`)
