import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('remote-web browser E2EE workflow & documentation assets', () => {
  it('keeps the Chromium E2EE runner syntactically valid and wired to BlindGatewayServer', () => {
    const runnerPath = join(repoRoot, 'scripts/e2e/remote-web-browser-e2ee.mjs')
    execFileSync(process.execPath, ['--check', runnerPath], { encoding: 'utf8' })

    const source = readFileSync(runnerPath, 'utf8')
    expect(source).toContain('BlindGatewayServer')
    expect(source).toContain('MultiAgentRemoteHost')
    expect(source).toContain('Allow Once')
    expect(source).toContain('Git diff panel rendered over Noise IK')

    const wf = readFileSync(join(repoRoot, '.github/workflows/remote-web-browser-e2ee.yml'), 'utf8')
    expect(wf).toContain('node scripts/e2e/remote-web-browser-e2ee.mjs')
  })

  it('ships valid rendered PNG preview screenshots referenced by README', () => {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    for (const rel of ['docs/assets/remote-web-pwa.png', 'docs/assets/desktop-remote-console.png']) {
      const bytes = readFileSync(join(repoRoot, rel))
      expect(bytes.length, rel).toBeGreaterThan(10_000)
      expect(bytes.subarray(0, 8).equals(pngSignature), rel).toBe(true)
    }

    for (const readmeRel of ['README.md', 'README.zh-CN.md', 'README.en.md']) {
      const text = readFileSync(join(repoRoot, readmeRel), 'utf8')
      expect(text, readmeRel).toContain('docs/assets/remote-web-pwa.png')
      expect(text, readmeRel).toContain('docs/assets/desktop-remote-console.png')
      expect(text, readmeRel).toContain('scripts/install-linux.sh')
    }
  })
})
