import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeCommunityTuiPatch } from '../src/compose-patch.ts'
import {
  COMMUNITY_TUI_HELP,
  initialPromptForLaunch,
  isCommunityListSessions,
  officialAppArgs,
  officialTuiArgv,
  parseCommunityLaunch,
  resumeEnv,
  tuiLaunchEnv,
} from '../src/launch.ts'
import {
  COMMUNITY_TUI_BUNDLES,
  COMMUNITY_TUI_PROFILE,
  buildProfileManifest,
  ensureCommunityTuiProfile,
} from '../src/profile.ts'

describe('our TUI profile', () => {
  it('uses official base plus our own surface — no third-party mounts', () => {
    const manifest = buildProfileManifest()
    expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', '@dsh-community/tui-surface'])
    expect(manifest.dependencies?.['@dsh-community/tui-surface']).toContain('file:')
    expect(manifest.dependencies?.['@deepseek-harness-tui/dsh-tui']).toBeUndefined()
  })

  it('writes our patch into the official home profiles dir', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-community-tui-'))
    const patch = composeCommunityTuiPatch()
    const result = ensureCommunityTuiProfile({ dshHome: home, communityPatch: patch })
    expect(result.dir).toBe(join(home, 'profiles', COMMUNITY_TUI_PROFILE))
    const written = readFileSync(result.patchPath, 'utf8')
    expect(written).toMatch(/dsh-community overlay/)
    expect(written).toMatch(/sandbox-policy/)
    expect(written).toMatch(/sandbox-policy/)
    expect(written).not.toMatch(/@deepseek-harness-tui\/dsh-tui/)
    const pkg = JSON.parse(readFileSync(join(result.dir, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(pkg.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@dsh-community/tui-surface'])
  })

  it('lists official sessions without launching Ink', () => {
    expect(isCommunityListSessions(['--list-sessions'])).toBe(true)
    expect(isCommunityListSessions(['--help'])).toBe(false)
    expect(parseCommunityLaunch(['--help'])).toEqual({ kind: 'help' })
    expect(parseCommunityLaunch(['version'])).toEqual({ kind: 'version' })
    expect(parseCommunityLaunch(['-v'])).toEqual({ kind: 'version' })
    expect(parseCommunityLaunch(['--doctor'])).toEqual({ kind: 'doctor' })
    expect(parseCommunityLaunch(['doctor'])).toEqual({ kind: 'doctor' })
    expect(parseCommunityLaunch(['--plugins'])).toEqual({ kind: 'plugins', porcelain: false })
    expect(parseCommunityLaunch(['sessions'])).toEqual({ kind: 'list', porcelain: false })
    expect(parseCommunityLaunch(['desktop'])).toEqual({ kind: 'desktop' })
    expect(parseCommunityLaunch([])).toEqual({ kind: 'default' })
    expect(parseCommunityLaunch(['new'])).toEqual({ kind: 'new', rest: [] })
    expect(parseCommunityLaunch(['tui', 'resume', 'last'])).toEqual({
      kind: 'resume',
      id: 'last',
      rest: [],
    })
    expect(parseCommunityLaunch(['--', '--help'])).toEqual({ kind: 'help' })
    expect(parseCommunityLaunch(['--', '--list-sessions'])).toEqual({ kind: 'list', porcelain: false })
    expect(parseCommunityLaunch(['-l', '--porcelain'])).toEqual({ kind: 'list', porcelain: true })
    expect(COMMUNITY_TUI_HELP).toMatch(/@deepseek-ai\/dsh/)
    expect(COMMUNITY_TUI_HELP).toMatch(/--resume last/)
  })

  it('keeps task text out of child argv and injects it only as the first TUI turn', () => {
    const fresh = parseCommunityLaunch(['new', 'review', 'the', 'diff'])
    expect(fresh).toEqual({ kind: 'new', rest: ['review', 'the', 'diff'] })
    expect(initialPromptForLaunch(fresh)).toBe('review the diff')

    const run = parseCommunityLaunch(['fix', 'the', 'tests'])
    expect(run).toEqual({ kind: 'run', rest: ['fix', 'the', 'tests'] })
    const runArgs = officialAppArgs(run as Extract<typeof run, { kind: 'run' }>)
    expect(runArgs).toEqual([])
    const childArgv = officialTuiArgv('/tmp/community.patch.yml', runArgs)
    expect(childArgv.join(' ')).not.toContain('fix the tests')
    expect(tuiLaunchEnv({}, run).DSH_TUI_FIRST_PROMPT).toBe('fix the tests')

    const resumed = parseCommunityLaunch(['resume', 'sess-abc', 'continue', 'carefully'])
    expect(initialPromptForLaunch(resumed)).toBe('continue carefully')
    expect(officialAppArgs(resumed as Extract<typeof resumed, { kind: 'resume' }>)).toEqual([
      '--resume',
      'sess-abc',
    ])
    const resumedEnv = tuiLaunchEnv({}, resumed, 'sess-abc')
    expect(resumedEnv.DSH_TUI_RESUME_SESSION).toBe('sess-abc')
    expect(resumedEnv.DSH_TUI_FIRST_PROMPT).toBe('continue carefully')
  })

  it('resumes from an official session id, not a second store', () => {
    const launch = parseCommunityLaunch(['--resume', 'sess-abc'])
    expect(launch).toEqual({
      kind: 'resume',
      id: 'sess-abc',
      rest: [],
    })
    expect(officialAppArgs(launch as Extract<typeof launch, { kind: 'resume' }>)).toEqual([
      '--resume',
      'sess-abc',
    ])
    expect(officialTuiArgv('/tmp/community.patch.yml', officialAppArgs(launch as Extract<typeof launch, { kind: 'resume' }>))).toEqual([
      '--profile',
      COMMUNITY_TUI_PROFILE,
      '--patch',
      '/tmp/community.patch.yml',
      '--resume',
      'sess-abc',
    ])
    expect(resumeEnv({}, 'sess-abc').DSH_TUI_RESUME_SESSION).toBe('sess-abc')
    expect(resumeEnv({}, 'sess-abc').DSH_CC_RESUME_SESSION).toBe('sess-abc')
    expect(parseCommunityLaunch(['--resume'])).toEqual({ kind: 'pick' })
    expect(parseCommunityLaunch(['--resume', 'last'])).toEqual({
      kind: 'resume',
      id: 'last',
      rest: [],
    })
  })
})
