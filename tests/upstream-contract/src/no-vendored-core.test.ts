import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const thisFile = fileURLToPath(import.meta.url)

/** Official monorepo paths that must never appear in this community repo — at any depth. */
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

/**
 * Content-level fingerprints of the official kernel: internal package names
 * from contracts/upstream/packages.snapshot.json that have zero legitimate use
 * in community source (our own code only ever depends on `@deepseek-ai/dsh`
 * and `@deepseek-ai/dsh-base`, and those imports live in package.json / docs).
 * A hit means official implementation code was copied in under a new name.
 */
export const OFFICIAL_KERNEL_FINGERPRINTS = [
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-tool-str-replace-editor',
  '@deepseek-ai/dsh-subagent-fork-in-process',
  '@deepseek-ai/dsh-web-app/startup',
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/dsh-client-ui-cordis',
] as const

const FORBIDDEN_BASENAMES = new Set([
  'agent-loop.ts',
  'deriveMessages.ts',
])

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'runtime-stage',
  'runtime-host',
  '.pack-root',
  'release',
])

/** Contracts snapshots are allowed evidence; they are .json and never scanned. */
const FINGERPRINT_EXTS = new Set(['.ts', '.tsx', '.mjs'])

function walkFiles(dir: string, into: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walkFiles(full, into)
      continue
    }
    if (stat.isFile()) into.push(full)
  }
}

/** Contiguous segment-sequence match, so renamed or nested copies still hit. */
export function containsSegmentSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

function relativeSegments(file: string, root: string): string[] {
  return relative(root, file).split(/[\\/]/u)
}

export function forbiddenPathHits(files: readonly string[], root: string): string[] {
  const sequences = FORBIDDEN_RELATIVE.map((path) => path.split('/'))
  return files
    .filter((file) => {
      const segments = relativeSegments(file, root)
      return sequences.some((sequence) => containsSegmentSequence(segments, sequence))
    })
    .map((file) => relative(root, file))
}

export interface SourceEntry {
  readonly path: string
  readonly content: string
}

export function fingerprintHits(
  entries: readonly SourceEntry[],
  fingerprints: readonly string[] = OFFICIAL_KERNEL_FINGERPRINTS,
): { file: string; fingerprint: string }[] {
  const hits: { file: string; fingerprint: string }[] = []
  for (const entry of entries) {
    for (const fingerprint of fingerprints) {
      if (entry.content.includes(fingerprint)) hits.push({ file: entry.path, fingerprint })
    }
  }
  return hits
}

function collectRepoSourceEntries(): SourceEntry[] {
  const files: string[] = []
  walkFiles(repoRoot, files)
  return files
    .filter((file) => {
      if (file === thisFile) return false
      const dot = file.lastIndexOf('.')
      return dot !== -1 && FINGERPRINT_EXTS.has(file.slice(dot).toLowerCase())
    })
    .map((file) => ({ path: relative(repoRoot, file), content: readFileSync(file, 'utf8') }))
}

describe('this repo is not a fork of official DSH', () => {
  it('does not contain official core / app trees at any depth', () => {
    expect(existsSync(join(repoRoot, 'pnpm-workspace.yaml'))).toBe(true)
    const files: string[] = []
    walkFiles(repoRoot, files)
    expect(forbiddenPathHits(files, repoRoot)).toEqual([])
  })

  it('detects forbidden trees even when renamed into a nested vendor dir', () => {
    const fake = [
      '/repo/vendor/official-copy/apps/cli/index.js',
      '/repo/src/vendor/deepseek-harness/x.ts',
    ]
    const clean = ['/repo/src/index.ts', '/repo/apps/tui/src/bin.ts', '/repo/packages/core-utils/rename.ts']
    expect(forbiddenPathHits(fake, '/repo')).toEqual([
      'vendor/official-copy/apps/cli/index.js',
      'src/vendor/deepseek-harness/x.ts',
    ])
    expect(forbiddenPathHits(clean, '/repo')).toEqual([])
  })

  it('does not check in official loop internals', () => {
    const files: string[] = []
    walkFiles(repoRoot, files)
    const hits = files
      .filter((file) => FORBIDDEN_BASENAMES.has(file.split(/[\\/]/u).at(-1) ?? ''))
      .map((file) => relative(repoRoot, file))
    expect(hits).toEqual([])
  })

  it('contains no official kernel identifiers in any source file', () => {
    expect(fingerprintHits(collectRepoSourceEntries())).toEqual([])
  })

  it('flags copied kernel content by its internal identifiers', () => {
    const vendored = [
      { path: 'src/surface/engine.ts', content: "import { loop } from '@deepseek-ai/dsh-agent-loop'" },
    ]
    const ours = [{ path: 'src/surface/engine.ts', content: "import { resolveOfficialDsh } from '@dsh-community/dsh-bridge'" }]
    expect(fingerprintHits(vendored)).toHaveLength(1)
    expect(fingerprintHits(ours)).toEqual([])
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
