import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const release = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8')
const userLoop = readFileSync(join(repoRoot, '.github/workflows/user-loop-evidence.yml'), 'utf8')
const smoke = readFileSync(join(repoRoot, '.github/workflows/artifact-action-smoke.yml'), 'utf8')

const UPLOAD = 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'
const DOWNLOAD = 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'

describe('artifact action compatibility smoke', () => {
  it('tests the exact artifact action commits used by release flows', () => {
    expect(release).toContain(UPLOAD)
    expect(release).toContain(DOWNLOAD)
    expect(userLoop).toContain(UPLOAD)
    expect(smoke).toContain(UPLOAD)
    expect(smoke).toContain(DOWNLOAD)
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
