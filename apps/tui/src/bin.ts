#!/usr/bin/env node
/**
 * Community launcher. Official dsh is the runtime. No third-party TUI.
 */

import { spawnSync } from 'node:child_process'
import { readSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import {
  COMMUNITY_PLUGIN_CATALOG_REPO,
  fetchPluginCatalog,
  formatOfficialSessionMtime,
  formatPluginCatalog,
  formatPreflightReport,
  listOfficialSessions,
  officialApiKeyPresent,
  officialPluginAddCommand,
  officialSessionRoot,
  resolveOfficialDsh,
  resolveOfficialDshHome,
  type OfficialSessionRef,
} from '@dsh-community/dsh-bridge'
import { composeCommunityTuiPatch } from './compose-patch.js'
import { installProfileDeps, profileNeedsInstall } from './install.js'
import {
  COMMUNITY_TUI_HELP,
  officialAppArgs,
  officialTuiArgv,
  parseCommunityLaunch,
  tuiLaunchEnv,
} from './launch.js'
import { communityClientVersion, formatClientIdentity } from './version.js'
import { ensureCommunityTuiProfile } from './profile.js'
import { desktopSourceRequiredMessage, findPackagedDesktopExecutable } from './desktop-launch.js'
import {
  formatHumanSessions,
  formatPorcelainSessions,
  newestOfficialSession,
  parsePickChoice,
  resolveResumeTarget,
} from './sessions-text.js'

function fail(message: string, code = 2): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function writeDoctor(): boolean {
  const install = resolveOfficialDsh({ from: import.meta.url })
  process.stdout.write(formatPreflightReport({
    officialPackage: install.packageName,
    officialVersion: install.version,
    officialBin: install.binPath,
    clientVersion: communityClientVersion(),
    officialHome: dshHome,
    sessionCount: listOfficialSessions(officialSessionRoot(dshHome)).length,
    apiKeyPresent: officialApiKeyPresent(),
    tty: Boolean(process.stdout.isTTY),
    profileReady: true,
  }))
  return officialApiKeyPresent()
}

function readPrompt(question: string): string {
  process.stdout.write(question)
  const chunks: Buffer[] = []
  const byte = Buffer.alloc(1)
  while (readSync(0, byte, 0, 1, null) > 0) {
    if (byte[0] === 10) break
    if (byte[0] !== 13) chunks.push(Buffer.from(byte))
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

function pickResumeId(sessions: readonly OfficialSessionRef[], root: string): string {
  process.stdout.write(formatHumanSessions(sessions, root))
  if (sessions.length === 0) process.exit(0)
  if (!process.stdin.isTTY) {
    fail('没有交互终端。接着最近一条：dsh-community resume last')
  }
  const choice = readPrompt('输入序号、last 或 session id：')
  const picked = parsePickChoice(choice, sessions)
  if (!picked.ok) fail(picked.reason)
  return picked.id
}

const dshHome = resolveOfficialDshHome(process.env, homedir())
const launch = parseCommunityLaunch(process.argv.slice(2))

if (launch.kind === 'help') {
  process.stdout.write(COMMUNITY_TUI_HELP)
  process.exit(0)
}

if (launch.kind === 'version') {
  const install = resolveOfficialDsh({ from: import.meta.url })
  process.stdout.write(formatClientIdentity(install.packageName, install.version))
  process.exit(0)
}

const sessionRoot = officialSessionRoot(dshHome)
const sessions = listOfficialSessions(sessionRoot)

if (launch.kind === 'doctor') {
  process.exit(writeDoctor() ? 0 : 2)
}

if (launch.kind === 'desktop') {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const packaged = findPackagedDesktopExecutable({ execPath: process.execPath, repoRoot: root })
  if (packaged !== undefined) {
    const result = spawnSync(packaged, [], {
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
    })
    process.exit(result.status ?? 1)
  }
  const result = spawnSync('pnpm', ['desktop'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
    windowsHide: true,
  })
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error instanceof Error
      ? result.error.message
      : result.status === null
        ? 'spawn failed'
        : `pnpm desktop exit ${String(result.status)}`
    fail(desktopSourceRequiredMessage(detail))
  }
  process.exit(result.status ?? 0)
}

if (launch.kind === 'plugins') {
  try {
    const catalog = await fetchPluginCatalog()
    if (launch.porcelain) {
      for (const plugin of catalog.plugins) {
        process.stdout.write(
          `${plugin.name}\t${plugin.version}\t${plugin.testedDsh}\t${officialPluginAddCommand(plugin.name)}\n`,
        )
      }
    } else {
      process.stdout.write(formatPluginCatalog(catalog, COMMUNITY_PLUGIN_CATALOG_REPO))
    }
    process.exit(0)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    fail(`读不了插件目录（${detail}）。打开 ${COMMUNITY_PLUGIN_CATALOG_REPO}`)
  }
}

if (launch.kind === 'list') {
  if (launch.porcelain) {
    if (sessions.length === 0) process.stdout.write(`no official sessions under ${sessionRoot}\n`)
    else process.stdout.write(`${formatPorcelainSessions(sessions)}\n`)
  } else {
    process.stdout.write(formatHumanSessions(sessions, sessionRoot))
  }
  process.exit(0)
}

let resumeId: string | undefined
if (launch.kind === 'pick') {
  resumeId = pickResumeId(sessions, sessionRoot)
} else if (launch.kind === 'resume') {
  const resolved = resolveResumeTarget(launch.id, sessions)
  if (!resolved.ok) fail(resolved.reason)
  resumeId = resolved.id
} else if (launch.kind === 'default') {
  resumeId = newestOfficialSession(sessions)?.id
}

if (!process.stdout.isTTY) {
  fail(
    [
      '开聊需要交互终端。',
      '先看对话：dsh-community sessions',
      '或在真正的终端窗口里运行 dsh-community / dsh-community resume last',
    ].join('\n'),
  )
}

if (!officialApiKeyPresent()) {
  writeDoctor()
  fail('先 export DEEPSEEK_API_KEY=... 再运行 dsh-community')
}

const { dir, patchPath } = ensureCommunityTuiProfile({
  dshHome,
  communityPatch: composeCommunityTuiPatch(),
})

if (profileNeedsInstall(dir)) {
  process.stdout.write('dsh-community: 第一次启动，正在安装终端插件（只要一次）…\n')
  const pnpm = installProfileDeps(dir)
  if (!pnpm.ok) {
    process.stderr.write('dsh-community-tui: 官方 profile 目录里 pnpm install 失败\n')
    process.exit(pnpm.status ?? 1)
  }
}

const continuing = resumeId === undefined ? undefined : sessions.find((session) => session.id === resumeId)
if (continuing !== undefined) {
  process.stderr.write(
    `接着 ${continuing.id}（${formatOfficialSessionMtime(continuing.mtimeMs)}）。开新对话：dsh-community new\n`,
  )
} else if (sessions.length > 0 && (launch.kind === 'new' || launch.kind === 'run')) {
  process.stderr.write(`新对话。接着最近一条：dsh-community\n`)
}

const extra = resumeId === undefined
  ? officialAppArgs({
      kind: 'run',
      rest: launch.kind === 'run' || launch.kind === 'new' ? launch.rest : [],
    })
  : officialAppArgs({
      kind: 'resume',
      id: resumeId,
      rest: launch.kind === 'resume' ? launch.rest : [],
    })
const env = tuiLaunchEnv(process.env, launch, resumeId)

const install = resolveOfficialDsh({ from: import.meta.url })
const result = spawnSync(
  process.execPath,
  [install.binPath, ...officialTuiArgv(patchPath, extra)],
  { stdio: 'inherit', cwd: dir, env },
)
process.exit(result.status ?? 1)
