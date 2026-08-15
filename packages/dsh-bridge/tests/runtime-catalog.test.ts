import { describe, expect, it } from 'vitest'
import {
  emptyRuntimeCatalog,
  hydrateCatalog,
  parseRuntimeCatalog,
  pinDefault,
  recommendUpdate,
  resolveRuntimePin,
  runtimeSwitchAvailable,
} from '../src/runtime-catalog.ts'

describe('runtime catalog', () => {
  it('recommends latest tested, not whatever is newest on npm', () => {
    const catalog = {
      ...emptyRuntimeCatalog('0.1.0-rc.6'),
      latestTested: '0.1.0-rc.6',
      projects: { 'proj-a': '0.1.0-rc.5' },
    }
    expect(resolveRuntimePin(catalog)).toBe('0.1.0-rc.6')
    expect(resolveRuntimePin(catalog, 'proj-a')).toBe('0.1.0-rc.5')
    expect(recommendUpdate(catalog, '0.1.0-rc.6')).toBe('stay')
    expect(recommendUpdate(catalog, '0.1.0-rc.5')).toBe('offer-tested')
  })

  it('ignores a stored latestTested and keeps the contract value', () => {
    const stored = parseRuntimeCatalog({
      latestTested: '0.0.0-user-forged',
      defaultPin: '0.1.0-rc.5',
      projects: { a: '0.1.0-rc.5' },
    })
    const hydrated = hydrateCatalog(stored, '0.1.0-rc.6', '0.1.0-rc.6')
    expect(hydrated.latestTested).toBe('0.1.0-rc.6')
    expect(hydrated.defaultPin).toBe('0.1.0-rc.5')
    expect(pinDefault(hydrated, '0.1.0-rc.6').defaultPin).toBe('0.1.0-rc.6')
  })

  it('does not pretend this workspace can switch official artifacts yet', () => {
    expect(runtimeSwitchAvailable('0.1.0-rc.6', '0.1.0-rc.6')).toBe(true)
    expect(runtimeSwitchAvailable('0.1.0-rc.6', '0.1.0-rc.8')).toBe(false)
  })
})
