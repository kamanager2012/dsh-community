import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const release = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8')

describe('release publish verification boundary', () => {
  it('re-verifies structure and hashes after artifact download and before publish', () => {
    const verifyIndex = release.indexOf('node scripts/verify-release-set.mjs dist-artifacts dist-signed')
    const publishIndex = release.indexOf('gh release create "$TAG"')
    expect(verifyIndex).toBeGreaterThan(-1)
    expect(publishIndex).toBeGreaterThan(verifyIndex)
  })

  it('cryptographically verifies every asset against the exact current tag identity', () => {
    expect(release).toContain('cosign verify-blob')
    expect(release).toContain('--certificate-oidc-issuer https://token.actions.githubusercontent.com')
    expect(release).toContain('release.yml@refs/tags/${GITHUB_REF_NAME}')
    expect(release).toContain('--certificate-identity "${identity}"')
    expect(release).not.toContain('--certificate-identity-regexp')
  })

  it('keeps publish as the sole contents writer without granting it signing identity', () => {
    const publish = release.slice(release.indexOf('  publish:'), release.length)
    expect(publish).toContain('permissions:\n      contents: write')
    expect(publish).not.toContain('id-token: write')
  })

  it('does not allow verification failure to be ignored', () => {
    expect(release).not.toMatch(/Verify release set structure and SHA256[\s\S]{0,240}continue-on-error:\s*true/u)
    expect(release).not.toMatch(/Verify every release signature[\s\S]{0,500}continue-on-error:\s*true/u)
  })
})
