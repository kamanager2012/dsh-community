import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Official monorepo paths that must never appear in this community repo. */
const FORBIDDEN_RELATIVE = [
  'apps/cli',
  'apps/web',
  'packages/core',
  'packages/session',
  'packages/agent',
  'packages/llm',
  'packages/bundle',
  'packages/host',
  'vendor/deepseek-harness',
  'deepseek-harness',
]

const FORBIDDEN_BASENAMES = new Set([
  'agent-loop.ts',
  'deriveMessages.ts',
])

function walkFiles(dir: string, into: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git' || name === 'runtime-stage' || name === 'runtime-host') continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walkFiles(full, into)
      continue
    }
    if (stat.isFile()) into.push(full)
  }
}

describe('this repo is not a fork of official DSH', () => {
  it('does not contain official core / app trees', () => {
    const present = FORBIDDEN_RELATIVE.filter((rel) => existsSync(join(repoRoot, rel)))
    expect(present).toEqual([])
  })

  it('does not check in official loop internals', () => {
    const files: string[] = []
    walkFiles(repoRoot, files)
    const hits = files
      .filter((file) => FORBIDDEN_BASENAMES.has(file.split(/[\\/]/u).at(-1) ?? ''))
      .map((file) => relative(repoRoot, file))
    expect(hits).toEqual([])
  })

  it('README states official dsh is the only runtime', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
    expect(readme).toMatch(/@deepseek-ai\/dsh/)
    expect(readme).toMatch(/不 vendor|not vendor/i)
  })

  it('documents reconstruction rather than forking the third-party desktop tree', () => {
    const reconstruction = readFileSync(join(repoRoot, 'docs/reconstruction.md'), 'utf8')
    expect(reconstruction).toMatch(/重构/)
    expect(reconstruction).toMatch(/~\/\.dsh/)
    expect(reconstruction).toMatch(/Desktop Runtime Protocol/)
    expect(reconstruction).toMatch(/Official Source Ownership/)
  })
})
