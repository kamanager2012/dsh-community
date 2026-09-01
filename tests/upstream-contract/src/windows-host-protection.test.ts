import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflowDir = join(repoRoot, '.github', 'workflows')

describe('Windows release host-protection boundary', () => {
  it('never disables Windows antimalware protection in current workflows', () => {
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

  it('proves Windows packaging on a protected hosted runner before release changes merge', () => {
    const smoke = readFileSync(join(workflowDir, 'windows-package-smoke.yml'), 'utf8')
    expect(smoke).toContain('runs-on: windows-latest')
    expect(smoke).toContain('pnpm desktop:package -- --win')
    expect(smoke).toContain('pnpm vitest run apps/desktop/tests/asar-purity.test.ts')
    expect(smoke).toContain("node scripts/checksum-release.mjs 'apps/desktop/release/*.exe'")
    expect(smoke).toContain("'.github/workflows/release.yml'")
    expect(smoke).toContain("'apps/desktop/**'")
  })

  it('keeps the packaging workaround structural instead of weakening the host', () => {
    const packager = readFileSync(join(repoRoot, 'apps/desktop/scripts/package.mjs'), 'utf8')
    expect(packager).toContain('Windows scanning stays')
    expect(packager).toContain('Do not disable host antimalware protection')
  })
})
