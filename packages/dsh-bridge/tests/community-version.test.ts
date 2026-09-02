import { describe, expect, it } from 'vitest'
import {
  assertCommunityVersionMatchesOfficial,
  communityBaseVersion,
  formatCommunityIdentity,
} from '../src/community-version.ts'

describe('community version identity', () => {
  it('removes only the community patch suffix', () => {
    expect(communityBaseVersion('0.1.0-rc.8-community.1')).toBe('0.1.0-rc.8')
    expect(communityBaseVersion('0.1.1')).toBe('0.1.1')
  })

  it('accepts an exact mirror or a community patch on that mirror', () => {
    expect(() => assertCommunityVersionMatchesOfficial('0.1.1', '0.1.1')).not.toThrow()
    expect(() => assertCommunityVersionMatchesOfficial('0.1.0-rc.8-community.1', '0.1.0-rc.8')).not.toThrow()
  })

  it('rejects a community version based on a different official core', () => {
    expect(() => assertCommunityVersionMatchesOfficial('0.1.0-rc.8-community.1', '0.1.0-rc.7'))
      .toThrow('does not mirror official core')
  })

  it('formats the exact Dual-Badge identity', () => {
    expect(formatCommunityIdentity('@deepseek-ai/dsh', '0.1.0-rc.8', '0.1.0-rc.8-community.1'))
      .toBe('DeepSeek Harness Community v0.1.0-rc.8-community.1 [Official Core: @deepseek-ai/dsh@0.1.0-rc.8]')
    expect(formatCommunityIdentity('@deepseek-ai/dsh', '0.1.2-alpha.4'))
      .toBe('DeepSeek Harness Community v0.1.2-alpha.4 [Official Core: @deepseek-ai/dsh@0.1.2-alpha.4]')
  })

  it('does not allow a different package name in the official-core badge', () => {
    expect(() => formatCommunityIdentity('@deepseek-ai/other', '0.1.0-rc.8'))
      .toThrow('official core package must be @deepseek-ai/dsh')
  })
})
