import { describe, expect, it } from 'vitest'
import { COMMUNITY_APP_ID_FORBIDDEN } from '../src/branding.ts'
import {
  forbiddenStageEntries,
  packagingIdentity,
  packagingIdentityIsCommunity,
  STAGED_OFFICIAL_BIN,
} from '../src/stage-policy.ts'

describe('packaging reconstruction', () => {
  it('uses a community app id, not the official desktop id', () => {
    expect(packagingIdentityIsCommunity()).toBe(true)
    expect(packagingIdentity().appId).not.toBe(COMMUNITY_APP_ID_FORBIDDEN)
  })

  it('stages the published official bin path and rejects a vendored monorepo', () => {
    expect(STAGED_OFFICIAL_BIN).toBe('node_modules/@deepseek-ai/dsh/lib/bin.js')
    expect(forbiddenStageEntries(['package.json', 'node_modules'])).toEqual([])
    expect(forbiddenStageEntries(['apps/cli', 'packages/session', 'README.md'])).toEqual([
      'apps/cli',
      'packages/session',
    ])
  })
})
