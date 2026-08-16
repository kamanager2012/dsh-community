import { describe, expect, it } from 'vitest'
import {
  decideNavigation,
  decideOfficialViewNavigation,
  isDataHtmlUrl,
  isHttpUrl,
  sameOrigin,
} from '../src/navigation.ts'

describe('decideNavigation', () => {
  const origin = 'http://127.0.0.1:4310'

  it('keeps the official ready origin inside the window', () => {
    expect(decideNavigation('http://127.0.0.1:4310/', origin)).toBe('allow')
    expect(decideNavigation('http://127.0.0.1:4310/chat', origin)).toBe('allow')
  })

  it('sends other http(s) links to the system browser', () => {
    expect(decideNavigation('https://github.com/deepseek-ai/deepseek-harness', origin)).toBe('open-external')
    expect(decideNavigation('http://127.0.0.1:3080/', origin)).toBe('open-external')
  })

  it('blocks non-http schemes including file and javascript', () => {
    expect(decideNavigation('file:///etc/passwd', origin)).toBe('block')
    expect(decideNavigation('javascript:alert(1)', origin)).toBe('block')
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(sameOrigin('not a url', origin)).toBe(false)
  })

  it('lets the shell window load its own chrome documents', () => {
    const chrome = 'data:text/html;charset=utf-8,hello'
    expect(isDataHtmlUrl(chrome)).toBe(true)
    expect(decideNavigation(chrome, origin)).toBe('allow')
    expect(decideOfficialViewNavigation(chrome, origin)).toBe('block')
  })
})
