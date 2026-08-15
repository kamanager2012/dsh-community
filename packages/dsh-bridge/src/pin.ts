/** Exact published runtime this workspace is allowed to launch. */
export const OFFICIAL_DSH_PACKAGE = '@deepseek-ai/dsh' as const

export const PINNED_DSH_VERSION = '0.1.0-rc.6' as const

export const OFFICIAL_DSH_BIN_NAME = 'dsh' as const

export const OFFICIAL_DSH_BIN_REL = 'lib/bin.js' as const

/**
 * Set `DSH_COMMUNITY_ALLOW_UNPINNED=1` only when deliberately testing a
 * newer official rc before changing the pin.
 */
export function unpinningAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DSH_COMMUNITY_ALLOW_UNPINNED === '1'
}

export function assertPinnedVersion(version: string, env: NodeJS.ProcessEnv = process.env): void {
  if (version === PINNED_DSH_VERSION) return
  if (unpinningAllowed(env)) return
  throw new Error(
    `expected ${OFFICIAL_DSH_PACKAGE}@${PINNED_DSH_VERSION}, found ${version}. `
      + 'Bump PINNED_DSH_VERSION and package.json together (see docs/upgrade.md), '
      + 'or set DSH_COMMUNITY_ALLOW_UNPINNED=1 while probing a newer rc.',
  )
}
