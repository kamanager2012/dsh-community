import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function communityPatchDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../../../packages/tui-adapter/patches')
}

/** Isolation first, then TUI-owned. Never include the reference 33-row file. */
export function composeCommunityTuiPatch(patchDir = communityPatchDir()): string {
  const isolation = readFileSync(join(patchDir, 'preset-isolation.cordis.patch.yml'), 'utf8')
  const owned = readFileSync(join(patchDir, 'tui-owned.cordis.patch.yml'), 'utf8')
  return `# dsh-community TUI composition. We own this file.
# Reference TUI (dsh-TUI) is an Ink implementation we mount, not a repo we patch.
${isolation.trim()}

${owned.trim()}
`
}
