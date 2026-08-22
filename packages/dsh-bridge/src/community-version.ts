/**
 * Community release identity.
 *
 * The community product mirrors the official runtime's version. A
 * `-community.N` suffix is reserved for community-owned fixes made against
 * the same official core release.
 */
export const COMMUNITY_PRODUCT_NAME = 'DeepSeek Harness Community' as const
export const COMMUNITY_PRODUCT_VERSION = '0.1.1-rc.2' as const
export const OFFICIAL_CORE_PACKAGE = '@deepseek-ai/dsh' as const

const COMMUNITY_SUFFIX = /-community\.(?:0|[1-9]\d*)$/u

export function communityBaseVersion(version: string): string {
  return version.replace(COMMUNITY_SUFFIX, '')
}

export function assertCommunityVersionMatchesOfficial(
  communityVersion: string,
  officialVersion: string,
): void {
  if (communityBaseVersion(communityVersion) !== officialVersion) {
    throw new Error(
      `community version ${communityVersion} does not mirror official core ${officialVersion}`,
    )
  }
}

export function formatCommunityIdentity(
  officialPackage: string,
  officialVersion: string,
  communityVersion = COMMUNITY_PRODUCT_VERSION,
): string {
  if (officialPackage !== OFFICIAL_CORE_PACKAGE) {
    throw new Error(`official core package must be ${OFFICIAL_CORE_PACKAGE}`)
  }
  assertCommunityVersionMatchesOfficial(communityVersion, officialVersion)
  return `${COMMUNITY_PRODUCT_NAME} v${communityVersion} [Official Core: ${officialPackage}@${officialVersion}]`
}
