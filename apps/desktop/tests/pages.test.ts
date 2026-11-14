import { describe, expect, it } from 'vitest'
import {
  renderAboutPage,
  renderDiagnosticsPage,
  renderErrorPage,
  renderLoadingPage,
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
})
