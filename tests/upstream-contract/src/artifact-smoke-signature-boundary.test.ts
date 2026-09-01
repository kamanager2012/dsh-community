import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const workflow = readFileSync(
  join(repoRoot, '.github/workflows/artifact-smoke.yml'),
  'utf8',
)

describe('post-release signature verification boundary', () => {
  it('uses the same resolved tag for signatures and endpoint smokes', () => {
    expect(workflow).toMatch(/verify-signatures:\n\s+needs: resolve/u)
    expect(workflow).toContain('TAG: ${{ needs.resolve.outputs.tag }}')
    const verifySection = workflow.slice(
      workflow.indexOf('  verify-signatures:'),
      workflow.indexOf('  windows-desktop:'),
    )
    expect(verifySection).not.toContain('releases/latest')
    expect(verifySection).not.toContain('github.event.inputs.tag')
  })

  it('binds Fulcio verification to the exact tag instead of any tag in the repo', () => {
    expect(workflow).toContain('release.yml@refs/tags/$TAG')
    expect(workflow).toContain('--certificate-identity "$identity"')
    expect(workflow).not.toContain('COSIGN_IDENTITY_REGEXP')
    expect(workflow).not.toContain('--certificate-identity-regexp')
  })

  it('allows unsigned verification only for the explicit pre-signing history', () => {
    const legacy = [
      'v0.1.0-preview',
      'v0.1.1-preview',
      'v0.1.1',
      'v0.1.2-preview',
      'v0.1.2',
      'v0.1.3',
      'v0.1.4',
      'v0.1.1-rc.1',
    ]
    for (const tag of legacy) expect(workflow).toContain(tag)
    expect(workflow).toContain('is not in the explicit pre-signing legacy allowlist')
    expect(workflow).not.toContain('mode=transition')
  })

  it('runs a real signature-only check when the smoke workflow itself changes', () => {
    expect(workflow).toContain('pull_request:')
    expect(workflow).toContain("'.github/workflows/artifact-smoke.yml'")
    for (const job of ['windows-desktop', 'macos-desktop', 'linux-terminal']) {
      expect(workflow).toMatch(
        new RegExp(
          '  ' + job + ':\\n    needs: resolve\\n    if: \\$\\{\\{ github\\.event_name != \'pull_request\' \\}\\}',
          'u',
        ),
      )
    }
  })

  it('keeps current signed release outside the unsigned legacy allowlist', () => {
    const caseLine = workflow
      .split('\n')
      .find((line) => line.trimStart().startsWith('v0.1.0-preview|'))
    expect(caseLine).toBeDefined()
    expect(caseLine).not.toContain('v0.1.1-rc.2')
  })
})
