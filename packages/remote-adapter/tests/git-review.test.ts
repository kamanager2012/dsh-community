import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
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
})
