/**
 * spawnSync wrapper that fails with a real error on Windows.
 * `pnpm` is pnpm.cmd there; spawn without a shell yields status null / ENOENT.
 */
import { spawnSync } from 'node:child_process'

function looksLikePath(command) {
  return command.includes('/') || command.includes('\\') || /\.(exe|cmd|bat|js)$/i.test(command)
}

function stdioWithoutStdin(stdio) {
  if (stdio === undefined || stdio === 'inherit') return ['ignore', 'inherit', 'inherit']
  if (stdio === 'pipe') return ['ignore', 'pipe', 'pipe']
  if (Array.isArray(stdio)) return ['ignore', stdio[1] ?? 'inherit', stdio[2] ?? 'inherit']
  return ['ignore', 'inherit', 'inherit']
}

export function runCommand(command, args, options = {}) {
  const win = process.platform === 'win32'
  const result = spawnSync(command, args, {
    ...options,
    stdio: stdioWithoutStdin(options.stdio),
    env: {
      ...process.env,
      CI: 'true',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      ...options.env,
    },
    shell: options.shell ?? (win && !looksLikePath(command)),
    windowsHide: true,
  })
  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error.message}`)
  }
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(String(result.stdout))
    if (result.stderr) process.stderr.write(String(result.stderr))
    throw new Error(`${command} ${args.join(' ')} failed (${String(result.status)})`)
  }
  return result
}
