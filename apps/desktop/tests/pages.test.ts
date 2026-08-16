import { describe, expect, it } from 'vitest'
import {
  renderAboutPage,
  renderDiagnosticsPage,
  renderErrorPage,
  renderLoadingPage,
  renderOfficialSessionsPage,
  renderRuntimePage,
  renderSettingsPage,
} from '../src/pages.ts'

describe('shell pages', () => {
  it('says the window is a shell around official dsh web', () => {
    expect(renderLoadingPage()).toMatch(/dsh web/)
    expect(renderLoadingPage()).toMatch(/不跑第二套/)
  })

  it('gives a restart action when the official child fails', () => {
    const html = renderErrorPage('spawn failed')
    expect(html).toMatch(/spawn failed/)
    expect(html).toMatch(/restartHost/)
    expect(html).toMatch(/@deepseek-ai\/dsh/)
  })

  it('prints the official pin on the about page', () => {
    const html = renderAboutPage({
      product: 'DSH Community',
      officialPackage: '@deepseek-ai/dsh',
      officialVersion: '0.1.0-rc.6',
      officialBin: '/tmp/lib/bin.js',
      officialHome: '/home/dev/.dsh',
      desktopRoot: '/home/dev/.config/dsh-community',
      isolated: false,
      latestTested: '0.1.0-rc.6',
      officialSessionCount: 3,
      origin: 'http://127.0.0.1:4310',
      phase: 'ready',
      pid: '12',
      logs: 'dsh web: http://127.0.0.1:4310',
    })
    expect(html).toMatch(/@deepseek-ai\/dsh@0\.1\.0-rc\.6/)
    expect(html).toMatch(/~\/\.dsh/)
    expect(html).toMatch(/同一批 Session/)
    expect(html).toMatch(/\/home\/dev\/\.dsh/)
    expect(html).toMatch(/dsh-community/)
    expect(html).toMatch(/3 sessions/)
  })

  it('lists official ~/.dsh sessions without a second store', () => {
    const empty = renderOfficialSessionsPage({
      product: 'DSH Community',
      officialHome: '/home/dev/.dsh',
      isolated: false,
      sessions: [],
    })
    expect(empty).toMatch(/~\/\.dsh\/sessions/)
    expect(empty).toMatch(/不会另建目录/)
    const listed = renderOfficialSessionsPage({
      product: 'DSH Community',
      officialHome: '/home/dev/.dsh',
      isolated: false,
      sessions: [{
        id: 'sess-abc',
        projectKey: '--tmp-proj--',
        transcript: '/home/dev/.dsh/sessions/--tmp-proj--/sess-abc/session.jsonl.zstd',
        updatedAt: '2026-08-16 00:31:15 UTC',
      }],
    })
    expect(listed).toMatch(/sess-abc/)
    expect(listed).toMatch(/--tmp-proj--/)
    expect(listed).toMatch(/2026-08-16 00:31:15 UTC/)
    expect(listed).toMatch(/dsh-community-tui --resume/)
    expect(listed).toMatch(/复制 --resume/)
    expect(listed).not.toMatch(/\.dsh-cc/)
  })

  it('keeps settings on the desktop shell, not the official store', () => {
    const html = renderSettingsPage({
      product: 'DSH Community',
      hideToTray: true,
      isolated: false,
      envIsolated: false,
      officialHome: '/home/dev/.dsh',
      isolatedHome: '/home/dev/.config/dsh-community/isolated-dsh',
    })
    expect(html).toMatch(/hideToTray/)
    expect(html).toMatch(/isolated-dsh/)
    expect(html).toMatch(/不再共用/)
    expect(html).toMatch(/data-go="settings"/)
  })

  it('shows host logs as diagnostics only', () => {
    const html = renderDiagnosticsPage({
      product: 'DSH Community',
      officialHome: '/home/dev/.dsh',
      isolated: false,
      origin: 'http://127.0.0.1:4310',
      phase: 'ready',
      pid: '12',
      logs: 'dsh web: http://127.0.0.1:4310',
    })
    expect(html).toMatch(/dsh web: http:\/\/127\.0\.0\.1:4310/)
    expect(html).toMatch(/不解析 agent/)
    expect(html).toMatch(/copyText/)
  })

  it('shows latest-tested instead of npm latest on the runtime page', () => {
    const html = renderRuntimePage({
      product: 'DSH Community',
      installed: '0.1.0-rc.6',
      latestTested: '0.1.0-rc.6',
      defaultPin: '0.1.0-rc.6',
      recommendation: 'stay',
      canSwitchToTested: true,
      officialHome: '/home/dev/.dsh',
      desktopRoot: '/tmp/desktop',
      catalogPath: '/tmp/desktop/runtime-versions.json',
      isolated: false,
    })
    expect(html).toMatch(/latest-tested/)
    expect(html).toMatch(/不是 npm latest/)
    expect(html).toMatch(/runtime-versions\.json/)
  })
})
