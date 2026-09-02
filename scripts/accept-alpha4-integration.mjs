#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const EXPECTED_TARGET = '0.1.2-alpha.4'
const PREVIOUS_ACCEPTED = '0.1.2-alpha.3'
const ROOT = process.cwd()
const WATCH_PATH = join(ROOT, 'contracts/compatibility/upstream-candidate-watch.json')
const REMOTE_GATE_PATH = join(ROOT, 'contracts/compatibility/remote-integration-gate.json')

function fail(message) {
  throw new Error(message)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const PROVIDER_SECRET_KEYS = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'GROK_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
])

function providerSafeEnv() {
  const env = { ...process.env }
  for (const key of PROVIDER_SECRET_KEYS) delete env[key]
  return env
}

function run(command, args, options = {}) {
  process.stdout.write('\n> ' + command + ' ' + args.join(' ') + '\n')
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? providerSafeEnv(),
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
    shell: options.shell ?? false,
    windowsHide: true,
  })
  if (result.error) {
    fail(command + ' failed to start: ' + result.error.message)
  }
  if (result.status !== 0) {
    const stderr = options.capture ? String(result.stderr ?? '').trim() : ''
    fail(
      command + ' ' + args.join(' ') + ' failed with status ' + String(result.status)
        + (stderr ? ': ' + stderr : ''),
    )
  }
  return options.capture ? String(result.stdout ?? '').trim() : ''
}

function assertCleanIntegrationTree(baselineCommit) {
  const status = run('git', ['status', '--porcelain'], { capture: true })
  if (status !== '') {
    fail('integration acceptance requires a clean working tree')
  }

  const branch = run('git', ['branch', '--show-current'], { capture: true })
  if (branch === 'main' || branch === 'master') {
    fail('run alpha.4 integration acceptance on a non-main integration branch')
  }

  const head = run('git', ['rev-parse', 'HEAD'], { capture: true })
  const ancestor = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', baselineCommit, head],
    { cwd: ROOT, stdio: 'ignore', shell: false, windowsHide: true },
  )
  if (ancestor.error) {
    fail('git merge-base failed: ' + ancestor.error.message)
  }
  if (ancestor.status !== 0) {
    fail(
      'accepted alpha.4 baseline ' + baselineCommit
        + ' is not an ancestor of integration HEAD ' + head,
    )
  }
  return { branch, head }
}

function assertFrozenTarget() {
  const watch = readJson(WATCH_PATH)
  const gate = readJson(REMOTE_GATE_PATH)

  if (watch.schemaVersion !== 2) {
    fail('upstream candidate watch schema is not alpha.4 schemaVersion 2')
  }
  if (watch.previousAccepted?.version !== PREVIOUS_ACCEPTED) {
    fail(
      'previous accepted baseline drifted: '
        + String(watch.previousAccepted?.version) + ' != ' + PREVIOUS_ACCEPTED,
    )
  }
  if (watch.frozenTarget?.version !== EXPECTED_TARGET) {
    fail(
      'upstream candidate watch target drifted: '
        + String(watch.frozenTarget?.version) + ' != ' + EXPECTED_TARGET,
    )
  }
  if (watch.frozenTarget?.registryGate?.status !== 'PASS') {
    fail('alpha.4 exact npm registry gate is not PASS')
  }

  const baselineCommit = gate.acceptedBaseline?.commit
  if (typeof baselineCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(baselineCommit)) {
    fail('remote integration gate has no exact accepted alpha.4 baseline commit')
  }
  if (gate.acceptedBaseline?.branch !== 'upgrade/dsh-0.1.2-alpha.4') {
    fail('remote integration gate points at the wrong alpha.4 branch')
  }
  if (gate.finalAcceptance?.status !== 'PENDING') {
    fail('alpha.4 final acceptance must be PENDING before this gate runs')
  }
  if (gate.safeRemoteOperation?.actionsExpected !== 0) {
    fail('remote integration gate no longer records the no-Actions staging path')
  }
  return baselineCommit
}

function packageNameFromLockPath(lockPath) {
  const marker = 'node_modules/'
  const index = lockPath.lastIndexOf(marker)
  return index === -1 ? null : lockPath.slice(index + marker.length)
}

