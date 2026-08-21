import { describe, expect, it } from 'vitest'
import { officialWebArgv, resolveOfficialDsh } from '@dsh-community/dsh-bridge'
import { runOfficial } from '../../../contracts/lib/run-official.ts'

describe('official CLI surface (pinned @deepseek-ai/dsh)', () => {
  it('prints the pinned version', () => {
    const install = resolveOfficialDsh({ from: import.meta.url })
    const out = runOfficial(['--version']).trim()
    expect(out).toBe(install.version)
  })

  it('exposes web alias, --profile, and config dumps', () => {
    const help = runOfficial(['--help'])
    expect(help).toMatch(/\bweb\b/)
    expect(help).toMatch(/--profile/)
    expect(help).toMatch(/--dump-config/)
    expect(help).toMatch(/--dump-default-config/)
    expect(help).toMatch(/plugin/)
  })

  it('keeps the web bind flags this shell passes through', () => {
    const help = runOfficial(['web', '--help'])
    expect(help).toMatch(/--host/)
    expect(help).toMatch(/--port/)
    expect(help).toMatch(/--no-open/)
    expect(officialWebArgv()[0]).toBe('web')
    expect(officialWebArgv()).toContain('--no-open')
  })

  it('dumps the official web tree without this repo vendoring it', () => {
    const dump = runOfficial(['web', '--dump-default-config'])
    expect(dump).toMatch(/@deepseek-ai\/dsh-session/)
    expect(dump).toMatch(/@deepseek-ai\/dsh-agent/)
    expect(dump).toMatch(/@deepseek-ai\/dsh-web-app/)
    expect(dump).toMatch(/id: session/)
    expect(dump).toMatch(/id: agent/)
  })
})
