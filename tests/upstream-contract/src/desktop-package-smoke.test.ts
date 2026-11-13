import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow = readFileSync(
  join(repoRoot, '.github/workflows/linux-package-smoke.yml'),
  'utf8',
)
const release = readFileSync(
  join(repoRoot, '.github/workflows/release.yml'),
  'utf8',
)
const packager = readFileSync(
  join(repoRoot, 'apps/desktop/scripts/package.mjs'),
  'utf8',
)

describe('pre-tag Desktop package coverage (Complementary Edition)', () => {
  it('covers the Linux AppImage release packaging target and retires Win/macOS installers', () => {
    expect(workflow).toContain('name: package (linux-appimage)')
    expect(workflow).toContain('runs-on: ubuntu-latest')
    expect(workflow).toContain('pnpm desktop:package -- --appimage')

    expect(release).toContain('pnpm desktop:package -- --appimage')
    expect(release).not.toContain('-- --win')
    expect(release).not.toContain('-- --mac')
    expect(existsSync(join(repoRoot, '.github/workflows/windows-package-smoke.yml'))).toBe(false)
    expect(existsSync(join(repoRoot, '.github/workflows/linux-macos-package-smoke.yml'))).toBe(false)
    expect(packager).toContain("args.includes('--win') || args.includes('--mac')")
    for (const retiredFlag of ['--win', '--mac']) {
      const res = spawnSync(
        process.execPath,
        [join(repoRoot, 'apps/desktop/scripts/package.mjs'), '--', retiredFlag],
        { encoding: 'utf8' },
      )
      expect(res.status).not.toBe(0)
      expect(res.stderr).toContain('Windows and macOS desktop installers are retired')
    }
  })

  it('checks packaged bytes instead of only checking that electron-builder exits zero', () => {
    expect(workflow).toContain('pnpm vitest run apps/desktop/tests/asar-purity.test.ts')
    expect(workflow).toContain('scripts/checksum-release.mjs')
    expect(workflow).toContain("crypto.createHash('sha256')")
    expect(workflow).toContain('sha256 mismatch for ')
    expect(workflow).toContain('--appimage-extract')
    expect(workflow).toContain('official-dsh.tar')
  })

  it('runs when release or Desktop packaging inputs change', () => {
    for (const path of [
      "'.github/workflows/release.yml'",
      "'.github/workflows/linux-package-smoke.yml'",
      "'apps/desktop/**'",
      "'packages/dsh-bridge/**'",
      "'package.json'",
      "'pnpm-lock.yaml'",
    ]) {
      expect(workflow).toContain(path)
    }
  })

  it('is read-only and keeps signing disabled during package smoke', () => {
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'")
    expect(workflow).not.toContain('contents: write')
    expect(workflow).not.toContain('id-token: write')
  })
})
