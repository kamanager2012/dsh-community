import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  InMemoryHostIdentityStore,
  inspectWorkspaceFiles,
  REMOTE_PROTOCOL_VERSION,
  RemoteAdapterCore,
  RemoteProtocolError,
  type AuthenticatedPeer,
} from '../src/index.js'

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'pipe' })
}

describe('bounded read-only workspace.files RPC and helpers', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
  })

  it('lists git tracked + untracked files, respects .gitignore, ranks matches, and blocks symlink escapes', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-ws-files-'))
    tempDirs.push(base)
    const repo = join(base, 'repo')
    const outside = join(base, 'outside')
    mkdirSync(join(repo, 'apps', 'web'), { recursive: true })
    mkdirSync(join(repo, 'packages', 'core'), { recursive: true })
    mkdirSync(join(repo, 'ignored-dir'), { recursive: true })
    mkdirSync(outside, { recursive: true })

    initGitRepo(repo)
    writeFileSync(join(repo, '.gitignore'), 'ignored-dir/\n*.log\n', 'utf8')
    writeFileSync(join(repo, 'README.md'), '# Hello\n', 'utf8')
    writeFileSync(join(repo, 'packages', 'core', 'timeline.ts'), 'export {}\n', 'utf8')
    writeFileSync(join(repo, 'apps', 'web', 'main.ts'), 'export {}\n', 'utf8')
    writeFileSync(join(repo, 'apps', 'web', 'timeline-helper.ts'), 'export {}\n', 'utf8')
    writeFileSync(join(repo, 'ignored-dir', 'secret.txt'), 'hidden\n', 'utf8')
    writeFileSync(join(repo, 'debug.log'), 'ignored log\n', 'utf8')
    writeFileSync(join(outside, 'leak.txt'), 'secret outside\n', 'utf8')
    symlinkSync(join(outside, 'leak.txt'), join(repo, 'escape-link.txt'))
    execFileSync('git', ['add', '.gitignore', 'README.md', 'packages/core/timeline.ts'], {
      cwd: repo,
      stdio: 'pipe',
    })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'pipe' })
    execFileSync('git', ['add', 'escape-link.txt'], { cwd: repo, stdio: 'pipe' })

    const all = await inspectWorkspaceFiles({ sessionId: 's1' }, repo)
    expect(all.root).toBe(realpathSync(repo))
    expect(all.files).toContain('README.md')
    expect(all.files).toContain('apps/web/main.ts')
    expect(all.files).toContain('packages/core/timeline.ts')
    expect(all.files).not.toContain('ignored-dir/secret.txt')
    expect(all.files).not.toContain('debug.log')
    expect(all.files).not.toContain('escape-link.txt')

    // Ranking puts basename match before substring/path match
    const qRes = await inspectWorkspaceFiles({ sessionId: 's1', query: 'timeline' }, repo)
    expect(qRes.files[0]).toBe('packages/core/timeline.ts')
    expect(qRes.files).toContain('apps/web/timeline-helper.ts')

    // Directory prefix filtering
    const pRes = await inspectWorkspaceFiles({ sessionId: 's1', prefix: 'apps/web/' }, repo)
    expect(pRes.files).toEqual(['apps/web/main.ts', 'apps/web/timeline-helper.ts'])

    // Limit + payload truncation reporting
    const limited = await inspectWorkspaceFiles({ sessionId: 's1', limit: 2 }, repo)
    expect(limited.files).toHaveLength(2)
    expect(limited.totalMatched).toBeGreaterThanOrEqual(4)
    expect(limited.truncated).toBe(true)
  })

  it('falls back to bounded non-git directory walk skipping symlinks and node_modules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-nongit-'))
    const outside = mkdtempSync(join(tmpdir(), 'dsh-ws-outside-'))
    tempDirs.push(dir, outside)

    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'src', 'index.ts'), 'export {}\n', 'utf8')
    writeFileSync(join(dir, 'node_modules', 'pkg', 'ignored.js'), 'module.exports = {}\n', 'utf8')
    writeFileSync(join(outside, 'secret.txt'), 'nope\n', 'utf8')
    symlinkSync(outside, join(dir, 'linked-outside'))

    const res = await inspectWorkspaceFiles({ sessionId: 's2' }, dir)
    expect(res.files).toEqual(['src/index.ts'])
    expect(res.truncated).toBe(false)
  })

  it('enforces observe capability, parameter safety validation, and Noise frame payload bounds in RemoteAdapterCore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-core-'))
    tempDirs.push(dir)
    for (let i = 0; i < 1_500; i += 1) {
      const folder = join(dir, `dir_${String(i % 25).padStart(2, '0')}`)
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, `very_long_workspace_filename_entry_${String(i).padStart(4, '0')}.ts`), '', 'utf8')
    }

    const core = new RemoteAdapterCore({
      listSessions: async () => [{ id: 'dsh-1', cwd: dir }],
      assertSession: async (sessionId) => {
        if (sessionId !== 'dsh-1') throw new RemoteProtocolError('SESSION_NOT_FOUND', 'missing session')
      },
      followup: async () => ({ accepted: true }),
      respondApproval: async () => ({ ok: true }),
      respondQuestion: async () => ({ ok: true }),
      listWorkspaceFiles: (params) => inspectWorkspaceFiles(params, dir),
    })

    const kp = await new InMemoryHostIdentityStore().loadOrCreate()
    const trustDomainId = (await core.hostIdentityStore.getPublicIdentity()).trustDomainId
    const record = core.devices.trust(kp.identity.publicKey, ['observe'], {
      displayName: 'Viewer',
      trustDomainId,
    })
    const peer: AuthenticatedPeer = {
      deviceId: record.deviceId,
      publicKey: kp.identity.publicKey,
      connectionEpoch: 1,
    }

    const res = (await core.handle(peer, {
      jsonrpc: '2.0',
      id: 'wf-1',
      method: 'workspace.files',
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      connectionEpoch: 1,
      requestSeq: 1,
      params: { sessionId: 'dsh-1', limit: 2000 },
    })) as { files: string[]; totalMatched: number; truncated: boolean }
    expect(res.totalMatched).toBe(1500)
    expect(res.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(res), 'utf8')).toBeLessThan(65_519)

    await expect(
      core.handle(peer, {
        jsonrpc: '2.0',
        id: 'wf-bad-1',
        method: 'workspace.files',
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        connectionEpoch: 1,
        requestSeq: 2,
        params: { sessionId: 'dsh-1', prefix: '../outside' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })

    await expect(
      core.handle(peer, {
        jsonrpc: '2.0',
        id: 'wf-bad-2',
        method: 'workspace.files',
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        connectionEpoch: 1,
        requestSeq: 3,
        params: { sessionId: 'dsh-1', limit: 5000 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})
