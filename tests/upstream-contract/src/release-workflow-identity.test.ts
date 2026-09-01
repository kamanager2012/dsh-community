import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const release = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8')

describe('release workflow identity gate', () => {
  it('validates a tag before any OS build can start', () => {
    expect(release).toMatch(/release-identity:\n[\s\S]*?validate-release-tag\.mjs "\$GITHUB_REF_NAME"/u)
    for (const job of ['build-linux', 'build-windows', 'build-macos']) {
      expect(release).toMatch(
        new RegExp('  ' + job + ':\\n    needs: release-identity', 'u'),
      )
    }
  })

  it('keeps non-tag manual dispatch available for diagnostic builds', () => {
    expect(release).toContain("github.event_name == 'workflow_dispatch'")
    expect(release).toContain('identity gate intentionally does not classify this as a publishable release')
  })

  it('never starts the contents-writer publish job after a failed dependency', () => {
    expect(release).toContain(
      "if: ${{ startsWith(github.ref, 'refs/tags/v') && success() }}",
    )
    expect(release).not.toContain(
      "startsWith(github.ref, 'refs/tags/v') && !cancelled()",
    )
  })

  it('keeps the identity gate read-only and checkout credentials ephemeral', () => {
    const section = release.slice(
      release.indexOf('  release-identity:'),
      release.indexOf('  build-linux:'),
    )
    expect(section).toContain('persist-credentials: false')
    expect(section).not.toContain('contents: write')
    expect(section).not.toContain('id-token: write')
  })
})
