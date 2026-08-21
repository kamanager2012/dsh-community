import { describe, expect, it } from 'vitest'
import { communityClientVersion, formatClientIdentity } from '../src/version.ts'

describe('client identity', () => {
  it('prints this client and the official pin, not a second runtime', () => {
    expect(communityClientVersion()).toBe('0.1.0-rc.8-community.1')
    const text = formatClientIdentity('@deepseek-ai/dsh', '0.1.0-rc.8')
    expect(text).toBe(
      'DeepSeek Harness Community v0.1.0-rc.8-community.1 [Official Core: @deepseek-ai/dsh@0.1.0-rc.8]\n',
    )
  })
})
