import { describe, expect, it } from 'vitest'
import { emptyRuntimeCatalog } from '@dsh-community/dsh-bridge'
import { buildRuntimeView, readLatestTested } from '../src/runtime-view.ts'

describe('runtime view', () => {
  it('keeps official home and desktop home apart', () => {
    const view = buildRuntimeView({
      installed: '0.1.0-rc.6',
      catalog: emptyRuntimeCatalog('0.1.0-rc.6'),
      officialHome: '/home/dev/.dsh',
      desktopRoot: '/home/dev/.config/dsh-community',
      catalogPath: '/home/dev/.config/dsh-community/runtime-versions.json',
      isolated: false,
    })
    expect(view.officialHome).toBe('/home/dev/.dsh')
    expect(view.desktopRoot).not.toContain('/.dsh/')
    expect(view.recommendation).toBe('stay')
    expect(view.canSwitchToTested).toBe(true)
  })

  it('reads latest-tested from the contract file, not npm', () => {
    expect(readLatestTested({ version: '0.1.0-rc.6', package: '@deepseek-ai/dsh' }, 'fallback')).toBe('0.1.0-rc.6')
    expect(readLatestTested(undefined, '0.1.0-rc.6')).toBe('0.1.0-rc.6')
  })
})
