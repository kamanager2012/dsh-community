import { describe, expect, it } from 'vitest'
import {
  formatPluginCatalog,
  officialPluginAddCommand,
  parsePluginCatalog,
} from '../src/plugin-catalog.ts'

describe('read-only plugin catalog', () => {
  it('builds the official install command', () => {
    expect(officialPluginAddCommand('dsh-context')).toBe('dsh plugin add dsh-context')
    expect(() => officialPluginAddCommand('')).toThrow(/package name/)
  })

  it('parses the community registry without becoming an installer', () => {
    const catalog = parsePluginCatalog({
      updatedAt: '2026-08-16T00:00:00Z',
      plugins: [
        {
          name: 'dsh-context',
          description: '上下文面板',
          author: 'bowenliang123',
          repo: 'https://github.com/bowenliang123/dsh-context',
          category: 'ui',
          versions: [{ version: '0.8.0', testedDsh: '0.1.0-rc.6' }],
        },
      ],
    })
    expect(catalog.plugins).toHaveLength(1)
    expect(catalog.plugins[0]?.testedDsh).toBe('0.1.0-rc.6')
    const text = formatPluginCatalog(catalog, 'https://github.com/kamanager2012/dsh-community-plugins')
    expect(text).toMatch(/dsh plugin add dsh-context/)
    expect(text).toMatch(/只读/)
    expect(text).not.toMatch(/installPlugin/)
  })
})
