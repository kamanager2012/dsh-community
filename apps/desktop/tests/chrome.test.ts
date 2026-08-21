import { describe, expect, it } from 'vitest'
import { CHROME_HEIGHT, officialViewBounds, renderChromePage } from '../src/chrome.ts'

describe('desktop chrome around official dsh web', () => {
  it('keeps official web below a fixed bar', () => {
    expect(officialViewBounds(1280, 840, true)).toEqual({
      x: 0,
      y: CHROME_HEIGHT,
      width: 1280,
      height: 840 - CHROME_HEIGHT,
    })
    expect(officialViewBounds(1280, 840, false)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(officialViewBounds(800, 40, true).height).toBe(0)
  })

  it('renders a bar that can reopen official web and shell pages', () => {
    const html = renderChromePage({
      product: 'DSH Community',
      identity: 'DeepSeek Harness Community v0.1.1-rc.1 [Official Core: @deepseek-ai/dsh@0.1.1-rc.1]',
      phase: 'ready',
      isolated: false,
      origin: 'http://127.0.0.1:4310',
      active: 'official',
    })
    expect(html).toMatch(/共用 ~\/\.dsh/)
    expect(html).toMatch(/DeepSeek Harness Community v0\.1\.1-rc\.1 \[Official Core: @deepseek-ai\/dsh@0\.1\.1-rc\.1\]/)
    expect(html).toMatch(/data-go="official"/)
    expect(html).toMatch(/data-go="sessions"/)
    expect(html).toMatch(/data-go="marketplace"/)
    expect(html).toMatch(/showMarketplace/)
    expect(html).toMatch(/data-active="true"/)
    expect(html).not.toMatch(/agent loop/)
  })
})
