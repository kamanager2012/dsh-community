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

  it('enforces per-device and global workspace.files concurrency caps in RemoteAdapterCore and deduplicates inspectWorkspaceFiles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-concurrency-'))
    tempDirs.push(dir)
    initGitRepo(dir)
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' })

    // Concurrent calls to inspectWorkspaceFiles coalesce and cache across differing queries/prefixes
    const [r1, r2, r3] = await Promise.all([
      inspectWorkspaceFiles({ sessionId: 's1', query: '' }, dir),
      inspectWorkspaceFiles({ sessionId: 's1', query: 'a.ts' }, dir),
      inspectWorkspaceFiles({ sessionId: 's1', prefix: 'a' }, dir),
    ])
    expect(r1.files).toEqual(['a.ts'])
    expect(r2.files).toEqual(['a.ts'])
    expect(r3.files).toEqual(['a.ts'])

    const resolvers: Array<() => void> = []
    const core = new RemoteAdapterCore(
      {
        listSessions: async () => [{ id: 'dsh-1', cwd: dir }],
        assertSession: async () => {},
        followup: async () => ({ accepted: true }),
        respondApproval: async () => ({ ok: true }),
        respondQuestion: async () => ({ ok: true }),
        listWorkspaceFiles: async (params) => {
          await new Promise<void>((resolve) => {
            resolvers.push(resolve)
          })
          return {
            sessionId: params.sessionId,
            root: dir,
            files: ['a.ts'],
            totalMatched: 1,
            truncated: false,
          }
        },
      },
      {
        maxConcurrentWorkspaceFilesPerDevice: 2,
        maxConcurrentWorkspaceFilesGlobal: 3,
      },
    )

    const hostIdentity = await core.hostIdentityStore.getPublicIdentity()
    const kp1 = await new InMemoryHostIdentityStore().loadOrCreate()
    const kp2 = await new InMemoryHostIdentityStore().loadOrCreate()
    const d1 = core.devices.trust(kp1.identity.publicKey, ['observe'], {
      displayName: 'D1',
      trustDomainId: hostIdentity.trustDomainId,
    })
    const d2 = core.devices.trust(kp2.identity.publicKey, ['observe'], {
      displayName: 'D2',
      trustDomainId: hostIdentity.trustDomainId,
    })
    const peer1: AuthenticatedPeer = {
      deviceId: d1.deviceId,
      publicKey: kp1.identity.publicKey,
      connectionEpoch: 1,
    }
    const peer2: AuthenticatedPeer = {
      deviceId: d2.deviceId,
      publicKey: kp2.identity.publicKey,
      connectionEpoch: 1,
    }

    const callFiles = (peer: AuthenticatedPeer, seq: number) =>
      core.handle(peer, {
        jsonrpc: '2.0',
        id: `wf-${peer.deviceId}-${seq}`,
        method: 'workspace.files',
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        connectionEpoch: 1,
        requestSeq: seq,
        params: { sessionId: 'dsh-1' },
      })

    const waitForResolvers = async (count: number): Promise<void> => {
      for (let i = 0; i < 50 && resolvers.length < count; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      expect(resolvers.length).toBe(count)
    }

    // Peer 1 fills its per-device limit (2 in-flight)
    const p1a = callFiles(peer1, 1)
    const p1b = callFiles(peer1, 2)
    await waitForResolvers(2)

    await expect(callFiles(peer1, 3)).rejects.toMatchObject({ code: 'STATE_CAPACITY_EXCEEDED' })

    // Peer 2 takes the 3rd global slot, filling global capacity (3)
    const p2a = callFiles(peer2, 1)
    await waitForResolvers(3)

    await expect(callFiles(peer2, 2)).rejects.toMatchObject({ code: 'STATE_CAPACITY_EXCEEDED' })

    // Releasing all in-flight calls frees slots cleanly
    while (resolvers.length > 0) {
      resolvers.pop()!()
    }
    await Promise.all([p1a, p1b, p2a])

    const afterRelease = callFiles(peer1, 4)
    await waitForResolvers(1)
    while (resolvers.length > 0) {
      resolvers.pop()!()
    }
    await expect(afterRelease).resolves.toMatchObject({ files: ['a.ts'] })
  })

  it('uses bounded top-K ranking + query cache and enforces per-device workspace.files rate budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-rate-topk-'))
    tempDirs.push(dir)
    initGitRepo(dir)

    // Seed > 600 matching files plus an exact basename match placed late lexicographically
    for (let i = 0; i < 600; i += 1) {
      writeFileSync(join(dir, `z_${String(i).padStart(3, '0')}_target_match.ts`), '', 'utf8')
    }
    mkdirSync(join(dir, 'z_nested'), { recursive: true })
    writeFileSync(join(dir, 'z_nested', 'target.ts'), '', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: dir, stdio: 'pipe' })

    const topLimited = await inspectWorkspaceFiles(
      { sessionId: 's-topk', query: 'target.ts', limit: 3 },
      dir,
    )
    expect(topLimited.files).toEqual(['z_nested/target.ts'])
    expect(topLimited.totalMatched).toBe(1)

    const matchAll = await inspectWorkspaceFiles(
      { sessionId: 's-topk', query: 'target', limit: 5 },
      dir,
    )
    expect(matchAll.files[0]).toBe('z_nested/target.ts')
    expect(matchAll.files).toHaveLength(5)
    expect(matchAll.totalMatched).toBe(601)
    expect(matchAll.truncated).toBe(true)

    // Query cache returns defensive copies across hits
    matchAll.files.push('mutated.ts')
    const cachedHit = await inspectWorkspaceFiles(
      { sessionId: 's-topk', query: 'target', limit: 5 },
      dir,
    )
    expect(cachedHit.files).toHaveLength(5)
    expect(cachedHit.files).not.toContain('mutated.ts')

    // Per-device rate budget blocks rapid sequential loops without blocking other devices
    const core = new RemoteAdapterCore(
      {
        listSessions: async () => [{ id: 'dsh-1', cwd: dir }],
        assertSession: async () => {},
        followup: async () => ({ accepted: true }),
        respondApproval: async () => ({ ok: true }),
        respondQuestion: async () => ({ ok: true }),
        listWorkspaceFiles: (params) => inspectWorkspaceFiles(params, dir),
      },
      {
        maxWorkspaceFilesRequestsPerWindow: 2,
        workspaceFilesRateWindowMs: 60,
      },
    )

    const hostIdentity = await core.hostIdentityStore.getPublicIdentity()
    const kp1 = await new InMemoryHostIdentityStore().loadOrCreate()
    const kp2 = await new InMemoryHostIdentityStore().loadOrCreate()
    const d1 = core.devices.trust(kp1.identity.publicKey, ['observe'], {
      displayName: 'D1',
      trustDomainId: hostIdentity.trustDomainId,
    })
    const d2 = core.devices.trust(kp2.identity.publicKey, ['observe'], {
      displayName: 'D2',
      trustDomainId: hostIdentity.trustDomainId,
    })
    const peer1: AuthenticatedPeer = {
      deviceId: d1.deviceId,
      publicKey: kp1.identity.publicKey,
      connectionEpoch: 1,
    }
    const peer2: AuthenticatedPeer = {
      deviceId: d2.deviceId,
      publicKey: kp2.identity.publicKey,
      connectionEpoch: 1,
    }

    const callFiles = (peer: AuthenticatedPeer, seq: number) =>
      core.handle(peer, {
        jsonrpc: '2.0',
        id: `wf-rate-${peer.deviceId}-${seq}`,
        method: 'workspace.files',
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        connectionEpoch: 1,
        requestSeq: seq,
        params: { sessionId: 'dsh-1', query: 'target', limit: 2 },
      })

    await expect(callFiles(peer1, 1)).resolves.toMatchObject({ totalMatched: 601 })
    await expect(callFiles(peer1, 2)).resolves.toMatchObject({ totalMatched: 601 })
    await expect(callFiles(peer1, 3)).rejects.toMatchObject({ code: 'STATE_CAPACITY_EXCEEDED' })

    // Peer 2 maintains its independent rate budget
    await expect(callFiles(peer2, 1)).resolves.toMatchObject({ totalMatched: 601 })

    // Peer 1 recovers after rate window expires
    await new Promise((resolve) => setTimeout(resolve, 75))
    await expect(callFiles(peer1, 4)).resolves.toMatchObject({ totalMatched: 601 })
  })
})
