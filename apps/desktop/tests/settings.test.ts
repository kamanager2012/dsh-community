import { describe, expect, it } from 'vitest'
import {
  applyDesktopSettingsPatch,
  DEFAULT_DESKTOP_SETTINGS,
  parseDesktopSettings,
  readSettingsPatch,
} from '../src/settings.ts'

describe('desktop settings', () => {
  it('defaults to shared ~/.dsh and hide-to-tray', () => {
    expect(parseDesktopSettings(undefined)).toEqual(DEFAULT_DESKTOP_SETTINGS)
    expect(parseDesktopSettings({})).toEqual({ hideToTray: true, isolated: false })
  })

  it('does not treat a missing isolated flag as on', () => {
    expect(parseDesktopSettings({ hideToTray: false })).toEqual({
      hideToTray: false,
      isolated: false,
    })
    expect(parseDesktopSettings({ isolated: true }).isolated).toBe(true)
  })

  it('applies a partial patch without inventing other prefs', () => {
    const next = applyDesktopSettingsPatch(
      { hideToTray: true, isolated: false },
      readSettingsPatch({ isolated: true, extra: 'nope' }),
    )
    expect(next).toEqual({ hideToTray: true, isolated: true })
    expect(readSettingsPatch('nope')).toEqual({})
  })
})
