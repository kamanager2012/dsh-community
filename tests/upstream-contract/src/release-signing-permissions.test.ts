import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const release = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8')

describe('release signing identity least privilege', () => {
  const sign = release.slice(
    release.indexOf('  sign:'),
    release.indexOf('  publish:'),
  )
  const publish = release.slice(release.indexOf('  publish:'))

  it('issues an OIDC signing identity only for successful release-tag runs', () => {
    expect(sign).toContain(
      "if: ${{ startsWith(github.ref, 'refs/tags/v') && success() }}",
    )
    expect(sign).toContain('id-token: write')
    expect(sign).toContain('contents: read')
    expect(sign).toContain('needs: [build-linux, build-windows, build-macos, runtime-sbom]')
  })

  it('keeps manual diagnostic builds away from signing identity', () => {
    expect(release).toContain('workflow_dispatch:')
    expect(sign).not.toContain("github.event_name == 'workflow_dispatch'")
    expect(sign).not.toContain('!cancelled()')
  })

  it('has exactly one OIDC writer and does not grant it to publish', () => {
    expect(release.match(/id-token: write/gu)?.length).toBe(1)
    expect(publish).not.toContain('id-token: write')
    expect(publish).toContain('contents: write')
  })
})
