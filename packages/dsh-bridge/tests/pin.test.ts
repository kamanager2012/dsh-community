import { describe, expect, it } from 'vitest'
import { assertPinnedVersion, PINNED_DSH_VERSION } from '../src/pin.ts'

describe('assertPinnedVersion', () => {
  it('accepts the pinned rc', () => {
    expect(() => assertPinnedVersion(PINNED_DSH_VERSION, {})).not.toThrow()
  })

  it('rejects a drift unless unpinning is explicit', () => {
    expect(() => assertPinnedVersion('0.0.0-not-pinned', {})).toThrow(/expected/)
    expect(() => assertPinnedVersion('0.0.0-not-pinned', { DSH_COMMUNITY_ALLOW_UNPINNED: '1' })).not.toThrow()
  })
})
