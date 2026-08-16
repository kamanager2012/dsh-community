import { describe, expect, it } from 'vitest'
import { runCommand } from '../scripts/run-command.mjs'

describe('runCommand', () => {
  it('surfaces spawn errors instead of status null', () => {
    expect(() => runCommand('definitely-not-a-dsh-command', ['--help'])).toThrow(/failed:/)
  })

  it('runs node and returns status 0', () => {
    const result = runCommand(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'pipe' })
    expect(result.status).toBe(0)
  })

  it('closes stdin so a reader cannot hang waiting for input', () => {
    const started = Date.now()
    const result = runCommand(process.execPath, ['-e', `
      process.stdin.resume()
      process.stdin.on('end', () => process.exit(0))
      setTimeout(() => process.exit(3), 4000)
    `], { stdio: 'pipe' })
    expect(result.status).toBe(0)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
