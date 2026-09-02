import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const audit = resolve(ROOT, 'scripts/audit-android-upstream-drift.mjs')

function write(root: string, path: string, content: string) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function fixture(options: {
  subprocessAndroid?: boolean
  sandboxAndroid?: boolean
  fsSearchSeam?: boolean
  sessionHardlink?: boolean
  attachmentHardlink?: boolean
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-android-upstream-drift-'))
  write(root, 'apps/cli/package.json', JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: '0.1.2-alpha.4',
  }))
  write(
    root,
    'packages/subprocess/subprocess-local/src/process-inspector.ts',
    options.subprocessAndroid
      ? "switch (process.platform) { case 'android': return androidInspector() }"
      : "switch (process.platform) { case 'linux': break; case 'darwin': break; case 'win32': break }",
  )
  write(
    root,
    'packages/sandbox/sandbox-local/src/index.ts',
    options.sandboxAndroid
      ? "const PLATFORM_CHAINS = { linux: [], android: [] }"
      : "const PLATFORM_CHAINS = { linux: [], darwin: [], win32: [] }",
  )
  write(
    root,
    'packages/fs/tool-fs-search/src/search-core.ts',
    options.fsSearchSeam
      ? 'export function resolveRgPath(configuredPath?: string) { return Promise.resolve(configuredPath ?? "") }'
      : [
          'export function resolveRgPath() {',
          "  if ('pkg' in process) return Promise.resolve(process.execPath + '-rg')",
          "  return import('@vscode/ripgrep').then(x => x.rgPath)",
          '}',
        ].join('\n'),
  )
  write(
    root,
    'packages/session/session-persistence-jsonl/src/index.ts',
    options.sessionHardlink === false
      ? 'await rename(temporary, target)'
      : 'await link(temporary, target); await unlink(temporary)',
  )
  write(
    root,
    'packages/attachment/attachment-local/src/store.ts',
    options.attachmentHardlink === false
      ? 'await rename(temporary, target)'
      : 'await link(temporary, target); await unlink(temporary)',
  )
  return root
}

function run(root: string) {
  return spawnSync(
    process.execPath,
    [audit, '--official-source-root', root],
    { cwd: ROOT, encoding: 'utf8' },
  )
}

describe('Android upstream drift audit', () => {
  it('accepts the current alpha4-shaped Android seam baseline', () => {
    const root = fixture()
    try {
      const result = run(root)
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      const value = JSON.parse(result.stdout) as {
        verdict?: string
        signals?: Record<string, boolean>
        reviewReasons?: string[]
      }
      expect(value.verdict).toBe('NO_DRIFT')
      expect(value.reviewReasons).toEqual([])
      expect(value.signals).toEqual({
        subprocessOfficialAndroidInspector: false,
        sandboxOfficialAndroidChain: false,
        fsSearchExplicitPathSeam: false,
        fsSearchAndroidPlatformPackage: false,
        sessionUsesHardlinkPublication: true,
        attachmentUsesHardlinkPublication: true,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stops an upgrade when official Android subprocess or sandbox support appears', () => {
    const root = fixture({ subprocessAndroid: true, sandboxAndroid: true })
    try {
      const result = run(root)
      expect(result.status).toBe(2)
      const value = JSON.parse(result.stdout) as {
        verdict?: string
        reviewReasons?: string[]
      }
      expect(value.verdict).toBe('REVIEW_REQUIRED')
      expect(value.reviewReasons).toContain(
        'subprocessOfficialAndroidInspector drifted: expected false, observed true',
      )
      expect(value.reviewReasons).toContain(
        'sandboxOfficialAndroidChain drifted: expected false, observed true',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stops an upgrade when official fs-search exposes a legitimate path seam', () => {
    const root = fixture({ fsSearchSeam: true })
    try {
      const result = run(root)
      expect(result.status).toBe(2)
      const value = JSON.parse(result.stdout) as {
        verdict?: string
        reviewReasons?: string[]
      }
      expect(value.verdict).toBe('REVIEW_REQUIRED')
      expect(value.reviewReasons).toContain(
        'fsSearchExplicitPathSeam drifted: expected false, observed true',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stops an upgrade when official storage no longer requires hard-link publication', () => {
    const root = fixture({ sessionHardlink: false, attachmentHardlink: false })
    try {
      const result = run(root)
      expect(result.status).toBe(2)
      const value = JSON.parse(result.stdout) as {
        verdict?: string
        reviewReasons?: string[]
      }
      expect(value.verdict).toBe('REVIEW_REQUIRED')
      expect(value.reviewReasons).toContain(
        'sessionUsesHardlinkPublication drifted: expected true, observed false',
      )
      expect(value.reviewReasons).toContain(
        'attachmentUsesHardlinkPublication drifted: expected true, observed false',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
