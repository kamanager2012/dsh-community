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

  it('creates working dsh-community and dsh-marketplace shims from --local-repo', () => {
    const fakeRepo = makeTempDir('dsh-inst-repo-')
    const fakeToolBin = makeTempDir('dsh-inst-tools-')
    const installPrefix = join(makeTempDir('dsh-inst-prefix-'), 'dsh')
    const binDir = makeTempDir('dsh-inst-bin-')
    const pnpmLog = join(fakeRepo, '.pnpm-calls.log')

    mkdirSync(join(fakeRepo, 'apps/tui/dist'), { recursive: true })
    mkdirSync(join(fakeRepo, 'packages/marketplace/bin'), { recursive: true })
    writeFileSync(
      join(fakeRepo, 'apps/tui/dist/bin.js'),
      'console.log("SHIM_TUI:" + process.argv.slice(2).join(","));\n',
      'utf8',
    )
    writeFileSync(
      join(fakeRepo, 'packages/marketplace/bin/dsh-marketplace.js'),
      'console.log("SHIM_MKT:" + process.argv.slice(2).join(","));\n',
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
      [installerPath, '--local-repo', fakeRepo, '--prefix', installPrefix, '--bin-dir', binDir],
      {
        env: { ...process.env, PATH: `${fakeToolBin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      },
    )
    expect(res.status, res.stderr || res.stdout).toBe(0)
    expect(res.stdout).toContain(join(binDir, 'dsh-community'))
    expect(res.stdout).toContain(join(binDir, 'dsh-marketplace'))

    const logContent = readFileSync(pnpmLog, 'utf8')
    expect(logContent).toContain(`${join(installPrefix, 'repo')}|install --frozen-lockfile`)
    expect(logContent).toContain('@dsh-community/tui')
    expect(logContent).toContain('@dsh-community/marketplace')

    const tuiOut = execFileSync(join(binDir, 'dsh-community'), ['doctor', '--porcelain'], {
      encoding: 'utf8',
    })
    expect(tuiOut.trim()).toBe('SHIM_TUI:doctor,--porcelain')

    const mktOut = execFileSync(join(binDir, 'dsh-marketplace'), ['list'], {
      encoding: 'utf8',
    })
    expect(mktOut.trim()).toBe('SHIM_MKT:list')
  })
})
