import { describe, expect, it } from 'vitest'
import { COMMUNITY_PRODUCT_VERSION, PINNED_DSH_VERSION } from '@dsh-community/dsh-bridge'
import { communityClientVersion, formatClientIdentity } from '../src/version.ts'

describe('client identity', () => {
  it('prints this client and the official pin, not a second runtime', () => {
    expect(communityClientVersion()).toBe(COMMUNITY_PRODUCT_VERSION)
    const text = formatClientIdentity('@deepseek-ai/dsh', PINNED_DSH_VERSION)
    expect(text).toBe(
      `DeepSeek Harness Community v${COMMUNITY_PRODUCT_VERSION} [Official Core: @deepseek-ai/dsh@${PINNED_DSH_VERSION}]\n`,
    )
  })
})
