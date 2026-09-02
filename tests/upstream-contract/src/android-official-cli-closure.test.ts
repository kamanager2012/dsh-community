import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const audit = resolve(ROOT, 'scripts/audit-android-official-cli-closure.mjs')

describe('Android official CLI package closure', () => {
  it('proves profile-only trimming cannot remove the current alpha.4 native install closure', () => {
    const result = spawnSync(process.execPath, [audit], {
      cwd: ROOT,
      encoding: 'utf8',
      env: process.env,
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout) as {
      officialDsh?: string
      status?: string
      profileOnlyMitigation?: string
      blockerPackages?: Array<{ name?: string; version?: string }>
      unresolvedBlockers?: string[]
      verifiedEdges?: Array<{ from?: string; to?: string }>
    }

    expect(report.officialDsh).toBe('0.1.2-alpha.4')
    expect(report.status).toBe('BLOCKED_BY_NATIVE_CLOSURE')
    expect(report.profileOnlyMitigation).toBe('INEFFECTIVE')
    expect(report.unresolvedBlockers).toEqual([
      'subprocess-local',
      'attachment-local',
      'sandbox-local',
      'fs-search',
    ])

    const packages = new Map((report.blockerPackages ?? []).map(item => [item.name, item.version]))
    expect(packages.get('node-pty')).toBe('1.2.0-beta.15')
    expect(packages.get('koffi')).toBe('3.1.6')
    expect(packages.get('sharp')).toBe('0.35.4')
    expect(packages.get('@vscode/ripgrep')).toBe('1.18.0')

    const edges = new Set((report.verifiedEdges ?? []).map(edge => `${edge.from} -> ${edge.to}`))
    expect(edges).toContain('@deepseek-ai/dsh -> @deepseek-ai/dsh-base')
    expect(edges).toContain('@deepseek-ai/dsh-base -> @deepseek-ai/dsh-subprocess-local')
    expect(edges).toContain('@deepseek-ai/dsh-subprocess-local -> node-pty')
    expect(edges).toContain('@deepseek-ai/dsh-attachment-local -> sharp')
    expect(edges).toContain('@deepseek-ai/dsh-tool-fs-search -> @vscode/ripgrep')
  })
})
