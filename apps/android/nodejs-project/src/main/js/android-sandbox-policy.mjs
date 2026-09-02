export const LANDLOCK_FAILURE_EXIT = 125
export const LANDLOCK_FATAL_SIGNATURE = 'landlock-run: '
export const LANDLOCK_PARTIAL_LINE = 'landlock-run: partial enforcement (older Landlock ABI)'

export function buildAndroidLandlockArgv(launcher, innerArgv, policy, writableRoots) {
  if (typeof launcher !== 'string' || launcher.length === 0 || !launcher.startsWith('/')) {
    throw new Error('android-sandbox: launcher path must be absolute')
  }
  if (!Array.isArray(innerArgv) || innerArgv.length === 0 || innerArgv.some(arg => typeof arg !== 'string')) {
    throw new Error('android-sandbox: inner argv must be a non-empty string array')
  }
  if (policy?.mode !== 'read-only' && policy?.mode !== 'workspace-write') {
    throw new Error('android-sandbox: only confined read-only/workspace-write policies may reach the provider')
  }
  if (!Array.isArray(writableRoots) || writableRoots.some(root => typeof root !== 'string' || root.length === 0)) {
    throw new Error('android-sandbox: writable roots must be non-empty strings')
  }

  const grants = ['--ro', '/', '--rw', '/dev/null']
  if (policy.mode === 'workspace-write') {
    for (const root of writableRoots) grants.push('--rw', root)
  } else if (writableRoots.length !== 0) {
    throw new Error('android-sandbox: read-only policy must have no writableRoots')
  }

  return [launcher, ...grants, '--', ...innerArgv]
}