function verifyInstalledRuntime() {
  const runtimeRoot = join(ROOT, 'apps/desktop/runtime-lock')
  const manifest = readJson(join(runtimeRoot, 'package.json'))
  const lock = readJson(join(runtimeRoot, 'package-lock.json'))
  const expected = manifest.dependencies?.['@deepseek-ai/dsh']
  const installed = readJson(
    join(runtimeRoot, 'node_modules/@deepseek-ai/dsh/package.json'),
  ).version

  if (expected !== EXPECTED_TARGET) {
    fail(
      'runtime-lock manifest target ' + String(expected)
        + ' != frozen target ' + EXPECTED_TARGET,
    )
  }
  if (installed !== expected) {
    fail('installed runtime ' + String(installed) + ' != runtime lock ' + String(expected))
  }

  const dshFamily = Object.entries(lock.packages ?? {})
    .filter(([path]) => {
      const name = packageNameFromLockPath(path)
      return name === '@deepseek-ai/dsh' || name?.startsWith('@deepseek-ai/dsh-')
    })
    .map(([path, entry]) => ({
      path,
      version: entry?.version,
    }))

  if (dshFamily.length === 0) {
    fail('runtime lock contains no official DSH family packages')
  }

  const mixed = dshFamily.filter((entry) => entry.version !== expected)
  if (mixed.length > 0) {
    fail(
      'runtime lock contains mixed DSH family versions: '
        + mixed.map((entry) => entry.path + '@' + String(entry.version)).join(', '),
    )
  }

  process.stdout.write(
    'runtime-lock exact family verified: ' + installed
      + '; DSH package entries=' + String(dshFamily.length) + '\n',
  )
}

function main() {
  if (process.env.DSH_COMMUNITY_ALLOW_UNPINNED === '1') {
    fail('unset DSH_COMMUNITY_ALLOW_UNPINNED before final acceptance')
  }

  const baselineCommit = assertFrozenTarget()
  const git = assertCleanIntegrationTree(baselineCommit)
  const candidateTag = 'v' + EXPECTED_TARGET
  const packageShell = process.platform === 'win32'
  const runtimeRoot = join(ROOT, 'apps/desktop/runtime-lock')

  process.stdout.write(
    'alpha.4 consolidated acceptance\n'
      + 'branch=' + git.branch + '\n'
      + 'head=' + git.head + '\n'
      + 'acceptedBaselineCommit=' + baselineCommit + '\n',
  )

  // Identity gates first. Published Latest verification is read-only GitHub API access.
  run(process.execPath, ['scripts/validate-release-tag.mjs', candidateTag])
  run(process.execPath, ['scripts/validate-published-latest.mjs'])

  // Realize the committed alpha.4 workspace lock exactly once.
  run('pnpm', ['install', '--frozen-lockfile'], { shell: packageShell })

  // Re-extract official contracts from the final installed candidate.
  // Any diff means the committed snapshots are stale.
  run('pnpm', ['contracts:extract'], { shell: packageShell })
  const contractDrift = run('git', ['status', '--porcelain'], { capture: true })
  if (contractDrift !== '') {
    fail(
      'contracts:extract changed the integration tree; inspect and commit official contract drift before acceptance',
    )
  }

  // Mirror the runtime-lock PR contract locally, without lifecycle scripts.
  run('npm', ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: runtimeRoot,
    shell: packageShell,
  })
  verifyInstalledRuntime()
  run('npm', ['audit', '--package-lock-only', '--omit=dev', '--audit-level', 'high'], {
    cwd: runtimeRoot,
    shell: packageShell,
  })

  // One deterministic repository acceptance, not edit-by-edit test runs.
  run('pnpm', ['typecheck'], { shell: packageShell })
  run('pnpm', ['test'], { shell: packageShell })
  run(process.execPath, ['packages/marketplace/scripts/verify.mjs', '--offline'])

  process.stdout.write(
    '\nALPHA4_INTEGRATION_ACCEPTANCE=PASS\n'
      + 'No tag was created, no PR was opened, no provider was invoked.\n',
  )
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write('\nALPHA4_INTEGRATION_ACCEPTANCE=FAIL\n' + message + '\n')
  process.exitCode = 1
}
