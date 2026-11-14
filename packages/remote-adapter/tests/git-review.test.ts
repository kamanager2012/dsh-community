import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  boundSessionListPayload,
  enrichSessionsWithWorkspaceSummaries,
  inspectSessionWorkspaceSummary,
  inspectWorkspaceGitDiff,
  inspectWorkspaceGitStatus,
  RemoteProtocolError,
  resolveGitRepoRoot,
} from '../src/index.js'

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'pipe' })
}

describe('scoped read-only git review helpers', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('inspects status, staged/unstaged diffs, untracked previews, and multibyte truncation safely', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'dsh-git-review-'))
    tempDirs.push(repoDir)
    initGitRepo(repoDir)

    const nestedDir = join(repoDir, 'src')
    mkdirSync(nestedDir, { recursive: true })
    writeFileSync(join(repoDir, 'README.md'), '# Repo\nline 2\n', 'utf8')
    writeFileSync(join(nestedDir, 'app.ts'), 'export const value = 1\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' })

    // Nested subdirectory resolves to repo root
    expect(await resolveGitRepoRoot(nestedDir)).toBe(repoDir)

    // Unstaged modification (>1024B multibyte to exercise truncation boundary) + staged addition + untracked file
    const multibytePad = '你好世界'.repeat(120)
    writeFileSync(join(nestedDir, 'app.ts'), `export const value = 2 // ${multibytePad}\n`, 'utf8')
    writeFileSync(join(repoDir, 'staged.txt'), 'staged content\n', 'utf8')
    execFileSync('git', ['add', 'staged.txt'], { cwd: repoDir, stdio: 'pipe' })
    writeFileSync(join(repoDir, 'notes.md'), 'untracked note line 1\nuntracked note line 2\n', 'utf8')

    const status = await inspectWorkspaceGitStatus('s-git-1', nestedDir)
    expect(status.sessionId).toBe('s-git-1')
    expect(status.clean).toBe(false)
    expect(status.repoRoot).toBe(repoDir)
    expect(status.branch).toBe('main')
    const appEntry = status.files.find((f) => f.path === 'src/app.ts')
    expect(appEntry?.unstaged).toBe(true)
    expect(appEntry?.worktreeStatus).toBe('M')
    expect(status.files.find((f) => f.path === 'staged.txt')?.staged).toBe(true)
    expect(status.files.find((f) => f.path === 'notes.md')?.untracked).toBe(true)

    const fileDiff = await inspectWorkspaceGitDiff({ sessionId: 's-git-1', path: 'src/app.ts' }, nestedDir)
    expect(fileDiff.diff).toContain('+export const value = 2 // 你好世界')
    expect(fileDiff.truncated).toBe(false)

    const stagedDiff = await inspectWorkspaceGitDiff({ sessionId: 's-git-1', path: 'staged.txt', staged: true }, repoDir)
    expect(stagedDiff.staged).toBe(true)
    expect(stagedDiff.diff).toContain('+staged content')

    const untrackedDiff = await inspectWorkspaceGitDiff({ sessionId: 's-git-1', path: 'notes.md' }, repoDir)
    expect(untrackedDiff.diff).toContain('+untracked note line 1')

    // UTF-8 multibyte safe truncation check (no replacement chars)
    const truncated = await inspectWorkspaceGitDiff({ sessionId: 's-git-1', path: 'src/app.ts', maxBytes: 1024 }, repoDir)
    expect(truncated.truncated).toBe(true)
    expect(Buffer.byteLength(truncated.diff, 'utf8')).toBeLessThanOrEqual(1024)
    expect(truncated.diff.includes('\uFFFD')).toBe(false)
  })

  it('rejects non-git folders, path traversal, flag injection, and out-of-repo symlinks', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'dsh-git-sec-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'dsh-git-outside-'))
    tempDirs.push(repoDir, outsideDir)

    await expect(resolveGitRepoRoot(outsideDir)).rejects.toMatchObject({
      name: 'RemoteProtocolError',
      code: 'INVALID_REQUEST',
    })

    initGitRepo(repoDir)
    writeFileSync(join(outsideDir, 'secret.txt'), 'TOP_SECRET\n', 'utf8')
    symlinkSync(join(outsideDir, 'secret.txt'), join(repoDir, 'leak.txt'))

    for (const badPath of ['../secret.txt', '/etc/passwd', '~/secret', '-p', '--output=/tmp/x', 'a\nb']) {
      await expect(
        inspectWorkspaceGitDiff({ sessionId: 's-sec', path: badPath }, repoDir),
      ).rejects.toBeInstanceOf(RemoteProtocolError)
    }

    await expect(
      inspectWorkspaceGitDiff({ sessionId: 's-sec', path: 'leak.txt' }, repoDir),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })

  it('streams and truncates huge multi-hundred-KB diffs cleanly without maxBuffer failure', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'dsh-git-large-'))
    tempDirs.push(repoDir)
    initGitRepo(repoDir)

    writeFileSync(join(repoDir, 'big.txt'), 'line-0\n', 'utf8')
    execFileSync('git', ['add', 'big.txt'], { cwd: repoDir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'init big'], { cwd: repoDir, stdio: 'pipe' })

    const largeBody = Array.from({ length: 12000 }, (_, i) => `row-${i}-你好世界-${'x'.repeat(32)}`).join('\n')
    writeFileSync(join(repoDir, 'big.txt'), `${largeBody}\n`, 'utf8')

    const res = await inspectWorkspaceGitDiff({ sessionId: 's-big', maxBytes: 2048 }, repoDir)
    expect(res.truncated).toBe(true)
    expect(res.bytes).toBeLessThanOrEqual(2048)
    expect(Buffer.byteLength(res.diff, 'utf8')).toBe(res.bytes)
    expect(res.diff.includes('\uFFFD')).toBe(false)
  })

  it('enumerates files inside untracked directories individually and includes bounded untracked previews in unfiltered diff', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'dsh-git-untracked-dir-'))
    tempDirs.push(repoDir)
    initGitRepo(repoDir)

    writeFileSync(join(repoDir, 'tracked.txt'), 'v1\n', 'utf8')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repoDir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' })

    const newSubDir = join(repoDir, 'new-dir', 'nested')
    mkdirSync(newSubDir, { recursive: true })
    writeFileSync(join(repoDir, 'new-dir', 'new.txt'), 'brand new line\n', 'utf8')
    writeFileSync(join(newSubDir, 'deep.ts'), 'export const deep = true\n', 'utf8')

    const status = await inspectWorkspaceGitStatus('s-untracked', repoDir)
    const paths = status.files.map((f) => f.path)
    expect(paths).toContain('new-dir/new.txt')
    expect(paths).toContain('new-dir/nested/deep.ts')
    expect(paths.some((p) => p.endsWith('/'))).toBe(false)

    // Individual untracked nested file path succeeds directly
    const singleDiff = await inspectWorkspaceGitDiff(
      { sessionId: 's-untracked', path: 'new-dir/new.txt' },
      repoDir,
    )
    expect(singleDiff.diff).toContain('+brand new line')

    // Unfiltered unstaged diff also includes untracked files and stays bounded by maxBytes
    const allDiff = await inspectWorkspaceGitDiff({ sessionId: 's-untracked' }, repoDir)
    expect(allDiff.diff).toContain('+brand new line')
    expect(allDiff.diff).toContain('+export const deep = true')
  })

  it('groups linked git worktrees under commonRepoRoot and enriches sessions without mutating non-git sessions', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'dsh-git-main-'))
    const wtDir = join(tmpdir(), `dsh-git-wt-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`)
    const plainDir = mkdtempSync(join(tmpdir(), 'dsh-plain-dir-'))
    tempDirs.push(repoDir, wtDir, plainDir)
    initGitRepo(repoDir)

    writeFileSync(join(repoDir, 'base.ts'), 'export const base = 1\n', 'utf8')
    execFileSync('git', ['add', 'base.ts'], { cwd: repoDir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'init main'], { cwd: repoDir, stdio: 'pipe' })
    execFileSync('git', ['worktree', 'add', '-b', 'feat/mobile-ui', wtDir], { cwd: repoDir, stdio: 'pipe' })

    writeFileSync(join(wtDir, 'feature.ts'), 'export const ui = true\n', 'utf8')

    const mainSummary = await inspectSessionWorkspaceSummary(repoDir, { forceRefresh: true })
    const wtSummary = await inspectSessionWorkspaceSummary(wtDir, { forceRefresh: true })
    const plainSummary = await inspectSessionWorkspaceSummary(plainDir, { forceRefresh: true })

    expect(mainSummary).toBeDefined()
    expect(mainSummary?.branch).toBe('main')
    expect(mainSummary?.dirty).toBe(false)
    expect(mainSummary?.isWorktree).toBeUndefined()
    expect(mainSummary?.commonRepoRoot).toBe(mainSummary?.repoRoot)

    expect(wtSummary).toBeDefined()
    expect(wtSummary?.branch).toBe('feat/mobile-ui')
    expect(wtSummary?.dirty).toBe(true)
    expect(wtSummary?.changedFiles).toBe(1)
    expect(wtSummary?.isWorktree).toBe(true)
    expect(wtSummary?.commonRepoRoot).toBe(mainSummary?.commonRepoRoot)

    expect(plainSummary).toBeUndefined()

    const wtStatus = await inspectWorkspaceGitStatus('s-wt', wtDir)
    expect(wtStatus.isWorktree).toBe(true)
    expect(wtStatus.commonRepoRoot).toBe(mainSummary?.commonRepoRoot)

    const enriched = await enrichSessionsWithWorkspaceSummaries([
      { id: 's-main', cwd: repoDir, updatedAtMs: 100 },
      { id: 's-wt', cwd: wtDir, updatedAtMs: 200 },
      { id: 's-plain', cwd: plainDir, updatedAtMs: 50 },
      { id: 's-bare', title: 'No CWD' },
    ], { forceRefresh: true })
    expect(enriched[0]?.workspace?.branch).toBe('main')
    expect(enriched[1]?.workspace?.commonRepoRoot).toBe(enriched[0]?.workspace?.commonRepoRoot)
    expect(enriched[2]?.workspace).toBeUndefined()
    expect(enriched[3]).toEqual({ id: 's-bare', title: 'No CWD' })
  })

  it('preserves oldest active sessions when bounding oversized session list payloads', () => {
    const longTitle = 'T'.repeat(240)
    const sessions = Array.from({ length: 150 }, (_, idx) => {
      const isOldest = idx === 149
      return {
        id: `codex:sess-${String(idx).padStart(3, '0')}`,
        engine: 'codex' as const,
        title: `${idx}-${longTitle}`,
        updatedAtMs: 1000 - idx,
        status: isOldest ? ('running' as const) : ('idle' as const),
        ...(isOldest ? { pendingApprovals: 1 } : {}),
      }
    })
    const activeIds = new Set(['codex:sess-149'])
    const bounded = boundSessionListPayload(sessions, activeIds)
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(44 * 1024)
    expect(bounded.some((s) => s.id === 'codex:sess-149')).toBe(true)
    expect(bounded.length).toBeLessThan(150)
    expect(bounded.length).toBeGreaterThan(100)
  })
})
