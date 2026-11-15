import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const release = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
const userLoop = readFileSync(join(repoRoot, '.github/workflows/user-loop-evidence.yml'), 'utf8')
const smoke = readFileSync(join(repoRoot, '.github/workflows/artifact-action-smoke.yml'), 'utf8')

const UPLOAD_RE = /actions\/upload-artifact@([0-9a-f]{40})\b/g
const DOWNLOAD_RE = /actions\/download-artifact@([0-9a-f]{40})\b/g

function extractSinglePinnedRef(content: string, actionName: string, pattern: RegExp, fileLabel: string): string {
  const refs = new Set(Array.from(content.matchAll(pattern), (m) => `${actionName}@${m[1]}`))
  expect(refs.size, `${fileLabel} must pin exactly one 40-char SHA for ${actionName}`).toBe(1)
  return [...refs][0]!
}

describe('artifact action compatibility smoke', () => {
  it('tests the exact artifact action commits used by release flows', () => {
    const releaseUpload = extractSinglePinnedRef(release, 'actions/upload-artifact', UPLOAD_RE, 'release.yml')
    const releaseDownload = extractSinglePinnedRef(release, 'actions/download-artifact', DOWNLOAD_RE, 'release.yml')
    const userLoopUpload = extractSinglePinnedRef(
      userLoop,
      'actions/upload-artifact',
      UPLOAD_RE,
      'user-loop-evidence.yml',
    )
    const smokeUpload = extractSinglePinnedRef(
      smoke,
      'actions/upload-artifact',
      UPLOAD_RE,
      'artifact-action-smoke.yml',
    )
    const smokeDownload = extractSinglePinnedRef(
      smoke,
      'actions/download-artifact',
      DOWNLOAD_RE,
      'artifact-action-smoke.yml',
    )

    expect(userLoopUpload).toBe(releaseUpload)
    expect(smokeUpload).toBe(releaseUpload)
    expect(smokeDownload).toBe(releaseDownload)
  })

  it('round-trips bytes and verifies sha256 instead of only testing action startup', () => {
    expect(smoke).toContain('sha256sum smoke-src/payload.txt')
    expect(smoke).toContain('sha256sum -c payload.sha256')
    expect(smoke).toContain('if-no-files-found: error')
  })

  it('runs when the release or user-loop artifact wiring changes', () => {
    expect(smoke).toContain("'.github/workflows/release.yml'")
    expect(smoke).toContain("'.github/workflows/user-loop-evidence.yml'")
    expect(smoke).toContain("'.github/workflows/artifact-action-smoke.yml'")
  })
})
