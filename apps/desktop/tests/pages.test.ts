import { describe, expect, it } from 'vitest'
import { parseSessionWorkspaceSummary } from '../src/remote.ts'
import {
  renderAboutPage,
  renderDiagnosticsPage,
  renderErrorPage,
  renderLoadingPage,
  renderMarketplacePage,
  renderOfficialSessionsPage,
  renderRemotePage,
  renderRuntimePage,
  renderSettingsPage,
} from '../src/pages.ts'

describe('shell pages', () => {
  it('says the window is a shell around official dsh web', () => {
    expect(renderLoadingPage()).toMatch(/dsh web/)
    expect(renderLoadingPage()).toMatch(/不跑第二套/)
    expect(renderLoadingPage('第一次启动，正在解开官方 Runtime，只做一次。')).toMatch(/解开官方 Runtime/)
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
      identity: 'DeepSeek Harness Community v0.1.1-rc.2 [Official Core: @deepseek-ai/dsh@0.1.1-rc.2]',
      officialPackage: '@deepseek-ai/dsh',
      officialVersion: '0.1.1-rc.2',
      officialBin: '/tmp/lib/bin.js',
      officialHome: '/home/dev/.dsh',
      desktopRoot: '/home/dev/.config/dsh-community',
      isolated: false,
      latestTested: '0.1.1-rc.2',
      officialSessionCount: 3,
      origin: 'http://127.0.0.1:4310',
      phase: 'ready',
      pid: '12',
      logs: 'dsh web: http://127.0.0.1:4310',
    })
    expect(html).toMatch(/DeepSeek Harness Community v0\.1\.1-rc\.2 \[Official Core: @deepseek-ai\/dsh@0\.1\.1-rc\.2\]/)
    expect(html).toMatch(/@deepseek-ai\/dsh@0\.1\.1-rc\.2/)
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
    expect(html).not.toMatch(/settings-tray-unavailable/)

    const noTrayHtml = renderSettingsPage({
      product: 'DSH Community',
      hideToTray: true,
      trayAvailable: false,
      isolated: false,
      envIsolated: false,
      officialHome: '/home/dev/.dsh',
      isolatedHome: '/home/dev/.config/dsh-community/isolated-dsh',
    })
    expect(noTrayHtml).toMatch(/settings-tray-unavailable/)
    expect(noTrayHtml).toMatch(/直接退出应用/)
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

  it('shows latest-tested as compatibility evidence, not a source or publication identity', () => {
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
    expect(html).toMatch(/不是 Candidate Source pin/)
    expect(html).toMatch(/npm latest/)
    expect(html).toMatch(/GitHub Published Latest/)
    expect(html).toMatch(/runtime-versions\.json/)
  })

  it('escapes diagnostics logs against </script> breakout and enforces nonce CSP', () => {
    const payload = '</script><img src=x onerror=alert(1)>'
    const html = renderDiagnosticsPage({
      product: 'DSH Community',
      officialHome: '/home/dev/.dsh',
      isolated: false,
      origin: 'http://127.0.0.1:4310',
      phase: 'ready',
      pid: '12',
      logs: payload,
    })
    expect(html).not.toContain('</script><img')
    expect(html).not.toContain(JSON.stringify(payload))
    expect(html).toContain('<template id="copy-logs-data">&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;</template>')
    const cspMatch = /content="[^"]*script-src 'nonce-([^']+)'/.exec(html)
    expect(cspMatch?.[1]).toBeTruthy()
    expect(html).toContain(`<script nonce="${cspMatch?.[1] ?? ''}">`)
  })

  it('renders remote pairing QR, pending approvals, devices, and escapes untrusted fields under strict CSP', () => {
    const html = renderRemotePage({
      product: 'DSH Community',
      phase: 'running',
      pid: '43210',
      configDir: '/tmp/remote-cfg',
      dshHome: '/tmp/dsh-home',
      isolated: true,
      apiKeyPresent: true,
      hostFingerprint: 'fp-host-1234',
      lanCandidates: ['192.168.1.50', '100.64.0.9'],
      effectiveListenHost: '192.168.1.50',
      settings: {
        listenHost: '',
        port: 9443,
        enableMdns: true,
        relayUrl: 'wss://relay.example.com',
        signalingUrl: 'wss://signal.example.com',
        stunUrls: 'stun:stun.l.google.com:19302',
      },
      lanUrl: 'ws://192.168.1.50:9443/remote',
      relayUrl: 'wss://relay.example.com',
      relayRoomId: 'room-relay',
      signalingUrl: 'wss://signal.example.com',
      signalingRoomId: 'room-rtc',
      stunUrls: ['stun:stun.l.google.com:19302'],
      activeConnections: 1,
      pairing: {
        deepLink: 'dshremote://pair?v=1&data=abc',
        pairingJson: '{"v":1,"host":"192.168.1.50"}',
        expiresAt: 1_760_000_000_000,
        qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges"><rect width="29" height="29" fill="#ffffff"/><path d="M4 4h7v1h-7z" fill="#101218"/></svg>',
      },
      pendingCandidates: [
        {
          candidateId: 'cand-1',
          deviceId: 'dev-pending',
          displayName: '</script><img src=x onerror=alert(9)>Pixel 9',
          maxAllowedCapabilities: ['observe', 'prompt', 'approve'],
          expiresAt: 1_760_000_100_000,
          state: 'pending',
        },
      ],
      devices: [
        {
          deviceId: 'dev-trusted-1',
          displayName: 'Xiaomi 15',
          capabilities: ['observe', 'prompt'],
          pairedAt: 1_759_999_000_000,
          lastSeenAt: 1_759_999_500_000,
        },
      ],
      logs: '</script><script>alert(1)</script>',
      notice: 'Remote Host 已就绪',
    })

    expect(html).toContain('data-go="remote"')
    expect(html).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
    expect(html).toContain('data-confirm-candidate="cand-1"')
    expect(html).toContain('data-allow-approve="cand-1"')
    expect(html).toContain('data-revoke-device="dev-trusted-1"')
    expect(html).toContain('192.168.1.50')
    expect(html).toContain('100.64.0.9')
    expect(html).not.toContain('</script><img')
    expect(html).not.toContain('</script><script>alert(1)')
    expect(html).toContain('&lt;/script&gt;&lt;img src=x onerror=alert(9)&gt;Pixel 9')
    const cspMatch = /content="[^"]*script-src 'nonce-([^']+)'/.exec(html)
    expect(cspMatch?.[1]).toBeTruthy()
    expect(html).not.toMatch(/style="/i)
  })

  it('rejects malicious QR SVG markup and shows loopback warning when needed', () => {
    const html = renderRemotePage({
      product: 'DSH Community',
      phase: 'running',
      pid: '99',
      configDir: '/tmp/cfg',
      dshHome: '/tmp/dsh',
      isolated: false,
      apiKeyPresent: false,
      hostFingerprint: 'fp-2',
      lanCandidates: ['192.168.0.10'],
      effectiveListenHost: '127.0.0.1',
      settings: {
        listenHost: '127.0.0.1',
        port: 0,
        enableMdns: false,
        relayUrl: '',
        signalingUrl: '',
        stunUrls: '',
      },
      lanUrl: 'ws://127.0.0.1:45123',
      relayUrl: '',
      relayRoomId: '',
      signalingUrl: '',
      signalingRoomId: '',
      stunUrls: [],
      activeConnections: 0,
      pairing: {
        deepLink: 'dshremote://pair?loopback=1',
        pairingJson: '{}',
        qrSvg: '<svg onload="alert(1)"><script>alert(1)</script></svg>',
        loopbackWarning: '提示: 当前仅监听 loopback',
      },
      pendingCandidates: [],
      devices: [],
      logs: '',
      error: 'Test failure banner',
    })

    expect(html).not.toContain('onload="alert(1)"')
    expect(html).toContain('无效二维码载荷')
    expect(html).toContain('提示: 当前仅监听 loopback')
    expect(html).toContain('缺少 DEEPSEEK_API_KEY')
    expect(html).toContain('Test failure banner')
  })

  it('renders rich session titles, previews, search filter, and live remote session status without inline styles', () => {
    const sessionsHtml = renderOfficialSessionsPage({
      product: 'Cogitally-OS Desktop (Community)',
      officialHome: '/tmp/.dsh',
      isolated: false,
      sessions: [
        {
          id: 'sess-ui-1',
          projectKey: '--tmp-repo--',
          transcript: '/tmp/session.v4.jsonl.zstd',
          updatedAt: '2026-11-14 01:00:00 UTC',
          title: 'Competitor Deep Dive',
          cwd: '/tmp/repo',
          preview: 'Optimized replay buffer and pagination <script>x</script>',
          model: 'deepseek-reasoner',
        },
      ],
    })
    expect(sessionsHtml).toContain('Competitor Deep Dive')
    expect(sessionsHtml).toContain('deepseek-reasoner')
    expect(sessionsHtml).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(sessionsHtml).toContain('id="session-filter"')
    expect(sessionsHtml).toContain('data-copy-id="sess-ui-1"')
    expect(sessionsHtml).not.toMatch(/style="/i)

    const remoteHtml = renderRemotePage({
      product: 'Cogitally-OS Desktop (Community)',
      phase: 'running',
      pid: '4242',
      configDir: '/tmp/remote',
      dshHome: '/tmp/.dsh',
      isolated: false,
      apiKeyPresent: true,
      hostFingerprint: 'fp-1234',
      lanCandidates: ['192.168.1.2'],
      effectiveListenHost: '192.168.1.2',
      settings: { listenHost: '', port: 0, enableMdns: true, relayUrl: '', signalingUrl: '', stunUrls: '' },
      lanUrl: 'ws://192.168.1.2:9000',
      relayUrl: '',
      relayRoomId: '',
      signalingUrl: '',
      signalingRoomId: '',
      stunUrls: [],
      activeConnections: 1,
      pendingApprovals: 2,
      pendingQuestions: 1,
      liveSessions: [
        {
          id: 'sess-live-9',
          title: 'Mobile Refactor',
          status: 'running',
          preview: 'Running cargo/pnpm suite',
          model: 'deepseek-chat',
          pendingApprovals: 2,
          pendingQuestions: 1,
        },
      ],
      pairing: {
        deepLink: 'dsh-remote://pair?fp=1',
        pairingJson: '{}',
        qrSvg: '<svg viewBox="0 0 10 10"></svg>',
      },
      pendingCandidates: [],
      devices: [],
      logs: '',
    })
    expect(remoteHtml).toContain('待审批 2')
    expect(remoteHtml).toContain('待回答 1')
    expect(remoteHtml).toContain('Mobile Refactor')
    expect(remoteHtml).toContain('运行中')
    expect(remoteHtml).toContain('id="copy-host-fp-btn"')
    expect(remoteHtml).not.toMatch(/style="/i)
  })

  it('highlights active nav tab, surfaces copy/save feedback, wraps errors, and shows local remote timestamps', () => {
    const settingsHtml = renderSettingsPage({
      product: 'DSH Community',
      hideToTray: true,
      isolated: false,
      envIsolated: false,
      officialHome: '/tmp/.dsh',
      isolatedHome: '/tmp/iso',
      saved: true,
    })
    expect(settingsHtml).toContain('data-go="settings" data-active="true"')
    expect(settingsHtml).toContain('id="settings-saved-notice"')
    expect(settingsHtml).not.toMatch(/style="/i)

    const sessionsHtml = renderOfficialSessionsPage({
      product: 'DSH Community',
      officialHome: '/tmp/.dsh',
      isolated: false,
      sessions: [
        {
          id: 'sess-ux-1',
          projectKey: 'proj',
          updatedAt: '2026-11-14 01:00:00 UTC',
          title: 'UX Check',
        },
      ],
    })
    expect(sessionsHtml).toContain('data-go="sessions" data-active="true"')
    expect(sessionsHtml).toContain('copyWithFeedback')
    expect(sessionsHtml).toContain('id="session-filter-empty"')
    expect(sessionsHtml).toContain('id="session-filter-clear"')
    expect(sessionsHtml).toContain('class="table-actions"')
    expect(sessionsHtml).not.toMatch(/style="/i)

    const diagHtml = renderDiagnosticsPage({
      product: 'DSH Community',
      officialHome: '/tmp/.dsh',
      isolated: false,
      origin: 'http://127.0.0.1:4310',
      phase: 'ready',
      pid: '1234',
      logs: 'ok log',
    })
    expect(diagHtml).toContain('data-go="diagnostics" data-active="true"')
    expect(diagHtml).toContain('copyWithFeedback')
    expect(diagHtml).not.toMatch(/style="/i)

    const remoteErrorHtml = renderRemotePage({
      product: 'DSH Community',
      phase: 'error',
      apiKeyPresent: true,
      dshHome: '/tmp/.dsh',
      configDir: '/tmp/remote',
      isolated: false,
      pid: '—',
      hostFingerprint: 'fp-1234',
      lanCandidates: ['192.168.1.2'],
      effectiveListenHost: '127.0.0.1',
      settings: { listenHost: '', port: 0, enableMdns: true, relayUrl: '', signalingUrl: '', stunUrls: '' },
      error: 'https://very-long-url.example.com/failed',
      relayUrl: '',
      relayRoomId: '',
      signalingUrl: '',
      signalingRoomId: '',
      stunUrls: [],
      activeConnections: 0,
      pairing: {
        deepLink: 'dsh-remote://pair?fp=1',
        pairingJson: '{}',
        qrSvg: '<svg viewBox="0 0 10 10"></svg>',
        expiresAt: Date.now() + 600_000,
      },
      pendingCandidates: [],
      devices: [],
      logs: '',
    })
    expect(remoteErrorHtml).toContain('data-go="remote" data-active="true"')
    expect(remoteErrorHtml).toContain('<pre class="error">https://very-long-url.example.com/failed</pre>')
    expect(remoteErrorHtml).toContain('(UTC')
    expect(remoteErrorHtml).toContain('class="custom-host-input hidden-row"')
    expect(remoteErrorHtml).toContain('copyWithFeedback')
    expect(remoteErrorHtml).not.toMatch(/style="/i)
  })

  it('formats Marketplace fetchedAt in local timezone without raw ISO suffix', () => {
    const html = renderMarketplacePage({
      product: 'DSH Community',
      catalog: undefined,
      source: 'cache',
      fetchedAt: '2026-08-16T01:00:00.000Z',
      registryUrl: 'https://github.com/kamanager2012/dsh-community/blob/main/packages/marketplace/catalog.json',
      installed: [],
      profile: 'web',
    })
    expect(html).toContain('抓取时间 ')
    expect(html).toContain('(UTC')
    expect(html).not.toContain('2026-08-16T01:00:00.000Z')
    expect(html).not.toMatch(/style="/i)

    const emptyTimeHtml = renderMarketplacePage({
      product: 'DSH Community',
      catalog: undefined,
      source: 'none',
      fetchedAt: '',
      registryUrl: 'https://github.com/kamanager2012/dsh-community/blob/main/packages/marketplace/catalog.json',
      installed: [],
      profile: 'web',
    })
    expect(emptyTimeHtml).toContain('抓取时间 —')
  })

  it('paginates Official Sessions over 50 rows while keeping full-list filtering and CSP', () => {
    const makeSessions = (count: number) =>
      Array.from({ length: count }, (_, idx) => ({
        id: `sess-${String(idx + 1).padStart(3, '0')}`,
        projectKey: `proj-${String(idx + 1)}`,
        transcript: `/tmp/.dsh/projects/proj-${String(idx + 1)}/sess-${String(idx + 1).padStart(3, '0')}.jsonl`,
        updatedAt: '2026-11-14 09:00',
        title: `Session ${String(idx + 1)}`,
      }))

    const underCap = renderOfficialSessionsPage({
      product: 'DSH Community',
      officialHome: '/tmp/.dsh',
      isolated: false,
      sessions: makeSessions(50),
    })
    expect(underCap).not.toContain('id="sessions-more-row"')
    expect(underCap).not.toMatch(/<tr data-session-row="[^"]*" class="hidden-row">/)

    const overCap = renderOfficialSessionsPage({
      product: 'DSH Community',
      officialHome: '/tmp/.dsh',
      isolated: false,
      sessions: makeSessions(60),
    })
    expect(overCap).toContain('<h1>官方 Session（60）</h1>')
    expect(overCap).toContain('id="sessions-more-row"')
    expect(overCap).toContain('id="sessions-show-more">显示全部 60 条会话</button>')
    const hiddenRows = overCap.match(/<tr data-session-row="[^"]*" class="hidden-row">/g) ?? []
    expect(hiddenRows).toHaveLength(10)
    expect(overCap).toContain('hiddenByQuery')
    expect(overCap).toContain('hiddenByPage')
    expect(overCap).not.toMatch(/style="/i)

    // Execute the inline page script against a lightweight mock DOM to verify pagination + full-list filter behavior.
    const scripts = [...overCap.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)]
    const pageScript = scripts.find((match) => match[1].includes('applySessionFilter'))?.[1] ?? ''
    expect(pageScript).toContain('applySessionFilter')
    const makeClassList = (initialHidden = false) => {
      const classes = new Set<string>(initialHidden ? ['hidden-row'] : [])
      return {
        toggle: (name: string, force?: boolean) => {
          const shouldAdd = force === undefined ? !classes.has(name) : force
          if (shouldAdd) classes.add(name)
          else classes.delete(name)
          return classes.has(name)
        },
        contains: (name: string) => classes.has(name),
      }
    }
    const makeElement = (initialHidden = false) => {
      const listeners = new Map<string, Array<() => void>>()
      return {
        value: '',
        classList: makeClassList(initialHidden),
        focus: () => undefined,
        getAttribute: () => null,
        addEventListener: (event: string, fn: () => void) => {
          const list = listeners.get(event) ?? []
          list.push(fn)
          listeners.set(event, list)
        },
        dispatch: (event: string) => {
          for (const fn of listeners.get(event) ?? []) fn()
        },
      }
    }
    const rowElements = Array.from({ length: 60 }, (_, idx) => {
      const blob = `sess-${String(idx + 1).padStart(3, '0')} session ${String(idx + 1)} proj-${String(idx + 1)}`
      return {
        ...makeElement(idx >= 50),
        getAttribute: (attr: string) => (attr === 'data-session-row' ? blob : null),
      }
    })
    const elementsById = new Map<string, ReturnType<typeof makeElement>>([
      ['session-filter', makeElement(false)],
      ['sessions-table', makeElement(false)],
      ['session-filter-empty', makeElement(true)],
      ['sessions-more-row', makeElement(false)],
      ['sessions-show-more', makeElement(false)],
      ['session-filter-clear', makeElement(false)],
    ])
    const mockDoc = {
      getElementById: (id: string) => elementsById.get(id) ?? null,
      querySelectorAll: (selector: string) => (selector === 'tr[data-session-row]' ? rowElements : []),
    }
    new Function('document', pageScript)(mockDoc)

    // Searching finds session 59 (>50) even before expanding.
    const filterEl = elementsById.get('session-filter')!
    const moreRowEl = elementsById.get('sessions-more-row')!
    filterEl.value = 'sess-059'
    filterEl.dispatch('input')
    expect(rowElements.filter((row) => !row.classList.contains('hidden-row'))).toHaveLength(1)
    expect(rowElements[58].classList.contains('hidden-row')).toBe(false)
    expect(moreRowEl.classList.contains('hidden-row')).toBe(true)

    // Clearing restores the 50-row initial cap and shows the expand button again.
    elementsById.get('session-filter-clear')!.dispatch('click')
    expect(rowElements.filter((row) => !row.classList.contains('hidden-row'))).toHaveLength(50)
    expect(moreRowEl.classList.contains('hidden-row')).toBe(false)

    // Clicking show more reveals all 60 rows and hides the expand button.
    elementsById.get('sessions-show-more')!.dispatch('click')
    expect(rowElements.filter((row) => !row.classList.contains('hidden-row'))).toHaveLength(60)
    expect(moreRowEl.classList.contains('hidden-row')).toBe(true)
  })

  it('exposes direct About navigation from Runtime and Diagnostics without adding nav tabs', () => {
    const runtimeHtml = renderRuntimePage({
      product: 'DSH Community',
      installed: '0.2.2-rc.2',
      latestTested: '0.2.2-rc.2',
      defaultPin: '0.2.2-rc.2',
      recommendation: 'stay',
      canSwitchToTested: false,
      officialHome: '/tmp/.dsh',
      desktopRoot: '/tmp/.dsh-desktop',
      catalogPath: '/tmp/runtime-pin.json',
      isolated: false,
    })
    expect(runtimeHtml).toContain('<button class="secondary" data-go="about">关于与版本</button>')
    const navMatch = runtimeHtml.match(/<nav class="nav">([\s\S]*?)<\/nav>/)
    expect(navMatch?.[1].match(/<button /g) ?? []).toHaveLength(7)

    const diagHtml = renderDiagnosticsPage({
      product: 'DSH Community',
      officialHome: '/tmp/.dsh',
      isolated: false,
      origin: 'http://127.0.0.1:4310',
      phase: 'ready',
      pid: '1234',
      logs: 'ok',
    })
    expect(diagHtml).toContain('<button class="secondary" data-go="about">关于与版本</button>')
    expect(diagHtml).not.toMatch(/style="/i)
  })

  it('keeps isolated session empty state accurate, styles marketplace errors, and guards empty log copies', () => {
    const isolatedEmpty = renderOfficialSessionsPage({
      product: 'DSH Community',
      officialHome: '/tmp/desk-userData/isolated-dsh',
      isolated: true,
      sessions: [],
    })
    expect(isolatedEmpty).toContain('/tmp/desk-userData/isolated-dsh/sessions')
    expect(isolatedEmpty).toContain('当前隔离目录')
    expect(isolatedEmpty).not.toContain('官方 <code>~/.dsh/sessions</code>')
    expect(isolatedEmpty).not.toMatch(/style="/i)

    const customHomeEmpty = renderOfficialSessionsPage({
      product: 'DSH Community',
      officialHome: '/tmp/custom-dsh-home',
      isolated: false,
      sessions: [],
    })
    expect(customHomeEmpty).toContain('/tmp/custom-dsh-home/sessions')
    expect(customHomeEmpty).not.toContain('~/.dsh/sessions')

    const mktLoading = renderLoadingPage('正在获取社区市场目录…', {
      heading: '社区市场',
      activeNav: 'marketplace',
    })
    expect(mktLoading).toContain('data-go="marketplace" data-active="true"')
    expect(mktLoading).toContain('<h1>社区市场</h1>')
    expect(mktLoading).toContain('正在获取社区市场目录…')
    expect(mktLoading).not.toContain('dsh web')
    expect(mktLoading).not.toMatch(/style="/i)

    const mktFailed = renderMarketplacePage({
      product: 'DSH Community',
      catalog: undefined,
      source: 'none',
      fetchedAt: '',
      registryUrl: 'https://example.com/catalog.json',
      installed: [],
      profile: 'web',
      result: {
        plugin: 'bad-plugin',
        action: 'install',
        ok: false,
        log: 'npm E404',
      },
    })
    expect(mktFailed).toContain('<pre class="error">安装失败：bad-plugin')
    expect(mktFailed).not.toMatch(/style="/i)

    const diagEmpty = renderDiagnosticsPage({
      product: 'DSH Community',
      officialHome: '/tmp/.dsh',
      isolated: false,
      origin: 'http://127.0.0.1:4310',
      phase: 'ready',
      pid: '1234',
      logs: '',
    })
    expect(diagEmpty).toContain('id="copy" disabled title="暂无可复制日志"')

    const diagFilled = renderDiagnosticsPage({
      product: 'DSH Community',
      officialHome: '/tmp/.dsh',
      isolated: false,
      origin: 'http://127.0.0.1:4310',
      phase: 'ready',
      pid: '1234',
      logs: 'host booted',
    })
    expect(diagFilled).toContain('<button class="secondary" id="copy">复制日志</button>')
    expect(diagFilled).not.toContain('id="copy" disabled')

    const remoteEmpty = renderRemotePage({
      product: 'DSH Community',
      phase: 'stopped',
      apiKeyPresent: true,
      dshHome: '/tmp/.dsh',
      configDir: '/tmp/remote',
      isolated: false,
      pid: '—',
      hostFingerprint: 'fp-1',
      lanCandidates: [],
      effectiveListenHost: '127.0.0.1',
      settings: { listenHost: '', port: 0, enableMdns: true, relayUrl: '', signalingUrl: '', stunUrls: '' },
      relayUrl: '',
      relayRoomId: '',
      signalingUrl: '',
      signalingRoomId: '',
      stunUrls: [],
      activeConnections: 0,
      pairing: {
        deepLink: 'dsh-remote://pair?fp=1',
        pairingJson: '{}',
        qrSvg: '<svg viewBox="0 0 10 10"></svg>',
        expiresAt: Date.now() + 600_000,
      },
      pendingCandidates: [],
      devices: [],
      logs: '   ',
    })
    expect(remoteEmpty).toContain('id="copy-remote-logs-btn" disabled title="暂无可复制日志"')
  })

  it('renders multi-agent engine chips, diff buttons, and escaped read-only Git preview under strict CSP', () => {
    const html = renderRemotePage({
      product: 'DSH Community',
      phase: 'running',
      apiKeyPresent: false,
      dshHome: '/tmp/.dsh',
      configDir: '/tmp/remote',
      isolated: false,
      pid: '777',
      hostFingerprint: 'fp-multi',
      lanCandidates: ['192.168.1.9'],
      effectiveListenHost: '192.168.1.9',
      settings: {
        listenHost: '',
        port: 0,
        enableMdns: true,
        relayUrl: '',
        signalingUrl: '',
        stunUrls: '',
        engines: 'codex,claude',
      },
      lanUrl: 'ws://192.168.1.9:9000',
      relayUrl: '',
      relayRoomId: '',
      signalingUrl: '',
      signalingRoomId: '',
      stunUrls: [],
      activeConnections: 1,
      engines: [
        { id: 'codex', displayName: 'Codex CLI', available: true, version: '0.169.0' },
        { id: 'claude', displayName: 'Claude Code', available: false },
      ],
      liveSessions: [
        {
          id: 'codex:s-1',
          engine: 'codex',
          title: 'Multi-Agent Task',
          status: 'running',
          model: 'gpt-5-codex',
        },
      ],
      gitPreview: {
        sessionId: 'codex:s-1',
        repoRoot: '/repo',
        branch: 'feat/</script><img src=x>',
        ahead: 2,
        behind: 0,
        clean: false,
        files: [{ path: 'src/main.ts', indexStatus: ' ', workTreeStatus: 'M', untracked: false }],
        diffPath: 'src/main.ts',
        staged: false,
        diffText: [
          'diff --git a/src/main.ts b/src/main.ts',
          '@@ -1,2 +1,2 @@',
          '-const evil = "old"',
          '+const evil = "</script><img src=x onerror=alert(1)>"',
        ].join('\n'),
        truncated: false,
      },
      pendingCandidates: [],
      devices: [],
      logs: '',
    })
    expect(html).toContain('Codex CLI 0.169.0')
    expect(html).toContain('Claude Code 未就绪')
    expect(html).toContain('Standalone 多引擎模式（无需 DEEPSEEK_API_KEY）')
    expect(html).toContain('data-git-inspect="codex:s-1"')
    expect(html).toContain('data-git-scope="staged"')
    expect(html).toContain('id="copy-remote-diff-btn"')
    expect(html).toContain('class="diff-line diff-file-hdr"')
    expect(html).toContain('class="diff-line diff-hunk"')
    expect(html).toContain('class="diff-line diff-add"')
    expect(html).toContain('class="diff-line diff-del"')
    expect(html).toContain('diff-stat-add">+1</span>')
    expect(html).toContain('diff-stat-del">-1</span>')
    expect(html).toContain('id="remote-engines"')
    expect(html).toContain('value="codex,claude"')
    expect(html).toContain('Git 只读变更审阅')
    expect(html).not.toContain('</script><img')
    expect(html).toContain('&lt;/script&gt;&lt;img src=x&gt;')
    expect(html).not.toMatch(/style="/i)
  })

  it('groups live sessions by commonRepoRoot with worktree badges, git summary chips, and escaped paths', () => {
    const html = renderRemotePage({
      product: 'DSH Community',
      phase: 'running',
      apiKeyPresent: true,
      dshHome: '/tmp/.dsh',
      configDir: '/tmp/remote',
      isolated: false,
      pid: '888',
      hostFingerprint: 'fp-wt',
      lanCandidates: ['192.168.1.9'],
      effectiveListenHost: '192.168.1.9',
      settings: {
        listenHost: '',
        port: 0,
        enableMdns: true,
        relayUrl: '',
        signalingUrl: '',
        stunUrls: '',
        engines: 'dsh,codex,claude',
      },
      lanUrl: 'ws://192.168.1.9:9000',
      relayUrl: '',
      relayRoomId: '',
      signalingUrl: '',
      signalingRoomId: '',
      stunUrls: [],
      activeConnections: 1,
      liveSessions: [
        {
          id: 'codex:wt-a',
          engine: 'codex',
          title: 'Feature Auth',
          status: 'running',
          updatedAtMs: 2000,
          cwd: '/repos/app-wt-auth',
          pendingApprovals: 1,
          workspace: {
            repoRoot: '/repos/app-wt-auth',
            commonRepoRoot: '/repos/app',
            worktreeName: 'app-wt-auth',
            isWorktree: true,
            branch: 'feat/auth',
            dirty: true,
            changedFiles: 3,
            ahead: 2,
            behind: 1,
          },
        },
        {
          id: 'claude:main',
          engine: 'claude',
          title: 'Main Repo Review',
          status: 'idle',
          updatedAtMs: 1000,
          cwd: '/repos/app',
          workspace: {
            repoRoot: '/repos/app',
            commonRepoRoot: '/repos/app',
            isWorktree: false,
            branch: 'main',
            dirty: false,
            changedFiles: 0,
          },
        },
        {
          id: 'dsh:other',
          engine: 'dsh',
          title: 'Scratch Dir',
          status: 'idle',
          updatedAtMs: 500,
          cwd: '/tmp/<script>alert(1)</script>',
        },
      ],
      pendingCandidates: [],
      devices: [],
      logs: '',
    })

    expect(html).toContain('活跃与可接入会话 · Worktree 看板（3）')
    expect(html).toContain('工作区组数 <strong>2</strong>')
    expect(html).toContain('运行中 <strong>1</strong>')
    expect(html).toContain('待处理 <strong>1</strong>')
    expect(html).toContain('脏工作区 <strong>1</strong>')
    expect(html).toContain('2 worktrees')
    expect(html).toContain('Worktree · app-wt-auth')
    expect(html).toContain('feat/auth')
    expect(html).toContain('已改 3 项')
    expect(html).toContain('↑2')
    expect(html).toContain('↓1')
    expect(html).toContain('干净')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('sanitizes session workspace summaries defensively', () => {
    expect(parseSessionWorkspaceSummary(null)).toBeUndefined()
    expect(parseSessionWorkspaceSummary({})).toBeUndefined()
    expect(parseSessionWorkspaceSummary({
      repoRoot: '/repo-wt',
      commonRepoRoot: '/repo',
      worktreeName: '',
      isWorktree: true,
      branch: 'feat/x',
      dirty: true,
      changedFiles: -1,
      ahead: 2,
      behind: Number.NaN,
    })).toEqual({
      repoRoot: '/repo-wt',
      commonRepoRoot: '/repo',
      isWorktree: true,
      branch: 'feat/x',
      dirty: true,
      ahead: 2,
    })
  })

  it('renders envDefaults placeholders, R3 stun guidance, and CSP-safe fill button when configured', () => {
    const html = renderRemotePage({
      product: 'DSH Community',
      phase: 'stopped',
      apiKeyPresent: true,
      dshHome: '/tmp/.dsh',
      configDir: '/tmp/remote',
      isolated: false,
      pid: '—',
      hostFingerprint: 'fp-env',
      lanCandidates: [],
      effectiveListenHost: '127.0.0.1',
      settings: { listenHost: '', port: 0, enableMdns: true, relayUrl: '', signalingUrl: '', stunUrls: '' },
      envDefaults: {
        relayUrl: 'wss://relay.example.com/ws',
        signalingUrl: 'wss://signal.example.com/"<script>alert(1)</script>',
        stunUrls: 'stun:stun.example.com:3478',
      },
      lanUrl: '',
      relayUrl: '',
      relayRoomId: '',
      signalingUrl: '',
      signalingRoomId: '',
      stunUrls: [],
      activeConnections: 0,
      pendingCandidates: [],
      devices: [],
      logs: '',
    })
    expect(html).toContain('默认环境变量: wss://relay.example.com/ws')
    expect(html).toContain('默认环境变量: stun:stun.example.com:3478')
    expect(html).toContain('id="fill-remote-env-defaults"')
    expect(html).toContain('id="remote-env-defaults-tpl"')
    expect(html).toContain('禁止 <code>turn:</code>')
    expect(html).not.toContain('onclick=')
    expect(html).not.toContain('style=')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})
