#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const EXPECTED_TARGET = '0.1.2-alpha.3'
const ROOT = process.cwd()
const WATCH_PATH = join(ROOT, 'contracts/compatibility/upstream-candidate-watch.json')
const REMOTE_GATE_PATH = join(ROOT, 'contracts/compatibility/remote-integration-gate.json')

function fail(message) {
  throw new Error(message)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function commandName(name) {
  return process.platform === 'win32' ? name + '.cmd' : name
}

function run(command, args, options = {}) {
  process.stdout.write('\n> ' + command + ' ' + args.join(' ') + '\n')
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
    shell: false,
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

function assertCleanIntegrationTree(acceptedCommit) {
  const status = run('git', ['status', '--porcelain'], { capture: true })
  if (status !== '') {
    fail('integration acceptance requires a clean working tree')
  }

  const branch = run('git', ['branch', '--show-current'], { capture: true })
  if (branch === 'main' || branch === 'master') {
    fail('run alpha.3 integration acceptance on a non-main integration branch')
  }

  const head = run('git', ['rev-parse', 'HEAD'], { capture: true })
  const ancestor = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', acceptedCommit, head],
    { cwd: ROOT, stdio: 'ignore', shell: false, windowsHide: true },
  )
  if (ancestor.error) {
    fail('git merge-base failed: ' + ancestor.error.message)
  }
  if (ancestor.status !== 0) {
    fail(
      'accepted local alpha.3 commit ' + acceptedCommit
        + ' is not an ancestor of integration HEAD ' + head,
    )
  }
  return { branch, head }
}

function assertFrozenTarget() {
  const watch = readJson(WATCH_PATH)
  const gate = readJson(REMOTE_GATE_PATH)
  if (watch.frozenTarget?.version !== EXPECTED_TARGET) {
    fail(
      'upstream candidate watch target drifted: '
        + String(watch.frozenTarget?.version) + ' != ' + EXPECTED_TARGET,
    )
  }
  if (watch.newerObserved?.disposition !== 'NEXT_UPGRADE_CYCLE') {
    fail('newer upstream candidate is not isolated to NEXT_UPGRADE_CYCLE')
  }

  const acceptedCommit = gate.nextRequiredRemoteInput?.localAcceptedCommit
  if (typeof acceptedCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(acceptedCommit)) {
    fail('remote integration gate has no exact accepted local commit')
  }
  if (gate.safeRemoteOperation?.actionsExpected !== 0) {
    fail('remote integration gate no longer records the no-Actions staging path')
  }
  return acceptedCommit
}

function verifyInstalledRuntime() {
  const runtimeRoot = join(ROOT, 'apps/desktop/runtime-lock')
  const manifest = readJson(join(runtimeRoot, 'package.json'))
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
  process.stdout.write('runtime-lock installed version verified: ' + installed + '\n')
}

function main() {
  if (process.env.DSH_COMMUNITY_ALLOW_UNPINNED === '1') {
    fail('unset DSH_COMMUNITY_ALLOW_UNPINNED before final acceptance')
  }

  const acceptedCommit = assertFrozenTarget()
  const git = assertCleanIntegrationTree(acceptedCommit)
  const candidateTag = 'v' + EXPECTED_TARGET
  const pnpm = commandName('pnpm')
  const npm = commandName('npm')
  const runtimeRoot = join(ROOT, 'apps/desktop/runtime-lock')

  process.stdout.write(
    'alpha.3 consolidated acceptance\n'
      + 'branch=' + git.branch + '\n'
      + 'head=' + git.head + '\n'
      + 'acceptedLocalCommit=' + acceptedCommit + '\n',
  )

  // Identity gates first. Published Latest verification is read-only GitHub API access.
  run(process.execPath, ['scripts/validate-release-tag.mjs', candidateTag])
  run(process.execPath, ['scripts/validate-published-latest.mjs'])

  // One consolidated dependency realization after all source edits are complete.
  run(pnpm, ['install', '--frozen-lockfile'])

  // Mirror the runtime-lock PR contract locally, without lifecycle scripts.
  run(npm, ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: runtimeRoot,
  })
  verifyInstalledRuntime()
  run(npm, ['audit', '--package-lock-only', '--omit=dev', '--audit-level', 'high'], {
    cwd: runtimeRoot,
  })

  // Deterministic repository acceptance. Do not split this into edit-by-edit runs.
  run(pnpm, ['typecheck'])
  run(pnpm, ['test'])
  run(process.execPath, ['packages/marketplace/scripts/verify.mjs', '--offline'])

  process.stdout.write(
    '\nALPHA3_INTEGRATION_ACCEPTANCE=PASS\n'
      + 'No tag was created, no PR was opened, no provider was invoked.\n',
  )
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write('\nALPHA3_INTEGRATION_ACCEPTANCE=FAIL\n' + message + '\n')
  process.exitCode = 1
}
