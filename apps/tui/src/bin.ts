#!/usr/bin/env node
/**
 * Our third-party TUI. Official dsh is the runtime.
 * Reference dsh-TUI supplies Ink; we own profile + thin patch.
 */

import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import {
  listOfficialSessions,
  officialSessionRoot,
  resolveOfficialDsh,
  resolveOfficialDshHome,
} from '@dsh-community/dsh-bridge'
import { runMarketplaceCli } from '@dsh-community/marketplace'
import { composeCommunityTuiPatch } from './compose-patch.js'
import { installProfileDeps, profileNeedsInstall } from './install.js'
import { isCommunityListSessions, officialTuiArgv } from './launch.js'
import { COMMUNITY_TUI_PROFILE, ensureCommunityTuiProfile } from './profile.js'

// 社区市场:我们自己的发行层命令,不经过官方 dsh。
if (process.argv[2] === 'marketplace') {
  const status = await runMarketplaceCli({ args: process.argv.slice(3), profile: COMMUNITY_TUI_PROFILE })
  process.exit(status)
}

const dshHome = resolveOfficialDshHome(process.env, homedir())

if (isCommunityListSessions(process.argv.slice(2))) {
  const root = officialSessionRoot(dshHome)
  const sessions = listOfficialSessions(root)
  if (sessions.length === 0) {
    process.stdout.write(`no official sessions under ${root}\n`)
    process.exit(0)
  }
  for (const session of sessions) {
    process.stdout.write(`${session.id}\t${session.projectKey}\t${session.transcript}\n`)
  }
  process.exit(0)
}

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
