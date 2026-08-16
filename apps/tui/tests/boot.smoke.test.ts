import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveOfficialDsh } from '@dsh-community/dsh-bridge'
import { composeCommunityTuiPatch } from '../src/compose-patch.ts'
import { installProfileDeps } from '../src/install.ts'
import { officialTuiArgv } from '../src/launch.ts'
import { ensureCommunityTuiProfile } from '../src/profile.ts'

/**
 * No TTY: compose our profile, install our own surface plugin as a
 * dependency, dump the official tree. Proves official dsh composes
 * @dsh-community/tui-surface and no third-party TUI is mounted.
 */
describe('community TUI profile boot', () => {
  it('installs plugins and dumps a tree that includes our TUI row', { timeout: 180_000 }, () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-community-tui-boot-'))
    const { dir, patchPath } = ensureCommunityTuiProfile({
      dshHome: home,
      communityPatch: composeCommunityTuiPatch(),
    })
    const installed = installProfileDeps(dir)
    expect(installed.ok).toBe(true)

    const dsh = resolveOfficialDsh({ from: import.meta.url })
    const dump = execFileSync(
      process.execPath,
      [dsh.binPath, ...officialTuiArgv(patchPath, ['--dump-config'])],
      {
        encoding: 'utf8',
        timeout: 60_000,
        cwd: dir,
        env: { ...process.env, DSH_HOME: home },
      },
    )
    expect(dump).toMatch(/id: dsh-community-tui/)
    expect(dump).toMatch(/@dsh-community\/tui/)
    expect(dump).not.toMatch(/@deepseek-harness-tui\/dsh-tui/)
    expect(dump).toMatch(/id: session/)
    expect(dump).toMatch(/id: agent/)
    expect(dump).toMatch(/id: tool-bash[\s\S]*disabled: true/)
  })
})
