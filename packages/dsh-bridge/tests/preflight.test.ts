import { describe, expect, it } from 'vitest'
import {
  formatPreflightReport,
  officialApiKeyPresent,
  OFFICIAL_API_KEY_ENV,
} from '../src/preflight.ts'

describe('distribution preflight', () => {
  it('only reports whether the official key is set', () => {
    expect(officialApiKeyPresent({})).toBe(false)
    expect(officialApiKeyPresent({ [OFFICIAL_API_KEY_ENV]: '   ' })).toBe(false)
    expect(officialApiKeyPresent({ [OFFICIAL_API_KEY_ENV]: 'sk-test' })).toBe(true)
  })

  it('never prints the key value', () => {
    const text = formatPreflightReport({
      officialPackage: '@deepseek-ai/dsh',
      officialVersion: '0.1.0-rc.6',
      officialBin: '/tmp/bin.js',
      officialHome: '/home/dev/.dsh',
      sessionCount: 2,
      apiKeyPresent: false,
      tty: false,
    })
    expect(text).toMatch(/未设置 DEEPSEEK_API_KEY/)
    expect(text).toMatch(/dsh-community sessions/)
    expect(text).not.toMatch(/sk-/)
  })
})
