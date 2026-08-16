import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function communityPatchDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../../../packages/tui-adapter/patches')
}

/**
 * Our overlay keeps official tools enabled and drives everything through the
 * official approval waterfall. We implement no second tool layer, so there is
 * no isolation disable-list to maintain.
 */
export function composeCommunityTuiPatch(patchDir = communityPatchDir()): string {
  const owned = readFileSync(join(patchDir, 'tui-owned.cordis.patch.yml'), 'utf8')
  return `# dsh-community overlay on official dsh. Official foundation only.
# Do not mount third-party TUI packages.
${owned.trim()}
`
}
