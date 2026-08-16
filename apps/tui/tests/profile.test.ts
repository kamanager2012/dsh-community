import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeCommunityTuiPatch } from '../src/compose-patch.ts'
import {
  COMMUNITY_TUI_HELP,
  isCommunityListSessions,
  officialAppArgs,
  officialTuiArgv,
  parseCommunityLaunch,
  resumeEnv,
} from '../src/launch.ts'
import {
  COMMUNITY_TUI_BUNDLES,
  COMMUNITY_TUI_PROFILE,
  buildProfileManifest,
  ensureCommunityTuiProfile,
} from '../src/profile.ts'

describe('our TUI profile', () => {
  it('uses official base only — reference TUI is a dependency, not a bundle', () => {
    const manifest = buildProfileManifest()
    expect(manifest.dsh?.profile?.bundles).toEqual([...COMMUNITY_TUI_BUNDLES])
    expect(manifest.dependencies?.['@deepseek-harness-tui/dsh-tui']).toBe('0.6.1')
    expect(manifest.dependencies?.['dsh-working-activity']).toBeUndefined()
    expect(manifest.dsh?.profile?.bundles).not.toContain('@deepseek-harness-tui/dsh-tui')
  })

  it('writes our patch into the official home profiles dir', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-community-tui-'))
    const patch = composeCommunityTuiPatch()
    const result = ensureCommunityTuiProfile({ dshHome: home, communityPatch: patch })
    expect(result.dir).toBe(join(home, 'profiles', COMMUNITY_TUI_PROFILE))
    const written = readFileSync(result.patchPath, 'utf8')
    expect(written).toMatch(/dsh-community TUI composition/)
    expect(written).toMatch(/tool-bash/)
    expect(written).toMatch(/dsh-tui/)
    const pkg = JSON.parse(readFileSync(join(result.dir, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(pkg.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
  })

  it('lists official sessions without launching Ink', () => {
    expect(isCommunityListSessions(['--list-sessions'])).toBe(true)
    expect(isCommunityListSessions(['--help'])).toBe(false)
    expect(parseCommunityLaunch(['--help'])).toEqual({ kind: 'help' })
    expect(parseCommunityLaunch(['--', '--help'])).toEqual({ kind: 'help' })
    expect(parseCommunityLaunch(['--', '--list-sessions']).kind).toBe('list')
    expect(COMMUNITY_TUI_HELP).toMatch(/official @deepseek-ai\/dsh/)
    expect(COMMUNITY_TUI_HELP).toMatch(/--list-sessions/)
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
    expect(() => parseCommunityLaunch(['--resume'])).toThrow(/session id/)
  })
})
