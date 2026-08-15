import { COMMUNITY_APP_ID, COMMUNITY_APP_ID_FORBIDDEN, COMMUNITY_PRODUCT_NAME } from './branding.ts'

export const STAGED_OFFICIAL_BIN = 'node_modules/@deepseek-ai/dsh/lib/bin.js'

const FORBIDDEN_RELATIVE = [
  'apps/cli',
  'apps/web',
  'packages/core',
  'packages/session',
  'packages/agent',
  'packages/llm',
  'packages/bundle',
  'vendor/deepseek-harness',
]

export function forbiddenStageEntries(names: readonly string[]): string[] {
  return FORBIDDEN_RELATIVE.filter((rel) => names.includes(rel))
}

export function packagingIdentity(): { appId: string; productName: string } {
  return { appId: COMMUNITY_APP_ID, productName: COMMUNITY_PRODUCT_NAME }
}

export function packagingIdentityIsCommunity(): boolean {
  const { appId } = packagingIdentity()
  return appId === COMMUNITY_APP_ID && appId !== (COMMUNITY_APP_ID_FORBIDDEN as string)
}
