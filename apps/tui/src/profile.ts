import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const COMMUNITY_TUI_PROFILE = 'dsh-community-tui'

export interface ProfileManifest {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

/** Official base only. The terminal surface is our own @dsh-community/tui-surface. */
export const COMMUNITY_TUI_BUNDLES = ['@deepseek-ai/dsh-base', '@dsh-community/tui-surface'] as const

/** Absolute file: spec for our own terminal plugin (built dist included). */
export function communityTuiPackageSpec(): string {
  const tuiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/tui')
  return `file:${tuiRoot}`
}

export function communityTuiPluginDeps(): Record<string, string> {
  return { '@dsh-community/tui-surface': communityTuiPackageSpec() }
}

export function profileDir(dshHome: string, name = COMMUNITY_TUI_PROFILE): string {
  return join(dshHome, 'profiles', name)
}

export function buildProfileManifest(existing?: ProfileManifest): ProfileManifest {
  const dependencies = { ...existing?.dependencies, ...communityTuiPluginDeps() }
  return {
    name: existing?.name ?? `dsh-profile-${COMMUNITY_TUI_PROFILE}`,
    private: true,
    dependencies,
    dsh: {
      profile: {
        bundles: [...COMMUNITY_TUI_BUNDLES],
      },
    },
  }
}

export function ensureCommunityTuiProfile(input: {
  readonly dshHome: string
  readonly communityPatch: string
}): { readonly dir: string; readonly patchPath: string; readonly created: boolean } {
  const dir = profileDir(input.dshHome)
  const created = !existsSync(join(dir, 'package.json'))
  mkdirSync(dir, { recursive: true })

  const manifestPath = join(dir, 'package.json')
  const existing = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifest
    : undefined
  writeFileSync(manifestPath, `${JSON.stringify(buildProfileManifest(existing), null, 2)}\n`)

  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) {
    writeFileSync(workspacePath, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  }

  const userPatch = join(dir, 'cordis.patch.yml')
  if (!existsSync(userPatch)) {
    writeFileSync(userPatch, '# User layer for dsh-community-tui. Applied after community patches.\n[]\n')
  }

  const patchPath = join(dir, 'dsh-community.patch.yml')
  writeFileSync(patchPath, input.communityPatch)
  return { dir, patchPath, created }
}
