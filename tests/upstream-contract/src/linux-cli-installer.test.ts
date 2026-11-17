import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const installerPath = resolve(repoRoot, 'scripts/install-linux.sh')

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('Linux/WSL Terminal CLI installer', () => {
  it('supports --help and --dry-run without mutating filesystem or requiring network', () => {
    const help = execFileSync('bash', [installerPath, '--help'], { encoding: 'utf8' })
    expect(help).toContain('Usage: install-linux.sh')
    expect(help).toContain('--local-repo')
    expect(help).toContain('--bin-dir')

    const tmpPrefix = makeTempDir('dsh-inst-dry-prefix-')
    const tmpBin = makeTempDir('dsh-inst-dry-bin-')
    const dry = execFileSync(
      'bash',
      [installerPath, '--dry-run', '--prefix', tmpPrefix, '--bin-dir', tmpBin, '--local-repo', repoRoot],
      { encoding: 'utf8' },
    )
    expect(dry).toContain('[dry-run]')
    expect(dry).toContain('dsh-community, dsh-marketplace')
  })

  it('rejects Node.js versions older than 22.15.0 cleanly (fail-closed)', () => {
    const fakeBin = makeTempDir('dsh-fake-old-node-')
    const fakeNode = join(fakeBin, 'node')
    writeFileSync(
      fakeNode,
      '#!/usr/bin/env bash\nif [ "$1" = "-p" ]; then echo "20.18.0"; exit 0; fi\nexit 2\n',
      'utf8',
    )
    chmodSync(fakeNode, 0o755)

    const result = spawnSync('bash', [installerPath, '--dry-run'], {
      env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` },
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Node.js >= 22.15.0 is required')
  })

  it('creates working dsh-community and dsh-marketplace shims from relative paths with remote-web build and bundled dsh PATH', () => {
    const workRoot = makeTempDir('dsh-inst-work-')
    const fakeRepo = join(workRoot, 'src-repo')
    const fakeToolBin = makeTempDir('dsh-inst-tools-')
    const relPrefix = 'install-prefix'
    const relBinDir = 'out-bin'
    const absPrefix = join(workRoot, relPrefix)
    const absBinDir = join(workRoot, relBinDir)
    const pnpmLog = join(fakeRepo, '.pnpm-calls.log')

    mkdirSync(join(fakeRepo, 'apps/tui/dist'), { recursive: true })
    mkdirSync(join(fakeRepo, 'packages/marketplace/bin'), { recursive: true })
    mkdirSync(join(fakeRepo, 'packages/dsh-bridge/node_modules/.bin'), { recursive: true })
    writeFileSync(
      join(fakeRepo, 'packages/dsh-bridge/node_modules/.bin/dsh'),
      '#!/usr/bin/env sh\necho "BUNDLED_DSH:$*"\n',
      'utf8',
    )
    chmodSync(join(fakeRepo, 'packages/dsh-bridge/node_modules/.bin/dsh'), 0o755)
    writeFileSync(
      join(fakeRepo, 'apps/tui/dist/bin.js'),
      'console.log("SHIM_TUI:" + process.argv.slice(2).join(","));\n',
      'utf8',
    )
    writeFileSync(
      join(fakeRepo, 'packages/marketplace/bin/dsh-marketplace.js'),
      'const cp = require("node:child_process"); console.log("SHIM_MKT:" + process.argv.slice(2).join(",") + ":" + cp.execFileSync("dsh", ["--version"], { encoding: "utf8" }).trim());\n',
      'utf8',
    )

    const fakePnpm = join(fakeToolBin, 'pnpm')
    writeFileSync(
      fakePnpm,
      `#!/usr/bin/env bash\necho "$PWD|$*" >> "${pnpmLog}"\nexit 0\n`,
      'utf8',
    )
    chmodSync(fakePnpm, 0o755)

    const res = spawnSync(
      'bash',
      [installerPath, '--local-repo', 'src-repo', '--prefix', relPrefix, '--bin-dir', relBinDir],
      {
        cwd: workRoot,
        env: { ...process.env, PATH: `${fakeToolBin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      },
    )
    expect(res.status, res.stderr || res.stdout).toBe(0)
    expect(res.stdout).toContain(join(absBinDir, 'dsh-community'))
    expect(res.stdout).toContain(join(absBinDir, 'dsh-marketplace'))

    const logContent = readFileSync(pnpmLog, 'utf8')
    expect(logContent).toMatch(/\.repo\.stage\.[^|]+\|install --frozen-lockfile/u)
    expect(logContent).toContain('@dsh-community/tui')
    expect(logContent).toContain('@dsh-community/remote-web')
    expect(logContent).toContain('@dsh-community/marketplace')

    // Execute from an unrelated cwd to confirm normalized absolute entry paths
    const tuiOut = execFileSync(join(absBinDir, 'dsh-community'), ['doctor', '--porcelain'], {
      cwd: tmpdir(),
      encoding: 'utf8',
    })
    expect(tuiOut.trim()).toBe('SHIM_TUI:doctor,--porcelain')

    const mktOut = execFileSync(join(absBinDir, 'dsh-marketplace'), ['list'], {
      cwd: tmpdir(),
      encoding: 'utf8',
    })
    expect(mktOut.trim()).toBe('SHIM_MKT:list:BUNDLED_DSH:--version')
  })

  it('keeps the old executable intact when a staged reinstall fails and replaces it only after success', () => {
    const workRoot = makeTempDir('dsh-inst-rollback-')
    const fixture = join(workRoot, 'source')
    const prefix = join(workRoot, 'prefix')
    const bin = join(workRoot, 'bin')
    const fakeTools = makeTempDir('dsh-inst-fail-tools-')
    mkdirSync(join(fixture, 'apps/tui/dist'), { recursive: true })
    mkdirSync(join(fixture, 'packages/marketplace/bin'), { recursive: true })
    mkdirSync(join(fixture, 'packages/dsh-bridge/node_modules/.bin'), { recursive: true })
    writeFileSync(join(fixture, 'apps/tui/dist/bin.js'), 'console.log("STABLE_CLI")\n', 'utf8')
    writeFileSync(join(fixture, 'packages/marketplace/bin/dsh-marketplace.js'), 'console.log("MARKETPLACE")\n', 'utf8')
    writeFileSync(join(fixture, 'packages/dsh-bridge/node_modules/.bin/dsh'), '#!/bin/sh\nexit 0\n', 'utf8')

    const pnpm = join(fakeTools, 'pnpm')
    writeFileSync(pnpm, '#!/usr/bin/env bash\nif [ "${FAIL_INSTALL:-}" = "1" ] && [ "$1" = "install" ]; then exit 37; fi\nif [ "${FAIL_BUILD:-}" = "1" ] && [ "$1" != "install" ]; then exit 38; fi\nexit 0\n', 'utf8')
    chmodSync(pnpm, 0o755)
    const env = { ...process.env, PATH: fakeTools + ':' + (process.env.PATH ?? '') }
    const args = ['--local-repo', fixture, '--prefix', prefix, '--bin-dir', bin]
    const first = spawnSync('bash', [installerPath, ...args], { env, encoding: 'utf8' })
    expect(first.status, first.stderr).toBe(0)
    const stable = execFileSync(join(bin, 'dsh-community'), ['version'], { encoding: 'utf8' }).trim()
    expect(stable).toBe('STABLE_CLI')
    // mktemp's 0700 staging permissions must not leak into a public install.
    expect(statSync(join(prefix, 'repo')).mode & 0o777).toBe(statSync(prefix).mode & 0o777)
    chmodSync(join(prefix, 'repo'), 0o750)
    const initialGid = statSync(join(prefix, 'repo')).gid
    const alternateGid = process.getgroups?.().find(gid => gid !== initialGid)
    if (alternateGid !== undefined && process.platform === 'linux') {
      // Emulate an existing shared install under a secondary runner group.
      execFileSync('chgrp', [String(alternateGid), join(prefix, 'repo')])
      expect(statSync(join(prefix, 'repo')).gid).toBe(alternateGid)
    }
    const preservedGid = statSync(join(prefix, 'repo')).gid

    writeFileSync(join(fixture, 'apps/tui/dist/bin.js'), 'console.log("NEW_VERSION")\n', 'utf8')
    const badInstall = spawnSync('bash', [installerPath, ...args], {
      env: { ...env, FAIL_INSTALL: '1' },
      encoding: 'utf8',
    })
    expect(badInstall.status).not.toBe(0)
    expect(execFileSync(join(bin, 'dsh-community'), ['version'], { encoding: 'utf8' }).trim()).toBe(stable)

    const badBuild = spawnSync('bash', [installerPath, ...args], {
      env: { ...env, FAIL_BUILD: '1' },
      encoding: 'utf8',
    })
    expect(badBuild.status).not.toBe(0)
    expect(execFileSync(join(bin, 'dsh-community'), ['version'], { encoding: 'utf8' }).trim()).toBe(stable)

    // Simulate SIGTERM immediately after mv(repo, backup) has succeeded,
    // BEFORE the installer shell can resume after its child process exits.
    const fakeMv = join(fakeTools, 'mv')
    writeFileSync(
      fakeMv,
      '#!/usr/bin/env bash\n' +
      'dest="${@: -1}"; src="${@: -2:1}"\n' +
      'if [ -n "${DSH_TEST_FAIL_MARKETPLACE_SHIM:-}" ] && [ "$dest" = "$DSH_TEST_FAIL_MARKETPLACE_SHIM" ] && [ ! -e "${DSH_TEST_MARKER:-/nonexistent}" ]; then touch "$DSH_TEST_MARKER"; exit 79; fi\n' +
      '/usr/bin/mv "$@"\n' +
      'rc=$?\n' +
      'if [ "$rc" -eq 0 ] && [ -n "${DSH_TEST_SIGTERM_SOURCE:-}" ] && [ "$src" = "$DSH_TEST_SIGTERM_SOURCE" ] && [[ "$dest" == *".repo.previous."* ]]; then kill -TERM "$PPID"; fi\n' +
      'exit "$rc"\n',
      'utf8',
    )
    chmodSync(fakeMv, 0o755)
    // Send SIGTERM while rollback is executing rm(candidate repo).
    const fakeRm = join(fakeTools, 'rm')
    writeFileSync(
      fakeRm,
      '#!/usr/bin/env bash\n' +
      'last="${@: -1}"\n' +
      '/usr/bin/rm "$@"\n' +
      'rc=$?\n' +
      'if [ "$rc" -eq 0 ] && [ -n "${DSH_TEST_SIGNAL_ON_RM:-}" ] && [ "$last" = "$DSH_TEST_SIGNAL_ON_RM" ] && [ ! -e "${DSH_TEST_CLEANUP_MARKER:-/nonexistent}" ]; then touch "$DSH_TEST_CLEANUP_MARKER"; kill -TERM "$PPID"; fi\n' +
      'exit "$rc"\n',
      'utf8',
    )
    chmodSync(fakeRm, 0o755)


    const terminated = spawnSync('bash', [installerPath, ...args], {
      env: { ...env, DSH_TEST_SIGTERM_SOURCE: join(prefix, 'repo') },
      encoding: 'utf8',
    })
    expect(terminated.status).not.toBe(0)
    expect(terminated.stderr).toContain('Previous dsh-community installation restored')
    expect(execFileSync(join(bin, 'dsh-community'), ['version'], { encoding: 'utf8' }).trim()).toBe(stable)
    expect(readFileSync(join(prefix, 'repo/apps/tui/dist/bin.js'), 'utf8')).toContain('STABLE_CLI')

    // Replacing shims for a DIFFERENT prefix is a separate transaction.
    // Fail the marketplace rename once, after the new TUI shim was written.
    const otherPrefix = join(workRoot, 'alternate-prefix')
    const markerFile = join(workRoot, 'fail-shim-once.marker')
    const badCrossPrefix = spawnSync('bash', [
      installerPath, '--local-repo', fixture, '--prefix', otherPrefix, '--bin-dir', bin,
    ], {
      env: {
        ...env,
        DSH_TEST_FAIL_MARKETPLACE_SHIM: join(bin, 'dsh-marketplace'),
        DSH_TEST_MARKER: markerFile,
      },
      encoding: 'utf8',
    })
    expect(badCrossPrefix.status).not.toBe(0)
    expect(existsSync(markerFile)).toBe(true)
    expect(existsSync(join(otherPrefix, 'repo'))).toBe(false)
    expect(execFileSync(join(bin, 'dsh-community'), ['version'], { encoding: 'utf8' }).trim()).toBe(stable)
    expect(execFileSync(join(bin, 'dsh-marketplace'), [], { encoding: 'utf8' }).trim()).toBe('MARKETPLACE')

    // A failed marketplace shim publication begins rollback. Deliver a second
    // SIGTERM after cleanup removed the candidate but before it restores old repo.
    const rollbackShimMarker = join(workRoot, 'rollback-shim.marker')
    const rollbackSignalMarker = join(workRoot, 'rollback-signal.marker')
    const interruptedRollback = spawnSync('bash', [installerPath, ...args], {
      env: {
        ...env,
        DSH_TEST_FAIL_MARKETPLACE_SHIM: join(bin, 'dsh-marketplace'),
        DSH_TEST_MARKER: rollbackShimMarker,
        DSH_TEST_SIGNAL_ON_RM: join(prefix, 'repo'),
        DSH_TEST_CLEANUP_MARKER: rollbackSignalMarker,
      },
      encoding: 'utf8',
    })
    expect(interruptedRollback.status).not.toBe(0)
    expect(existsSync(rollbackShimMarker)).toBe(true)
    expect(existsSync(rollbackSignalMarker)).toBe(true)
    expect(interruptedRollback.stderr).toContain('Previous dsh-community installation restored')
    expect(execFileSync(join(bin, 'dsh-community'), ['version'], { encoding: 'utf8' }).trim()).toBe(stable)
    expect(readFileSync(join(prefix, 'repo/apps/tui/dist/bin.js'), 'utf8')).toContain('STABLE_CLI')

    // A different prefix cannot take over the shared bin-dir while this
    // process holds its flock lock. Test uses the same OFD across subprocess.
    const binLock = openSync(join(bin, '.dsh-community.install.lock'), 'a')
    try {
      const locked = spawnSync('flock', ['-x', '3'], {
        stdio: ['ignore', 'pipe', 'pipe', binLock], encoding: 'utf8',
      })
      expect(locked.status, locked.stderr).toBe(0)
      const competingPrefix = join(workRoot, 'third-prefix')
      const competing = spawnSync('bash', [
        installerPath, '--local-repo', fixture, '--prefix', competingPrefix, '--bin-dir', bin,
      ], { env, encoding: 'utf8' })
      expect(competing.status).not.toBe(0)
      expect(competing.stderr).toContain('another dsh-community installation is publishing to')
      expect(execFileSync(join(bin, 'dsh-community'), ['version'], { encoding: 'utf8' }).trim()).toBe(stable)
      expect(existsSync(join(competingPrefix, 'repo'))).toBe(false)
    } finally {
      closeSync(binLock)
    }

    // A directory occupying a shim path must fail before any activation.
    const marketplaceShim = join(bin, 'dsh-marketplace')
    rmSync(marketplaceShim)
    mkdirSync(marketplaceShim)
    const blockedShim = spawnSync('bash', [installerPath, ...args], { env, encoding: 'utf8' })
    expect(blockedShim.status).not.toBe(0)
    expect(execFileSync(join(bin, 'dsh-community'), ['version'], { encoding: 'utf8' }).trim()).toBe(stable)
    expect(readFileSync(join(prefix, 'repo/apps/tui/dist/bin.js'), 'utf8')).toContain('STABLE_CLI')
    rmSync(marketplaceShim, { recursive: true })

    const success = spawnSync('bash', [installerPath, ...args], { env, encoding: 'utf8' })
    expect(success.status, success.stderr).toBe(0)
    expect(execFileSync(join(bin, 'dsh-community'), ['version'], { encoding: 'utf8' }).trim()).toBe('NEW_VERSION')
    expect(readFileSync(join(prefix, 'repo/apps/tui/dist/bin.js'), 'utf8')).toContain('NEW_VERSION')
    expect(statSync(join(prefix, 'repo')).mode & 0o777).toBe(0o750)
    expect(statSync(join(prefix, 'repo')).gid).toBe(preservedGid)
  })

  it('supports pinned tag/commit installation with --ref and fail-closed --expected-commit verification', () => {
    const workRoot = makeTempDir('dsh-inst-pin-')
    const srcRepo = join(workRoot, 'origin-src')
    const bareRemote = join(workRoot, 'remote.git')
    const fakeToolBin = makeTempDir('dsh-inst-pin-tools-')
    const outPrefix = join(workRoot, 'prefix')
    const outBin = join(workRoot, 'bin')

    mkdirSync(join(srcRepo, 'apps/tui/dist'), { recursive: true })
    mkdirSync(join(srcRepo, 'packages/marketplace/bin'), { recursive: true })
    mkdirSync(join(srcRepo, 'packages/dsh-bridge/node_modules/.bin'), { recursive: true })
    writeFileSync(join(srcRepo, 'apps/tui/dist/bin.js'), 'console.log("ok")\n', 'utf8')
    writeFileSync(join(srcRepo, 'packages/marketplace/bin/dsh-marketplace.js'), 'console.log("ok")\n', 'utf8')
    writeFileSync(join(srcRepo, 'packages/dsh-bridge/node_modules/.bin/dsh'), '#!/usr/bin/env sh\nexit 0\n', 'utf8')
    chmodSync(join(srcRepo, 'packages/dsh-bridge/node_modules/.bin/dsh'), 0o755)

    execFileSync('git', ['init', '-b', 'main', srcRepo])
    execFileSync('git', ['-C', srcRepo, 'config', 'user.email', 'ci@example.invalid'])
    execFileSync('git', ['-C', srcRepo, 'config', 'user.name', 'CI Test'])
    execFileSync('git', ['-C', srcRepo, 'add', '.'])
    execFileSync('git', ['-C', srcRepo, 'commit', '-q', '-m', 'pinned tag commit'])
    const pinnedSha = execFileSync('git', ['-C', srcRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    execFileSync('git', ['-C', srcRepo, 'tag', 'v0.2.2-rc.3'])

    execFileSync('git', ['clone', '--bare', srcRepo, bareRemote])

    const fakePnpm = join(fakeToolBin, 'pnpm')
    writeFileSync(fakePnpm, '#!/usr/bin/env bash\nexit 0\n', 'utf8')
    chmodSync(fakePnpm, 0o755)

    // Bad --expected-commit format fails closed before clone
    const malformedRes = spawnSync(
      'bash',
      [installerPath, '--dry-run', '--expected-commit', 'not-a-sha'],
      { encoding: 'utf8' },
    )
    expect(malformedRes.status).toBe(1)
    expect(malformedRes.stderr).toContain('40-character hexadecimal')

    // Wrong commit SHA fails closed after fetch
    const wrongSha = '0'.repeat(40)
    const mismatchRes = spawnSync(
      'bash',
      [
        installerPath,
        '--repo-url',
        `file://${bareRemote}`,
        '--ref',
        'v0.2.2-rc.3',
        '--expected-commit',
        wrongSha,
        '--prefix',
        outPrefix,
        '--bin-dir',
        outBin,
      ],
      {
        env: { ...process.env, PATH: `${fakeToolBin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      },
    )
    expect(mismatchRes.status).toBe(1)
    expect(mismatchRes.stderr).toContain('checked-out commit mismatch')

    // Exact tag + expected commit passes and prints provenance
    const matchRes = spawnSync(
      'bash',
      [
        installerPath,
        '--repo-url',
        `file://${bareRemote}`,
        '--ref',
        'v0.2.2-rc.3',
        '--expected-commit',
        pinnedSha,
        '--prefix',
        outPrefix,
        '--bin-dir',
        outBin,
      ],
      {
        env: { ...process.env, PATH: `${fakeToolBin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      },
    )
    expect(matchRes.status, matchRes.stderr || matchRes.stdout).toBe(0)
    expect(matchRes.stdout).toContain(`ref=v0.2.2-rc.3 commit=${pinnedSha}`)
    // A rejected pin must not destroy a previously successful installation.
    const pinMismatchAfterInstall = spawnSync(
      'bash',
      [
        installerPath,
        '--repo-url', 'file://' + bareRemote,
        '--ref', 'v0.2.2-rc.3',
        '--expected-commit', wrongSha,
        '--prefix', outPrefix,
        '--bin-dir', outBin,
      ],
      {
        env: { ...process.env, PATH: fakeToolBin + ':' + (process.env.PATH ?? '') },
        encoding: 'utf8',
      },
    )
    expect(pinMismatchAfterInstall.status).toBe(1)
    expect(pinMismatchAfterInstall.stderr).toContain('checked-out commit mismatch')
    expect(readFileSync(join(outPrefix, 'repo/apps/tui/dist/bin.js'), 'utf8')).toBe('console.log("ok")\n')


    // Dirty --local-repo fails closed when --expected-commit is requested
    writeFileSync(join(srcRepo, 'apps/tui/dist/bin.js'), 'console.log("dirty")\n', 'utf8')
    const dirtyLocalRes = spawnSync(
      'bash',
      [
        installerPath,
        '--local-repo',
        srcRepo,
        '--expected-commit',
        pinnedSha,
        '--prefix',
        join(workRoot, 'dirty-prefix'),
        '--bin-dir',
        join(workRoot, 'dirty-bin'),
      ],
      {
        env: { ...process.env, PATH: `${fakeToolBin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      },
    )
    expect(dirtyLocalRes.status).toBe(1)
    expect(dirtyLocalRes.stderr).toContain('uncommitted or untracked changes')

    // Re-installing over a modified existing checkout with --ref + --expected-commit resets & cleans to the exact pinned commit
    writeFileSync(join(outPrefix, 'repo/apps/tui/dist/bin.js'), 'console.log("tampered")\n', 'utf8')
    writeFileSync(join(outPrefix, 'repo/tamper.txt'), 'stray\n', 'utf8')
    const cleanedRes = spawnSync(
      'bash',
      [
        installerPath,
        '--repo-url',
        `file://${bareRemote}`,
        '--ref',
        'v0.2.2-rc.3',
        '--expected-commit',
        pinnedSha,
        '--prefix',
        outPrefix,
        '--bin-dir',
        outBin,
      ],
      {
        env: { ...process.env, PATH: `${fakeToolBin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      },
    )
    expect(cleanedRes.status, cleanedRes.stderr || cleanedRes.stdout).toBe(0)
    expect(readFileSync(join(outPrefix, 'repo/apps/tui/dist/bin.js'), 'utf8')).toBe('console.log("ok")\n')
  })
})
