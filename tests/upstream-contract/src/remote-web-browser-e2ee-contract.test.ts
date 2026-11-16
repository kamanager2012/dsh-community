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

  it('ships valid rendered PNG preview screenshots referenced with honest harness disclosures across READMEs, getting-started, and handbook', () => {
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    for (const name of ['remote-web-pwa.png', 'desktop-remote-console.png']) {
      const docsBytes = readFileSync(join(repoRoot, 'docs/assets', name))
      expect(docsBytes.length, `docs/assets/${name}`).toBeGreaterThan(10_000)
      expect(docsBytes.subarray(0, 8).equals(pngSignature), `docs/assets/${name}`).toBe(true)

      const handbookBytes = readFileSync(join(repoRoot, 'handbook/assets', name))
      expect(handbookBytes.equals(docsBytes), `handbook/assets/${name} must match docs/assets/${name}`).toBe(true)
    }

    for (const rel of [
      'README.md',
      'README.zh-CN.md',
      'README.en.md',
      'docs/getting-started.md',
      'docs/getting-started.en.md',
      'handbook/index.md',
      'handbook/en/index.md',
    ]) {
      const text = readFileSync(join(repoRoot, rel), 'utf8')
      expect(text, rel).toContain('remote-web-pwa.png')
      expect(text, rel).toContain('desktop-remote-console.png')
      expect(text, rel).not.toContain('非静态 Mock 图')
      expect(text, rel).not.toContain('not static mockups')
      expect(text, rel).not.toMatch(/^## 实机界面预览$/mu)
    }

    for (const readmeRel of ['README.md', 'README.zh-CN.md', 'README.en.md']) {
      const text = readFileSync(join(repoRoot, readmeRel), 'utf8')
      expect(text, readmeRel).toContain('docs/assets/remote-web-pwa.png')
      expect(text, readmeRel).toContain('docs/assets/desktop-remote-console.png')
      expect(text, readmeRel).toContain('scripts/install-linux.sh')
      expect(text, readmeRel).toContain('remote grant')
    }
  })
})
