import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    expect(logContent).toContain(`${join(absPrefix, 'repo')}|install --frozen-lockfile`)
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
  })
})
