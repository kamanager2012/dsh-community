import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const scriptPath = join(repoRoot, 'scripts', 'release-notes.mjs')
const releaseWorkflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8')

function makeFixtureRoot(changelogText: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-notes-'))
  roots.push(root)
  writeFileSync(join(root, 'CHANGELOG.md'), changelogText)
  return root
}

function runScript(args: string[], root = repoRoot) {
  return spawnSync(process.execPath, [scriptPath, '--repo-root', root, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('release-notes generator', () => {
  it('matches exact changelog heading without colliding with suffixed tags', () => {
    const root = makeFixtureRoot([
      '# Changelog',
      '',
      '## 0.2.2-rc.2-community.1 — Community Prerelease',
      '',
      '- community item',
      '',
      '## 0.2.2-rc.2 — Candidate Source',
      '',
      '- rc2 item',
      '',
    ].join('\n'))

    const rc2 = runScript(['v0.2.2-rc.2'], root)
    expect(rc2.status).toBe(0)
    expect(rc2.stdout).toContain('- rc2 item')
    expect(rc2.stdout).not.toContain('- community item')
  })

  it('strips stale pre-publish Candidate Source wording on Latest releases', () => {
    const root = makeFixtureRoot([
      '# Changelog',
      '',
      '## 0.2.2-rc.9 — Candidate Source (2026-12-01)',
      '',
      'This is a reviewed **Candidate Source**, not GitHub Published Latest. Published Latest remains `v0.2.2-rc.8`; consolidated local acceptance passed.',
      '',
      '- Real change',
      '',
    ].join('\n'))

    const result = runScript(['v0.2.2-rc.9'], root)
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('Candidate Source')
    expect(result.stdout).not.toContain('Published Latest remains')
    expect(result.stdout).toContain('Consolidated local acceptance passed.')
    expect(result.stdout).toContain('- Real change')
  })

  it('renders complete download, launch, cosign verify, and boundary guidance for v0.2.2-rc.3', () => {
    const result = runScript(['v0.2.2-rc.3'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('# DeepSeek Harness Community `0.2.2-rc.3`')
    expect(result.stdout).toContain(
      'DeepSeek Harness Community v0.2.2-rc.3 [Official Core: @deepseek-ai/dsh@0.2.2-rc.3]',
    )
    expect(result.stdout).toContain('dsh-community-0.2.2-rc.3.AppImage')
    expect(result.stdout).toContain('dsh-community-0.2.2-rc.3-official-runtime.cdx.json')
    expect(result.stdout).toContain('sha256sum -c dsh-community-0.2.2-rc.3.AppImage.sha256')
    expect(result.stdout).toContain(
      'https://github.com/kamanager2012/dsh-community/.github/workflows/release.yml@refs/tags/v0.2.2-rc.3',
    )
    expect(result.stdout).toContain('`[UNVERIFIED]`')
    expect(result.stdout).toContain('deepseek-ai/deepseek-harness')
    expect(result.stdout).not.toContain('Published Latest remains')
    expect(result.stdout).not.toContain('Candidate Source')
  })

  it('marks -community pre-releases explicitly without displacing Latest', () => {
    const body = runScript(['v0.2.2-rc.2-community.1'])
    expect(body.status).toBe(0)
    expect(body.stdout).toContain('Pre-release notice')
    expect(body.stdout).toContain('does not displace [`releases/latest`]')
    expect(body.stdout).toContain('[Official Core: @deepseek-ai/dsh@0.2.2-rc.2]')

    const title = runScript(['--title', 'v0.2.2-rc.2-community.1'])
    expect(title.status).toBe(0)
    expect(title.stdout.trim()).toBe(
      'v0.2.2-rc.2-community.1 — Community Pre-release (@deepseek-ai/dsh@0.2.2-rc.2)',
    )
  })

  it('supports CLI body and --title output and wires title into release.yml', () => {
    const titleResult = runScript(['--title', 'v0.2.2-rc.3'])
    expect(titleResult.status).toBe(0)
    expect(titleResult.stdout.trim()).toBe(
      'v0.2.2-rc.3 — Official Core @deepseek-ai/dsh@0.2.2-rc.3',
    )

    expect(releaseWorkflow).toContain('node scripts/release-notes.mjs --title "${GITHUB_REF_NAME}"')
    expect(releaseWorkflow).toContain('--title "${RELEASE_TITLE:-$TAG}"')
  })
})
