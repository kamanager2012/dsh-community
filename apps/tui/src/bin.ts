#!/usr/bin/env node
/**
 * Our third-party TUI. Official dsh is the development foundation and runtime.
 * Marketplace is a community distribution command; chat/sessions stay on official dsh.
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
import { officialAppArgs, officialTuiArgv, parseCommunityLaunch, resumeEnv } from './launch.js'
import { COMMUNITY_TUI_PROFILE, ensureCommunityTuiProfile } from './profile.js'

// Community catalog. Official dsh remains the plugin/runtime host after install.
if (process.argv[2] === 'marketplace') {
  const status = await runMarketplaceCli({ args: process.argv.slice(3), profile: COMMUNITY_TUI_PROFILE })
  process.exit(status)
}

const dshHome = resolveOfficialDshHome(process.env, homedir())
const launch = (() => {
  try {
    return parseCommunityLaunch(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  }
})()

if (launch.kind === 'list') {
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

if (launch.kind === 'resume') {
  const root = officialSessionRoot(dshHome)
  const known = listOfficialSessions(root).some((session) => session.id === launch.id)
  if (!known) {
    process.stderr.write(`no official session ${launch.id} under ${root}\n`)
    process.exit(2)
  }
}

const extra = officialAppArgs(launch)
const env = launch.kind === 'resume' ? resumeEnv(process.env, launch.id) : process.env

const install = resolveOfficialDsh({ from: import.meta.url })
const result = spawnSync(
  process.execPath,
  [install.binPath, ...officialTuiArgv(patchPath, extra)],
  { stdio: 'inherit', cwd: dir, env },
)
process.exit(result.status ?? 1)
