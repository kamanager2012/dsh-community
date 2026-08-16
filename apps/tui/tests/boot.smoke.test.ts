import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveOfficialDsh } from '@dsh-community/dsh-bridge'
import { composeCommunityTuiPatch } from '../src/compose-patch.ts'
import { officialTuiArgv } from '../src/launch.ts'
import { ensureCommunityTuiProfile } from '../src/profile.ts'

/**
 * No TTY: compose our overlay and dump official headless.
 * Must not install or mention a third-party TUI package.
 */
describe('community official-headless boot', () => {
  it('dumps official headless without a third-party TUI plugin', { timeout: 180_000 }, () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-community-tui-boot-'))
    const { dir, patchPath } = ensureCommunityTuiProfile({
      dshHome: home,
      communityPatch: composeCommunityTuiPatch(),
    })

    const dsh = resolveOfficialDsh({ from: import.meta.url })
    const dump = execFileSync(
      process.execPath,
      [dsh.binPath, ...officialTuiArgv(patchPath, ['--dump-config'])],
      {
        encoding: 'utf8',
        timeout: 30_000,
        cwd: dir,
        env: { ...process.env, DSH_HOME: home },
      },
    )
    expect(dump).not.toMatch(/@deepseek-harness-tui\/dsh-tui/)
    expect(dump).not.toMatch(/id: dsh-tui/)
    expect(dump).toMatch(/id: session/)
    expect(dump).toMatch(/id: agent/)
    expect(dump).toMatch(/headless/)
  })
})
