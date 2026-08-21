import {
  COMMUNITY_PRODUCT_VERSION,
  formatCommunityIdentity,
} from '@dsh-community/dsh-bridge'

export function communityClientVersion(): string {
  return COMMUNITY_PRODUCT_VERSION
}

export function formatClientIdentity(officialPackage: string, officialVersion: string): string {
  return `${formatCommunityIdentity(officialPackage, officialVersion)}\n`
}
