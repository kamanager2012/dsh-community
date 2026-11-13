import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflowDir = join(repoRoot, '.github', 'workflows')

describe('Desktop packaging host-protection and Complementary Edition boundary', () => {
  it('never disables host antimalware protection in current workflows', () => {
    const violations: string[] = []
    for (const name of readdirSync(workflowDir)) {
      if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue
      const content = readFileSync(join(workflowDir, name), 'utf8')
      for (const forbidden of [
        'Set-MpPreference',
        'DisableRealtimeMonitoring',
        'DisableBehaviorMonitoring',
      ]) {
        if (content.includes(forbidden)) violations.push(name + ': ' + forbidden)
      }
    }
    expect(violations).toEqual([])
  })

  it('retires Windows and macOS installer workflows in favor of Linux AppImage only', () => {
    expect(existsSync(join(workflowDir, 'windows-package-smoke.yml'))).toBe(false)
    const smoke = readFileSync(join(workflowDir, 'linux-package-smoke.yml'), 'utf8')
    expect(smoke).toContain('runs-on: ubuntu-latest')
    expect(smoke).toContain('pnpm desktop:package -- --appimage')
    expect(smoke).toContain('pnpm vitest run apps/desktop/tests/asar-purity.test.ts')
    expect(smoke).toContain("node scripts/checksum-release.mjs 'apps/desktop/release/*.AppImage'")
  })

  it('keeps the packaging workspace bounded and fails closed on retired Win/macOS targets', () => {
    const packager = readFileSync(join(repoRoot, 'apps/desktop/scripts/package.mjs'), 'utf8')
    expect(packager).toContain('bounded to this isolated staging workspace')
    expect(packager).toContain('Windows and macOS desktop installers are retired')
  })
})
