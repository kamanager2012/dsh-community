import { describe, expect, it } from 'vitest'
import { communityClientVersion, formatClientIdentity } from '../src/version.ts'

describe('client identity', () => {
  it('prints this client and the official pin, not a second runtime', () => {
    expect(communityClientVersion()).toMatch(/^\d+\.\d+\.\d+/)
    const text = formatClientIdentity('@deepseek-ai/dsh', '0.1.0-rc.6')
    expect(text).toMatch(/^dsh-community /)
    expect(text).toMatch(/official @deepseek-ai\/dsh@0\.1\.0-rc\.6/)
  })
})
