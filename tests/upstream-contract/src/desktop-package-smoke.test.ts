import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow = readFileSync(
  join(repoRoot, '.github/workflows/linux-macos-package-smoke.yml'),
  'utf8',
)
const windows = readFileSync(
  join(repoRoot, '.github/workflows/windows-package-smoke.yml'),
  'utf8',
)
const release = readFileSync(
  join(repoRoot, '.github/workflows/release.yml'),
  'utf8',
)

describe('pre-tag Desktop package coverage', () => {
  it('covers the same three release packaging targets before tag publication', () => {
    expect(workflow).toContain('label: linux-appimage')
    expect(workflow).toContain('os: ubuntu-latest')
    expect(workflow).toContain('packageArg: --appimage')
    expect(workflow).toContain('label: macos-dmg')
    expect(workflow).toContain('os: macos-latest')
    expect(workflow).toContain('packageArg: --mac')
    expect(windows).toContain('pnpm desktop:package -- --win')

    expect(release).toContain('pnpm desktop:package -- --appimage')
    expect(release).toContain('pnpm desktop:package -- --mac')
    expect(release).toContain('pnpm desktop:package -- --win')
  })

  it('checks packaged bytes instead of only checking that electron-builder exits zero', () => {
    expect(workflow).toContain('pnpm vitest run apps/desktop/tests/asar-purity.test.ts')
    expect(workflow).toContain('scripts/checksum-release.mjs')
    expect(workflow).toContain("crypto.createHash('sha256')")
    expect(workflow).toContain('sha256 mismatch for ')
    expect(workflow).toContain('--appimage-extract')
    expect(workflow).toContain('hdiutil attach')
    expect(workflow).toContain("find \"$mount\" -maxdepth 1 -type d -name '*.app'")
  })

  it('runs when release or Desktop packaging inputs change', () => {
    for (const path of [
      "'.github/workflows/release.yml'",
      "'.github/workflows/linux-macos-package-smoke.yml'",
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
