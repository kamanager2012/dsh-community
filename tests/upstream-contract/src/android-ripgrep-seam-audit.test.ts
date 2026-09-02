import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const audit = resolve(ROOT, 'scripts/audit-android-ripgrep-seam.mjs')

function runWithSource(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rg-seam-'))
  const sourcePath = join(dir, 'search-core.ts')
  writeFileSync(sourcePath, source)
  const result = spawnSync(process.execPath, [audit, '--source', sourcePath], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  rmSync(dir, { recursive: true, force: true })
  return result
}

describe('Android ripgrep seam audit', () => {
  it('keeps alpha4-shaped packaged resolution blocked', () => {
    const result = runWithSource([
      "export function resolveRgPath(): Promise<string> {",
      "  if ('pkg' in process) return Promise.resolve(process.execPath + '-rg')",
      "  return import('@vscode/ripgrep').then(x => x.rgPath)",
      "}",
    ].join('\n'))

    expect(result.status).toBe(0)
    const value = JSON.parse(result.stdout) as {
      verdict?: string
      androidPackagesPresent?: string[]
      sourceAudit?: { semantics?: Record<string, unknown> }
      forbiddenShortcuts?: string[]
    }
    expect(value.verdict).toBe('NO_LEGITIMATE_ANDROID_EXECUTABLE_PATH')
    expect(value.androidPackagesPresent).toEqual([])
    expect(value.sourceAudit?.semantics).toMatchObject({
      resolverParameters: '',
      resolverAcceptsInput: false,
      explicitPathSeam: false,
      directVscodeImport: true,
      pkgSidecarGate: true,
    })
    expect(value.forbiddenShortcuts).toContain(
      'copy/fork official glob/grep implementation solely to replace binary resolution',
    )
  })

  it('detects a future explicit resolver parameter without declaring it compatible', () => {
    const result = runWithSource(
      'export function resolveRgPath(configuredPath?: string): Promise<string> { return Promise.resolve(configuredPath ?? "") }',
    )
    expect(result.status).toBe(0)
    const value = JSON.parse(result.stdout) as { verdict?: string }
    expect(value.verdict).toBe('UPSTREAM_EXPLICIT_PATH_SEAM_PRESENT_REVIEW_REQUIRED')
  })

  it('detects a future explicit config path without declaring it compatible', () => {
    const result = runWithSource([
      'interface Config { ripgrepPath?: string }',
      'export function resolveRgPath(): Promise<string> { return Promise.resolve("") }',
    ].join('\n'))
    expect(result.status).toBe(0)
    const value = JSON.parse(result.stdout) as { verdict?: string }
    expect(value.verdict).toBe('UPSTREAM_EXPLICIT_PATH_SEAM_PRESENT_REVIEW_REQUIRED')
  })

  it('fails when a pinned official source blob identity drifts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-rg-seam-blob-'))
    try {
      const sourcePath = join(dir, 'search-core.ts')
      writeFileSync(sourcePath, 'export function resolveRgPath(): Promise<string> { return Promise.resolve("") }')
      const result = spawnSync(
        process.execPath,
        [audit, '--source', sourcePath, '--expected-git-blob', '0000000000000000000000000000000000000000'],
        { cwd: ROOT, encoding: 'utf8' },
      )
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('official source blob drifted')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
