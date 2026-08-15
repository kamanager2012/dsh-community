#!/usr/bin/env node
/**
 * Our third-party TUI. Official dsh is the runtime.
 * Reference dsh-TUI supplies Ink; we own profile + thin patch.
 */

import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { resolveOfficialDsh, resolveOfficialDshHome } from '@dsh-community/dsh-bridge'
import { composeCommunityTuiPatch } from './compose-patch.js'
import { installProfileDeps, profileNeedsInstall } from './install.js'
import { officialTuiArgv } from './launch.js'
import { ensureCommunityTuiProfile } from './profile.js'

const dshHome = resolveOfficialDshHome(process.env, homedir())
const { dir, patchPath } = ensureCommunityTuiProfile({
  dshHome,
  communityPatch: composeCommunityTuiPatch(),
})

if (profileNeedsInstall(dir)) {
  const pnpm = installProfileDeps(dir)
  if (!pnpm.ok) {
    process.stderr.write('dsh-community-tui: pnpm install failed in the official profile directory\n')
    process.exit(pnpm.status ?? 1)
  }
}

const install = resolveOfficialDsh({ from: import.meta.url })
const result = spawnSync(
  process.execPath,
  [install.binPath, ...officialTuiArgv(patchPath, process.argv.slice(2))],
  { stdio: 'inherit', cwd: dir, env: process.env },
)
process.exit(result.status ?? 1)
