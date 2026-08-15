import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOW_STATE,
  isPlausibleWindowState,
  parseWindowState,
  windowStateFromBounds,
} from '../src/window-state.ts'

describe('window state', () => {
  it('rejects junk and keeps a usable default', () => {
    expect(parseWindowState(undefined)).toBeUndefined()
    expect(parseWindowState({ width: 10, height: 10 })).toBeUndefined()
    expect(parseWindowState({ width: 1280, height: 840, x: 12, y: 24 })).toEqual({
      width: 1280,
      height: 840,
      x: 12,
      y: 24,
    })
    expect(isPlausibleWindowState(DEFAULT_WINDOW_STATE)).toBe(true)
    expect(windowStateFromBounds({ x: 1, y: 2, width: 900, height: 700 })).toEqual({
      x: 1,
      y: 2,
      width: 900,
      height: 700,
    })
  })
})
