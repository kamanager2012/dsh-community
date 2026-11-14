import { describe, expect, it } from 'vitest'
import { decideHostCrash, decideWindowClose, shouldApplyAsyncPageUpdate } from '../src/shell-policy.ts'

describe('shell policy', () => {
  it('hides the window when a tray still owns the official host', () => {
    expect(decideWindowClose({ quitting: false, trayAvailable: true })).toBe('hide')
  })

  it('quits when there is no tray or the user asked to quit', () => {
    expect(decideWindowClose({ quitting: false, trayAvailable: false })).toBe('quit')
    expect(decideWindowClose({ quitting: true, trayAvailable: true })).toBe('quit')
  })

  it('offers restart after an unexpected official-host crash', () => {
    expect(decideHostCrash(false)).toBe('offer-restart')
    expect(decideHostCrash(true)).toBe('ignore')
  })

  it('prevents background async completions from hijacking navigated views', () => {
    expect(
      shouldApplyAsyncPageUpdate({
        quitting: false,
        showingOfficial: false,
        currentPage: 'remote',
        expectedPage: 'remote',
      }),
    ).toBe(true)
    expect(
      shouldApplyAsyncPageUpdate({
        quitting: false,
        showingOfficial: false,
        currentPage: 'about',
        expectedPage: 'remote',
      }),
    ).toBe(false)
    expect(
      shouldApplyAsyncPageUpdate({
        quitting: false,
        showingOfficial: true,
        currentPage: 'remote',
        expectedPage: 'remote',
      }),
    ).toBe(false)
    expect(
      shouldApplyAsyncPageUpdate({
        quitting: true,
        showingOfficial: false,
        currentPage: 'remote',
        expectedPage: 'remote',
      }),
    ).toBe(false)
  })
})
