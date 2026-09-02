import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import SandboxProvider, {
  SandboxUnavailableError,
  writableRoots,
} from '@deepseek-ai/dsh-sandbox'
import {
  LANDLOCK_FAILURE_EXIT,
  LANDLOCK_FATAL_SIGNATURE,
  LANDLOCK_PARTIAL_LINE,
  buildAndroidLandlockArgv,
} from './android-sandbox-policy.mjs'

const PROBE_TIMEOUT_MS = 5000
const FULL_PROBE_LINE = 'landlock: fully enforced'

function launcherFromEnvironment() {
  const launcher = process.env.DSH_ANDROID_LANDLOCK_RUN
  if (typeof launcher !== 'string' || launcher.length === 0 || !launcher.startsWith('/')) {
    return {
      ok: false,
      detail: 'DSH_ANDROID_LANDLOCK_RUN must name an absolute frozen-runtime Android landlock-run path',
    }
  }
  return { ok: true, launcher }
}

function fullProbe(launcher) {
  const result = spawnSync(launcher, ['--probe'], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.error !== undefined) {
    return { ok: false, detail: `landlock probe spawn failed: ${result.error.message}` }
  }
  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()
  if (result.status !== 0) {
    return {
      ok: false,
      detail: `landlock probe exited ${String(result.status)}: ${stderr || stdout || 'no diagnostic'}`,
    }
  }
  if (stdout !== FULL_PROBE_LINE || stderr !== '') {
    return {
      ok: false,
      detail: `Android requires full Landlock enforcement; observed stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
    }
  }
  return { ok: true }
}

function existingWritableRoots(policy) {
  // The shared official vocabulary includes both /tmp and os.tmpdir(). Android
  // may not expose /tmp at all; Landlock cannot grant a nonexistent path and
  // deliberately fails closed on one. Omitting a missing auxiliary root only
  // narrows the policy. The real workspace and app temp root remain present
  // and are still derived by the official writableRoots() helper.
  return writableRoots(policy).filter(root => existsSync(root))
}

export class AndroidLandlockSandboxProvider extends SandboxProvider {
  constructor(ctx) {
    super(ctx)
    this._probe = undefined
  }

  _requireLauncher(mode) {
    const resolved = launcherFromEnvironment()
    if (!resolved.ok) throw new SandboxUnavailableError(mode, resolved.detail)

    this._probe ??= fullProbe(resolved.launcher)
    if (!this._probe.ok) throw new SandboxUnavailableError(mode, this._probe.detail)
    return resolved.launcher
  }

  confine(argv, policy) {
    const launcher = this._requireLauncher(policy.mode)
    return {
      argv: buildAndroidLandlockArgv(launcher, [...argv], policy, existingWritableRoots(policy)),
      enforcement: 'full',
      denialSignatures: ['permission denied'],
      runnerFailureRules: [{
        allowedExitCodes: [LANDLOCK_FAILURE_EXIT],
        fatalSignatures: [LANDLOCK_FATAL_SIGNATURE],
        informationalLines: [LANDLOCK_PARTIAL_LINE],
      }],
    }
  }
}

export default AndroidLandlockSandboxProvider
