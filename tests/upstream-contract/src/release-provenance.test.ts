import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const verifier = join(root, 'scripts/release-provenance.mjs')
const dirs: string[] = []
const tag = 'v0.2.2-rc.3-community.2'

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  expect(r.status, r.stderr || r.error?.message).toBe(0)
  return r.stdout.trim()
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-release-prov-'))
  dirs.push(base)
  const bare = join(base, 'origin.git')
  const work = join(base, 'work')
  mkdirSync(work)
  git(base, 'init', '-q', '--bare', '-b', 'main', bare)
  git(work, 'init', '-q', '-b', 'main')
  git(work, 'config', 'user.name', 'DSH Test')
  git(work, 'config', 'user.email', 'dsh@example.invalid')
  writeFileSync(join(work, 'README.md'), 'first\n')
  git(work, 'add', 'README.md')
  git(work, 'commit', '-qm', 'first')
  git(work, 'remote', 'add', 'origin', bare)
  git(work, 'push', '-q', '-u', 'origin', 'main')
  return { work, bare, head: git(work, 'rev-parse', 'HEAD') }
}

function verify(work: string, mode: string, expectedSha?: string) {
  return spawnSync(process.execPath, [verifier, mode, tag, 'origin', ...(expectedSha === undefined ? [] : [expectedSha])], { cwd: work, encoding: 'utf8' })
}

afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('immutable release source provenance', () => {
  it('accepts only a reviewed main HEAD when the release tag is absent', () => {
    const { work, head } = fixture()
    const r = verify(work, 'candidate')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain(head)
  })

  it('rejects an unreviewed local branch even when its HEAD is identical to main', () => {
    const { work } = fixture()
    git(work, 'switch', '-qc', 'feature')
    const r = verify(work, 'candidate')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('local main')
  })

  it('rejects stale main after remote main has advanced', () => {
    const { work, head } = fixture()
    writeFileSync(join(work, 'README.md'), 'second\n')
    git(work, 'add', 'README.md')
    git(work, 'commit', '-qm', 'second')
    git(work, 'push', '-q', 'origin', 'main')
    git(work, 'reset', '-q', '--hard', head)
    const r = verify(work, 'candidate')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('differs from candidate HEAD')
  })

  it('rejects a tag that exists only on the remote, not locally', () => {
    const { work } = fixture()
    git(work, 'tag', tag)
    git(work, 'push', '-q', 'origin', 'refs/tags/' + tag)
    git(work, 'tag', '-d', tag)
    const r = verify(work, 'candidate')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('release tag already exists')
  })

  it('accepts a pushed lightweight release tag matching reviewed main and GITHUB_SHA', () => {
    const { work, head } = fixture()
    git(work, 'tag', tag)
    git(work, 'push', '-q', 'origin', 'refs/tags/' + tag)
    const r = verify(work, 'tagged', head)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain(head)
  })

  it('quarantines a failed publication even if gh deletes the partial Draft', () => {
    const { work, head } = fixture()
    git(work, 'tag', tag)
    git(work, 'push', '-q', 'origin', 'refs/tags/' + tag)
    expect(verify(work, 'tagged', head).status).toBe(0)
    // gh release create can clean up its Draft after an asset-upload error.
    // The independent attempt ref survives; no GitHub Release is required.
    git(work, 'tag', 'release-attempt-' + tag)
    git(work, 'push', '-q', 'origin', 'refs/tags/release-attempt-' + tag)
    const retry = verify(work, 'tagged', head)
    expect(retry.status).toBe(1)
    expect(retry.stderr).toContain('release attempt already recorded')
  })
  it('peels an annotated Git tag to its commit and rejects a forged GITHUB_SHA', () => {
    const { work, head } = fixture()
    git(work, 'tag', '-a', tag, '-m', 'signed-off test annotation')
    git(work, 'push', '-q', 'origin', 'refs/tags/' + tag)
    expect(verify(work, 'tagged', head).status).toBe(0)
    const bad = verify(work, 'tagged', '0'.repeat(40))
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('does not match GITHUB_SHA')
  })

  it('rejects a tag whose peeled commit is not the current reviewed main commit', () => {
    const { work } = fixture()
    git(work, 'tag', tag)
    git(work, 'push', '-q', 'origin', 'refs/tags/' + tag)
    writeFileSync(join(work, 'README.md'), 'newer\n')
    git(work, 'add', 'README.md')
    git(work, 'commit', '-qm', 'newer')
    git(work, 'push', '-q', 'origin', 'main')
    const newHead = git(work, 'rev-parse', 'HEAD')
    const r = verify(work, 'tagged', newHead)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('no longer points to reviewed main commit')
  })

  it('prevents release backfill, metadata edits, and auto-created tags in the tagged workflow', () => {
    const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')
    expect(workflow).toContain('node scripts/release-provenance.mjs tagged')
    expect(workflow).toContain('cancel-in-progress: false')
    expect(workflow).toContain('gh release create "$TAG" --verify-tag')
    expect(workflow).not.toMatch(/gh\s+release\s+(?:upload|edit)\b/u)
    expect(workflow).not.toContain('uploading missing asset groups')
    expect(workflow).toContain('release already exists; immutable tag requires a new version')
  })
})
