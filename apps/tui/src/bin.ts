#!/usr/bin/env node
/**
 * Our third-party TUI. Official dsh is the runtime.
 * Reference dsh-TUI supplies Ink; we own profile + thin patch.
 */

import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { resolveOfficialDsh, resolveOfficialDshHome } from '@dsh-community/dsh-bridge'
import { composeCommunityTuiPatch } from './compose-patch.js'
import { COMMUNITY_TUI_PROFILE, ensureCommunityTuiProfile } from './profile.js'

const dshHome = resolveOfficialDshHome(process.env, homedir())
const { dir, patchPath } = ensureCommunityTuiProfile({
  dshHome,
  communityPatch: composeCommunityTuiPatch(),
})

const pnpm = spawnSync('pnpm', ['install'], { cwd: dir, stdio: 'inherit', env: process.env })
if (pnpm.status !== 0) {
  process.stderr.write('dsh-community-tui: pnpm install failed in the official profile directory\n')
  process.exit(pnpm.status ?? 1)
}

const install = resolveOfficialDsh({ from: import.meta.url })
const result = spawnSync(
  process.execPath,
  [install.binPath, '--profile', COMMUNITY_TUI_PROFILE, '--patch', patchPath, ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: dir, env: process.env },
)
process.exit(result.status ?? 1)
