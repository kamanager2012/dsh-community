import { randomBytes } from 'node:crypto'
import { COMMUNITY_PRODUCT_NAME } from './branding.ts'
import {
  PLUGIN_CATEGORIES,
  PLUGIN_CATEGORY_LABELS,
  type MarketplaceCatalog,
  type MarketplaceSource,
  type PluginAction,
} from './marketplace.ts'
import type {
  DesktopLiveSessionView,
  DesktopRemotePhase,
  DesktopRemoteSnapshot,
} from './remote.ts'

export interface AboutPageModel {
  readonly product: string
  readonly identity: string
  readonly officialPackage: string
  readonly officialVersion: string
  readonly officialBin: string
  readonly officialHome: string
  readonly desktopRoot: string
  readonly isolated: boolean
  readonly latestTested: string
  readonly officialSessionCount: number
  readonly origin: string
  readonly phase: string
  readonly pid: string
  readonly logs: string
}

export interface OfficialSessionRow {
  readonly id: string
  readonly projectKey: string
  readonly transcript: string
  readonly updatedAt: string
  readonly title?: string | undefined
  readonly cwd?: string | undefined
  readonly preview?: string | undefined
  readonly model?: string | undefined
}

export interface OfficialSessionsPageModel {
  readonly product: string
  readonly officialHome: string
  readonly isolated: boolean
  readonly sessions: readonly OfficialSessionRow[]
}

export interface RuntimePageModel {
  readonly product: string
  readonly installed: string
  readonly latestTested: string
  readonly defaultPin: string
  readonly recommendation: 'stay' | 'offer-tested'
  readonly canSwitchToTested: boolean
  readonly officialHome: string
  readonly desktopRoot: string
  readonly catalogPath: string
  readonly isolated: boolean
}

export interface SettingsPageModel {
  readonly product: string
  readonly hideToTray: boolean
  readonly trayAvailable?: boolean
  readonly isolated: boolean
  readonly envIsolated: boolean
  readonly officialHome: string
  readonly isolatedHome: string
  readonly saved?: boolean
}

export interface DiagnosticsPageModel {
  readonly product: string
  readonly officialHome: string
  readonly isolated: boolean
  readonly origin: string
  readonly phase: string
  readonly pid: string
  readonly logs: string
}

export interface MarketplacePageModel {
  readonly product: string
  readonly catalog?: MarketplaceCatalog
  readonly source: MarketplaceSource
  readonly fetchedAt: string
  readonly error?: string
  readonly registryUrl: string
  readonly installed: readonly string[]
  readonly profile: string
  readonly busy?: { readonly plugin: string; readonly action: PluginAction }
  readonly result?: {
    readonly plugin: string
    readonly action: PluginAction
    readonly ok: boolean
    readonly log: string
  }
}

export type RemotePageModel = DesktopRemoteSnapshot & {
  readonly product: string
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function createCspNonce(): string {
  return randomBytes(16).toString('base64')
}

export type ShellNavId = 'official' | 'remote' | 'sessions' | 'marketplace' | 'runtime' | 'settings' | 'diagnostics'

const COPY_FEEDBACK_JS = `function copyWithFeedback(btn, text) {
  if (!btn) return;
  if (!btn.dataset.copyLabel) btn.dataset.copyLabel = btn.textContent || '复制';
  if (!text) {
    var emptyPrev = Number(btn.dataset.copyTimer || 0);
    if (emptyPrev) window.clearTimeout(emptyPrev);
    btn.textContent = '暂无内容';
    btn.dataset.copyTimer = String(window.setTimeout(function () {
      btn.textContent = btn.dataset.copyLabel || '复制';
      delete btn.dataset.copyTimer;
    }, 1800));
    return;
  }
  var runner = window.dshCommunity && window.dshCommunity.copyText
    ? Promise.resolve(window.dshCommunity.copyText(text)).then(function (ok) {
        if (ok === false) throw new Error('copy rejected');
      })
    : Promise.reject(new Error('copyText unavailable'));
  runner.then(
    function () {
      var prev = Number(btn.dataset.copyTimer || 0);
      if (prev) window.clearTimeout(prev);
      btn.textContent = '已复制 ✓';
      btn.dataset.copied = 'true';
      btn.dataset.copyTimer = String(window.setTimeout(function () {
        btn.textContent = btn.dataset.copyLabel || '复制';
        delete btn.dataset.copied;
        delete btn.dataset.copyTimer;
      }, 1800));
    },
    function () {
      var prev = Number(btn.dataset.copyTimer || 0);
      if (prev) window.clearTimeout(prev);
      btn.textContent = '复制失败';
      btn.dataset.copyTimer = String(window.setTimeout(function () {
        btn.textContent = btn.dataset.copyLabel || '复制';
        delete btn.dataset.copyTimer;
      }, 1800));
    }
  );
}`

function shellDocument(
  title: string,
  bodyOrRender: string | ((nonce: string) => string),
  activeNav?: ShellNavId,
): string {
  const nonce = createCspNonce()
  const body = typeof bodyOrRender === 'function' ? bodyOrRender(nonce) : bodyOrRender
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "img-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <title>${escapeHtml(title)}</title>
    <style nonce="${nonce}">
      :root { color-scheme: dark; }
      html, body { height: 100%; margin: 0; background: #101218; color: #d9dee8;
        font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
      main { min-height: 100%; display: flex; flex-direction: column; align-items: center;
        justify-content: flex-start; padding: 28px 24px 40px; box-sizing: border-box; }
      .card { width: 100%; max-width: 44rem; box-sizing: border-box; }
      h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 0.6rem; }
      p, li { color: #9aa3b2; }
      code, pre { font: 12px/1.45 ui-monospace, SFMono-Regular, monospace; }
      pre { max-height: 14rem; overflow: auto; background: #0b0d12; padding: 12px; border-radius: 8px;
        white-space: pre-wrap; overflow-wrap: anywhere; }
      button { appearance: none; border: 0; border-radius: 8px; padding: 8px 14px;
        background: #2f6fed; color: white; font: inherit; cursor: pointer; }
      button.secondary { background: #2a303b; }
      button.small { padding: 4px 10px; font-size: 13px; }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
      button[data-copied="true"] { background: #1f6f4a; color: #ffffff; }
      pre.ok { background: #0b1a12; border: 1px solid #1d4a2c; }
      pre.error { background: #1c0c0e; border: 1px solid #7a2929; color: #ffb4b4; }
      .chip.ok { color: #7ee2a8; border-color: #2f6fed; }
      .chip.risk-med { color: #f5c26b; border-color: #7c5816; }
      .chip.risk-high { color: #ff8e8e; border-color: #7a2929; background: #1c0c0e; }
      .row { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
      nav.nav { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 18px; }
      nav.nav button { font-size: 13px; padding: 6px 10px; }
      nav.nav button[data-active="true"] { background: #2f6fed; color: #ffffff; }
      label.opt { display: flex; gap: 8px; align-items: flex-start; margin: 10px 0; color: #d9dee8; }
      label.opt input { margin-top: 4px; }
      dt { color: #6d7686; font-size: 12px; }
      dd { margin: 0 0 10px; overflow-wrap: anywhere; }
      table { width: 100%; border-collapse: collapse; margin: 12px 0 4px; font: 12px/1.45 ui-monospace, SFMono-Regular, monospace; }
      th, td { text-align: left; padding: 8px 10px 8px 0; border-bottom: 1px solid #2a303b;
        overflow-wrap: anywhere; vertical-align: middle; }
      th { color: #6d7686; font-weight: 500; white-space: nowrap; }
      td button { white-space: nowrap; }
      .nowrap { white-space: nowrap; word-break: normal; }
      .break-any { overflow-wrap: anywhere; word-break: normal; }
      .empty-filter { margin-top: 12px; padding: 14px; border: 1px dashed #2a303b; border-radius: 8px;
        color: #9aa3b2; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      h2 { font-size: 1.05rem; font-weight: 600; color: #c6cdd9; margin: 20px 0 8px; }
      ul.plugins { list-style: none; margin: 0; padding: 0; }
      ul.plugins li { border: 1px solid #2a303b; border-radius: 8px; padding: 12px; margin: 0 0 10px; }
      .plugin-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
      .plugin-name { font-weight: 600; color: #d9dee8; }
      .author { color: #6d7686; font-size: 12px; }
      .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 4px; }
      .chip { font: 11px/1.4 ui-monospace, SFMono-Regular, monospace; background: #0b0d12;
        border: 1px solid #2a303b; border-radius: 999px; padding: 2px 10px; color: #9aa3b2; }
      .plugin-actions { display: flex; align-items: center; gap: 12px; margin-top: 6px; flex-wrap: wrap; }
      a { color: #6ea8fe; }
      .meta { color: #6d7686; font-size: 12px; }
      button.danger { background: #8f2626; }
      .panel { border: 1px solid #2a303b; border-radius: 8px; padding: 14px; margin: 14px 0; background: #141822; }
      .panel.pending { border-color: #2f6fed; background: #0e172a; }
      .panel.warn { border-color: #7c5816; background: #1d170c; color: #f5c26b; }
      .panel.warn p { color: #f5c26b; margin: 0; }
      .pair-grid { display: flex; gap: 18px; align-items: flex-start; flex-wrap: wrap; margin-top: 10px; }
      .qr-wrap { background: #ffffff; border-radius: 10px; padding: 10px; width: 220px; height: 220px;
        flex: 0 0 auto; box-sizing: border-box; display: flex; align-items: center; justify-content: center; }
      .qr-wrap svg { width: 100%; height: 100%; display: block; }
      .pair-info { flex: 1 1 240px; min-width: 0; }
      .field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
      .field label { display: block; color: #9aa3b2; font-size: 12px; margin-bottom: 4px; }
      .field input[type="text"], .field input[type="number"], .field select, input[type="search"] {
        width: 100%; box-sizing: border-box; background: #0b0d12; color: #d9dee8;
        border: 1px solid #2a303b; border-radius: 6px; padding: 7px 10px;
        font: 12px/1.4 ui-monospace, SFMono-Regular, monospace;
      }
      input:disabled, select:disabled { opacity: 0.45; cursor: not-allowed; }
      .hidden-row { display: none; }
      .session-sub { color: #9ea6b3; font-size: 12px; margin-top: 2px; font-family: system-ui, sans-serif; }
      .custom-host-input { margin-top: 6px; }
      .pending-item { border: 1px solid #2f6fed; border-radius: 8px; padding: 12px; margin-top: 10px; background: #0b1120; }
      .status-line { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0; }
      .diff-viewer { max-height: 24rem; overflow: auto; background: #0b0d12; border: 1px solid #2a303b;
        border-radius: 8px; padding: 8px 0; font: 12px/1.45 ui-monospace, SFMono-Regular, monospace; }
      .diff-line { display: block; padding: 1px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
      .diff-file-hdr { background: #131c2b; color: #79c0ff; font-weight: 600; }
      .diff-hunk { background: #1a162d; color: #d2a8ff; }
      .diff-add { background: #0f291a; color: #7ee787; }
      .diff-del { background: #2e1215; color: #ffa198; }
      .diff-ctx { color: #b8c0cc; }
      .chip.diff-stat-add { color: #7ee787; border-color: #1f6f4a; background: #0b1a12; }
      .chip.diff-stat-del { color: #ffa198; border-color: #7a2929; background: #1c0c0e; }
      .worktree-metrics { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 12px; }
      .metric-pill { font: 12px/1.4 ui-monospace, SFMono-Regular, monospace; background: #0b0d12;
        border: 1px solid #2a303b; border-radius: 8px; padding: 4px 10px; color: #9aa3b2; }
      .metric-pill strong { color: #d9dee8; }
      .metric-pill.ok { border-color: #2f6fed; color: #7ee2a8; }
      .metric-pill.risk-med { border-color: #7c5816; color: #f5c26b; }
      .worktree-group { border: 1px solid #2a303b; border-radius: 8px; padding: 10px 12px;
        margin-top: 10px; background: #0e121b; }
      .worktree-group-hdr { display: flex; align-items: baseline; justify-content: space-between;
        gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
      .worktree-group table { margin: 4px 0 0; }
      .worktree-group tr:last-child td { border-bottom: 0; }
    </style>
  </head>
  <body>
    <main><div class="card">
      <nav class="nav">
        <button class="secondary" data-go="official"${activeNav === 'official' ? ' data-active="true"' : ''}>官方 Web</button>
        <button class="secondary" data-go="sessions"${activeNav === 'sessions' ? ' data-active="true"' : ''}>Session</button>
        <button class="secondary" data-go="remote"${activeNav === 'remote' ? ' data-active="true"' : ''}>远程</button>
        <button class="secondary" data-go="marketplace"${activeNav === 'marketplace' ? ' data-active="true"' : ''}>市场</button>
        <button class="secondary" data-go="runtime"${activeNav === 'runtime' ? ' data-active="true"' : ''}>运行时</button>
        <button class="secondary" data-go="settings"${activeNav === 'settings' ? ' data-active="true"' : ''}>设置</button>
        <button class="secondary" data-go="diagnostics"${activeNav === 'diagnostics' ? ' data-active="true"' : ''}>诊断</button>
      </nav>
      ${body}
    </div></main>
    <script nonce="${nonce}">
      const go = {
        official: () => window.dshCommunity?.openOfficial(),
        sessions: () => window.dshCommunity?.showSessions(),
        remote: () => window.dshCommunity?.showRemote(),
        marketplace: () => window.dshCommunity?.showMarketplace(),
        runtime: () => window.dshCommunity?.showRuntime(),
        settings: () => window.dshCommunity?.showSettings(),
        diagnostics: () => window.dshCommunity?.showDiagnostics(),
        about: () => window.dshCommunity?.showAbout(),
      }
      document.querySelectorAll('[data-go]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const key = btn.getAttribute('data-go')
          if (key && key in go) go[key]()
        })
      })
    </script>
  </body>
</html>`
}

function copyDisabledAttrs(text: string): string {
  return text.trim().length > 0 ? '' : ' disabled title="暂无可复制日志"'
}

export interface LoadingPageOptions {
  readonly heading?: string
  readonly activeNav?: ShellNavId
}

export function renderLoadingPage(detail?: string, options?: LoadingPageOptions): string {
  const heading = options?.heading ?? COMMUNITY_PRODUCT_NAME
  const lead = options?.heading
    ? ''
    : '<p>正在启动官方 <code>dsh web</code>。本窗口只做壳，不跑第二套 agent loop。</p>'
  const extra = detail === undefined || detail.length === 0
    ? ''
    : `<p>${escapeHtml(detail)}</p>`
  return shellDocument(
    heading,
    `<h1>${escapeHtml(heading)}</h1>
     ${lead}${extra}`,
    options?.activeNav,
  )
}

export function renderErrorPage(message: string): string {
  return shellDocument(
    `${COMMUNITY_PRODUCT_NAME} · 官方运行时`,
    (nonce) => `<h1>官方运行时没有就绪</h1>
     <p>这是社区壳。失败发生在已发布的 <code>@deepseek-ai/dsh</code> 子进程，而不是本仓的 harness 拷贝。</p>
     <pre class="error">${escapeHtml(message)}</pre>
     <div class="row">
       <button id="retry">重新启动官方运行时</button>
     </div>
     <script nonce="${nonce}">
       document.getElementById('retry')?.addEventListener('click', () => {
         window.dshCommunity?.restartHost()
       })
     </script>`,
  )
}

export function renderAboutPage(model: AboutPageModel): string {
  return shellDocument(
    `${model.product} · 关于`,
    (nonce) => `<h1>${escapeHtml(model.identity)}</h1>
     <p>社区重构的桌面壳：子进程拉起官方 Harness，窗口只加载 loopback。默认共用官方 <code>~/.dsh</code>，和 TUI / Web 是同一批 Session。stdout 只当日志。</p>
     <dl>
       <dt>官方包</dt><dd><code>${escapeHtml(model.officialPackage)}@${escapeHtml(model.officialVersion)}</code></dd>
       <dt>契约 latest-tested</dt><dd><code>${escapeHtml(model.latestTested)}</code></dd>
       <dt>官方 bin</dt><dd><code>${escapeHtml(model.officialBin)}</code></dd>
       <dt>官方数据</dt><dd><code>${escapeHtml(model.officialHome)}</code>${model.isolated ? '（隔离）' : ''} · ${String(model.officialSessionCount)} sessions</dd>
       <dt>Desktop 数据</dt><dd><code>${escapeHtml(model.desktopRoot)}</code></dd>
       <dt>就绪 origin</dt><dd><code>${escapeHtml(model.origin || '—')}</code></dd>
       <dt>Host</dt><dd>${escapeHtml(model.phase)} · pid ${escapeHtml(model.pid)}</dd>
     </dl>
     <pre>${escapeHtml(model.logs || '(no host log yet)')}</pre>
     <div class="row">
       <button id="retry">重新启动官方运行时</button>
       <button class="secondary" data-go="official">返回会话</button>
     </div>
     <script nonce="${nonce}">
       document.getElementById('retry')?.addEventListener('click', () => {
         window.dshCommunity?.restartHost()
       })
     </script>`,
  )
}

const SESSIONS_PAGE_SIZE = 50

export function renderOfficialSessionsPage(model: OfficialSessionsPageModel): string {
  const searchBar = model.sessions.length === 0
    ? ''
    : '<div class="field"><input id="session-filter" type="search" placeholder="搜索会话 ID / 标题 / 摘要 / 目录…" /></div>'
  const hasMoreSessions = model.sessions.length > SESSIONS_PAGE_SIZE
  const usesDefaultHome = !model.isolated && /[/\\]\.dsh$/u.test(model.officialHome)
  const sessionsDirLabel = usesDefaultHome ? '~/.dsh/sessions' : `${model.officialHome}/sessions`
  const emptySessionsCopy = model.isolated
    ? `当前隔离目录 <code>${escapeHtml(sessionsDirLabel)}</code> 里还没有 session。隔离模式不会读取或写入默认 <code>~/.dsh</code>，在本窗口创建的会话会保存在该目录下。`
    : `官方 <code>${escapeHtml(sessionsDirLabel)}</code> 里还没有 session。TUI / Web / 本窗口共用这一份，不会另建目录。`
  const tableHtml = model.sessions.length === 0
    ? `<p>${emptySessionsCopy}</p>`
    : `<table id="sessions-table">
         <thead><tr><th>会话与摘要</th><th>项目 / 目录</th><th class="nowrap">更新时间</th><th class="nowrap">操作</th></tr></thead>
         <tbody>${model.sessions.map((session, idx) => {
           const searchBlob = [session.id, session.title ?? '', session.preview ?? '', session.cwd ?? '', session.projectKey, session.model ?? ''].join(' ').toLowerCase()
           const titleLine = session.title
             ? `<div><strong>${escapeHtml(session.title)}</strong>${session.model ? ` <span class="chip">${escapeHtml(session.model)}</span>` : ''}</div>`
             : ''
           const previewLine = session.preview
             ? `<div class="session-sub">${escapeHtml(session.preview)}</div>`
             : ''
           const projectDisplay = session.cwd ? `${session.cwd} (${session.projectKey})` : session.projectKey
           const rowClass = idx >= SESSIONS_PAGE_SIZE ? ' class="hidden-row"' : ''
           return `<tr data-session-row="${escapeHtml(searchBlob)}"${rowClass}>
              <td class="break-any">${titleLine}<code>${escapeHtml(session.id)}</code>${previewLine}</td>
              <td class="break-any"><code>${escapeHtml(projectDisplay)}</code></td>
              <td class="nowrap">${escapeHtml(session.updatedAt)}</td>
              <td class="nowrap">
                <div class="table-actions">
                  <button class="secondary small" data-resume="${escapeHtml(session.id)}">复制 --resume</button>
                  <button class="secondary small" data-copy-id="${escapeHtml(session.id)}">复制 ID</button>
                </div>
              </td>
            </tr>`
         }).join('')}</tbody>
       </table>${hasMoreSessions ? `
       <div id="sessions-more-row" class="row">
         <button type="button" class="secondary small" id="sessions-show-more">显示全部 ${String(model.sessions.length)} 条会话</button>
       </div>` : ''}
       <div id="session-filter-empty" class="empty-filter hidden-row">
         <span>没有匹配当前搜索条件的对话。</span>
         <button type="button" class="secondary small" id="session-filter-clear">清空筛选</button>
       </div>`
  return shellDocument(
    `${model.product} · 官方 Session`,
    (nonce) => `<h1>官方 Session（${String(model.sessions.length)}）</h1>
     <p>只读列出官方 <code>${escapeHtml(model.officialHome)}</code>${model.isolated ? '（隔离）' : ''} 下的 <code>sessions/</code>。恢复对话走官方 Web 或 <code>dsh-community-tui --resume &lt;id&gt;</code>。本页不另建 session 目录。</p>
     ${searchBar}
     ${tableHtml}
     <div class="row">
       <button data-go="official">打开官方 Web</button>
       <button class="secondary" data-go="sessions">刷新列表</button>
     </div>
     <script nonce="${nonce}">
       ${COPY_FEEDBACK_JS}
       document.querySelectorAll('[data-resume]').forEach((btn) => {
         btn.addEventListener('click', () => {
           const id = btn.getAttribute('data-resume')
           if (id) copyWithFeedback(btn, 'dsh-community-tui --resume ' + id)
         })
       })
       document.querySelectorAll('[data-copy-id]').forEach((btn) => {
         btn.addEventListener('click', () => {
           const id = btn.getAttribute('data-copy-id')
           if (id) copyWithFeedback(btn, id)
         })
       })
       const pageSize = ${String(SESSIONS_PAGE_SIZE)}
       let sessionsExpanded = false
       const filterInput = document.getElementById('session-filter')
       const sessionsTable = document.getElementById('sessions-table')
       const emptyFilter = document.getElementById('session-filter-empty')
       const moreRow = document.getElementById('sessions-more-row')
       const showMoreBtn = document.getElementById('sessions-show-more')
       const applySessionFilter = () => {
         const q = (filterInput?.value ?? '').trim().toLowerCase()
         const allRows = document.querySelectorAll('tr[data-session-row]')
         let visible = 0
         allRows.forEach((tr, idx) => {
           const blob = tr.getAttribute('data-session-row') ?? ''
           const hiddenByQuery = q.length > 0 && !blob.includes(q)
           const hiddenByPage = q.length === 0 && !sessionsExpanded && idx >= pageSize
           const hidden = hiddenByQuery || hiddenByPage
           tr.classList.toggle('hidden-row', hidden)
           if (!hidden) visible += 1
         })
         const noMatch = allRows.length > 0 && visible === 0
         sessionsTable?.classList.toggle('hidden-row', noMatch)
         emptyFilter?.classList.toggle('hidden-row', !noMatch)
         moreRow?.classList.toggle('hidden-row', q.length > 0 || sessionsExpanded || allRows.length <= pageSize)
       }
       filterInput?.addEventListener('input', applySessionFilter)
       showMoreBtn?.addEventListener('click', () => {
         sessionsExpanded = true
         applySessionFilter()
       })
       document.getElementById('session-filter-clear')?.addEventListener('click', () => {
         if (!filterInput) return
         filterInput.value = ''
         applySessionFilter()
         filterInput.focus()
       })
     </script>`,
    'sessions',
  )
}

export function renderRuntimePage(model: RuntimePageModel): string {
  const rec = model.recommendation === 'stay'
    ? '当前安装就是契约 latest-tested，不必追 npm latest；这不代表 GitHub Published Latest。'
    : model.canSwitchToTested
      ? '契约已验证更新的版本，可从菜单钉住 latest-tested。'
      : '契约 latest-tested 与当前安装不同，但本仓还只暂存一个官方包；先升 pin 并跑 contract CI，不要从 stdout 猜兼容性。'
  return shellDocument(
    `${model.product} · 运行时`,
    `<h1>Version Manager</h1>
     <p>这是 Desktop 兼容性能力：<code>latest-tested</code> 只表示契约验证推荐，不是 Candidate Source pin、npm latest 或 GitHub Published Latest。不实现第二套 runtime。</p>
     <dl>
       <dt>已安装官方包</dt><dd><code>@deepseek-ai/dsh@${escapeHtml(model.installed)}</code></dd>
       <dt>latest-tested</dt><dd><code>${escapeHtml(model.latestTested)}</code></dd>
       <dt>Desktop default pin</dt><dd><code>${escapeHtml(model.defaultPin)}</code></dd>
       <dt>官方数据（Session 真源）</dt><dd><code>${escapeHtml(model.officialHome)}</code>${model.isolated ? '（隔离）' : ''}</dd>
       <dt>Desktop 数据</dt><dd><code>${escapeHtml(model.desktopRoot)}</code></dd>
       <dt>pin 文件</dt><dd><code>${escapeHtml(model.catalogPath)}</code></dd>
     </dl>
     <p>${escapeHtml(rec)}</p>
     <div class="row">
       <button class="secondary" data-go="official">返回会话</button>
       <button class="secondary" data-go="about">关于与版本</button>
     </div>`,
    'runtime',
  )
}

export function renderSettingsPage(model: SettingsPageModel): string {
  const savedBanner = model.saved === true
    ? '<pre class="ok" id="settings-saved-notice">已保存桌面设置。</pre>'
    : ''
  const trayNotice = model.hideToTray && model.trayAvailable === false
    ? '<pre class="error" id="settings-tray-unavailable">当前桌面环境未提供可用系统托盘（Tray），关闭窗口时无法驻留托盘，会直接退出应用。</pre>'
    : ''
  return shellDocument(
    `${model.product} · 设置`,
    (nonce) => `<h1>Desktop 设置</h1>
     <p>只改壳自己的偏好。官方 session 仍在 <code>${escapeHtml(model.officialHome)}</code>${model.isolated ? '（独立数据目录）' : ''}。</p>
     ${savedBanner}${trayNotice}
     <label class="opt">
       <input type="checkbox" id="hideToTray" ${model.hideToTray ? 'checked' : ''} />
       <span>关窗藏到托盘，官方 <code>dsh web</code> 继续跑</span>
     </label>
     <label class="opt">
       <input type="checkbox" id="isolated" ${model.isolated ? 'checked' : ''} ${model.envIsolated ? 'disabled' : ''} />
       <span>独立数据目录：数据重定向到 <code>${escapeHtml(model.isolatedHome)}</code>（非加密沙箱，仅独立存储会话，不再共用 <code>~/.dsh</code>）</span>
     </label>
     <p>${model.envIsolated
       ? '环境变量 <code>DSH_COMMUNITY_ISOLATED=1</code> 已强制启用独立数据目录，界面关不掉。'
       : '默认建议关闭（非加密沙箱）。开启后仅将会话与配置独立存放在专用目录，不与 TUI / 官方 Web 共用；这并非沙箱安全隔离或加密，子进程仍拥有相同系统权限。改这项会重启官方 <code>dsh web</code>。'}</p>
     <div class="row">
       <button id="save">保存</button>
       <button class="secondary" data-go="official">返回会话</button>
     </div>
     <script nonce="${nonce}">
       document.getElementById('save')?.addEventListener('click', () => {
         window.dshCommunity?.applySettings({
           hideToTray: document.getElementById('hideToTray')?.checked === true,
           isolated: ${model.envIsolated ? 'true' : 'document.getElementById(\'isolated\')?.checked === true'},
         })
       })
     </script>`,
    'settings',
  )
}

export function renderMarketplacePage(model: MarketplacePageModel): string {
  const sourceLine = model.source === 'live'
    ? '实时目录'
    : model.source === 'cache'
      ? '缓存目录（网络不可用，展示最近一次抓取）'
      : '目录不可用'
  const errorBlock = model.error === undefined
    ? ''
    : `<pre class="error">${escapeHtml(model.error)}</pre>`
  const busy = model.busy
  const busyBlock = busy === undefined
    ? ''
    : `<pre>正在${busy.action === 'install' ? '安装' : '卸载'} ${escapeHtml(busy.plugin)}（官方 dsh plugin 在跑，可能需要一分钟）…</pre>`
  const result = model.result
  const resultBlock = result === undefined
    ? ''
    : result.ok
      ? `<pre class="ok">${result.action === 'install' ? '安装' : '卸载'}完成：${escapeHtml(result.plugin)}。重启官方运行时后生效。</pre>
         <div class="row">
           <button id="restart">重启官方运行时</button>
         </div>`
      : `<pre class="error">${result.action === 'install' ? '安装' : '卸载'}失败：${escapeHtml(result.plugin)}\n\n${escapeHtml(result.log)}</pre>`
  const plugins = model.catalog?.plugins ?? []
  const installedSet = new Set(model.installed)
  const disabled = busy === undefined ? '' : ' disabled'
  const sections = PLUGIN_CATEGORIES.map((category) => {
    const members = plugins.filter((plugin) => plugin.category === category)
    if (members.length === 0) return ''
    const rows = members.map((plugin) => {
      const installed = installedSet.has(plugin.name)
      const latestSecurity = plugin.versions[plugin.versions.length - 1]?.security
      const riskBadge = latestSecurity === undefined
        ? ''
        : latestSecurity.risk === 'high'
          ? '<span class="chip risk-high">高风险</span>'
          : latestSecurity.risk === 'medium'
            ? '<span class="chip risk-med">中风险</span>'
            : '<span class="chip">低风险</span>'
      const securityNote = latestSecurity === undefined
        ? ''
        : `<p class="meta">安全说明（${escapeHtml(latestSecurity.manualReviewStatus)} · ${escapeHtml(latestSecurity.lastReviewedAt)}）：${escapeHtml(latestSecurity.manualReviewNote)}</p>`
      const chips = plugin.versions.map((version) => {
        const note = version.notes === undefined ? '' : ` · ${escapeHtml(version.notes)}`
        return `<span class="chip">v${escapeHtml(version.version)} · 验证线 ${escapeHtml(version.testedDsh)}${note}</span>`
      }).join('')
      const needsConfirm = !installed
        && latestSecurity !== undefined
        && (latestSecurity.requiresConfirmation || latestSecurity.risk !== 'low')
      const confirmAttrs = needsConfirm
        ? ` data-plugin-confirm="true" data-plugin-risk="${escapeHtml(latestSecurity.risk)}"`
        : ''
      const actionButton = installed
        ? `<button class="secondary small${disabled}" data-plugin-action="remove" data-plugin-name="${escapeHtml(plugin.name)}">卸载</button>`
        : `<button class="small${disabled}" data-plugin-action="install" data-plugin-name="${escapeHtml(plugin.name)}"${confirmAttrs}>安装到 web profile</button>`
      return `<li>
        <div class="plugin-head">
          <code class="plugin-name">${escapeHtml(plugin.name)}</code>
          <span class="author">by ${escapeHtml(plugin.author)}</span>
          ${riskBadge}
          ${installed ? '<span class="chip ok">已装</span>' : ''}
        </div>
        <p>${escapeHtml(plugin.description)}</p>
        ${securityNote}
        <div class="chips">${chips}</div>
        <div class="plugin-actions">
          <a href="${escapeHtml(plugin.repo)}">源码仓库</a>
          <code>dsh plugin add ${escapeHtml(plugin.name)}</code>
          ${actionButton}
        </div>
      </li>`
    }).join('')
    return `<h2>${PLUGIN_CATEGORY_LABELS[category]} · ${String(members.length)}</h2>
     <ul class="plugins">${rows}</ul>`
  }).join('')
  const body = plugins.length === 0
    ? `<p>目录还没有内容，或抓取的 <code>catalog.json</code> 无法通过校验。</p>`
    : sections
  return shellDocument(
    `${model.product} · 社区市场`,
    (nonce) => `<h1>社区市场</h1>
     <p>浏览 <a href="${escapeHtml(model.registryUrl)}">插件目录 catalog.json</a>。安装/卸载按钮唤起官方 <code>dsh plugin --profile ${escapeHtml(model.profile)} add|remove</code>（写完 profile 后重启官方运行时生效）；本窗口不自己实现安装器。TUI profile 的安装仍走 <code>dsh-marketplace install &lt;name&gt;</code> 或上面这行官方命令。</p>
     <p class="meta">${escapeHtml(sourceLine)} · 抓取时间 ${escapeHtml(formatLocalTimestamp(model.fetchedAt))} · 已装 ${String(model.installed.length)} 个（${escapeHtml(model.profile)} profile）</p>
     ${errorBlock}
     <div class="row">
       <button id="refresh"${disabled}>刷新目录</button>
       <button class="secondary" data-go="official">返回会话</button>
     </div>
     ${busyBlock}
     ${resultBlock}
     ${body}
     <script nonce="${nonce}">
       document.getElementById('refresh')?.addEventListener('click', () => {
         window.dshCommunity?.refreshMarketplace()
       })
       document.getElementById('restart')?.addEventListener('click', () => {
         window.dshCommunity?.restartHost()
       })
       document.querySelectorAll('[data-plugin-action]').forEach((btn) => {
         btn.addEventListener('click', () => {
           const name = btn.getAttribute('data-plugin-name') ?? ''
           const action = btn.getAttribute('data-plugin-action') ?? ''
           if (action === 'install' && btn.getAttribute('data-plugin-confirm') === 'true') {
             const risk = btn.getAttribute('data-plugin-risk') ?? 'medium'
             if (!window.confirm('插件 ' + name + ' 标记为 ' + risk + ' 风险，确认安装到 web profile？')) return
           }
           window.dshCommunity?.pluginAction(name, action)
         })
       })
     </script>`,
    'marketplace',
  )
}

export function renderDiagnosticsPage(model: DiagnosticsPageModel): string {
  return shellDocument(
    `${model.product} · 诊断`,
    (nonce) => `<h1>Host 诊断</h1>
     <p>stdout / stderr 只当日志。这里不解析 agent 或工具状态。</p>
     <dl>
       <dt>官方数据</dt><dd><code>${escapeHtml(model.officialHome)}</code>${model.isolated ? '（隔离）' : ''}</dd>
       <dt>就绪 origin</dt><dd><code>${escapeHtml(model.origin || '—')}</code></dd>
       <dt>Host</dt><dd>${escapeHtml(model.phase)} · pid ${escapeHtml(model.pid)}</dd>
     </dl>
     <pre>${escapeHtml(model.logs || '(no host log yet)')}</pre>
     <template id="copy-logs-data">${escapeHtml(model.logs || '')}</template>
     <div class="row">
       <button id="retry">重新启动官方运行时</button>
       <button class="secondary" id="copy"${copyDisabledAttrs(model.logs || '')}>复制日志</button>
       <button class="secondary" data-go="official">返回会话</button>
       <button class="secondary" data-go="about">关于与版本</button>
     </div>
     <script nonce="${nonce}">
       ${COPY_FEEDBACK_JS}
       document.getElementById('retry')?.addEventListener('click', () => {
         window.dshCommunity?.restartHost()
       })
       const copyBtn = document.getElementById('copy')
       copyBtn?.addEventListener('click', () => {
         const el = document.getElementById('copy-logs-data')
         const text = el && 'content' in el ? (el.content.textContent ?? '') : (el?.textContent ?? '')
         copyWithFeedback(copyBtn, text)
       })
     </script>`,
    'diagnostics',
  )
}

/**
 * Format a numeric epoch timestamp or ISO timestamp string into local `YYYY-MM-DD HH:mm:ss (UTC+N)`.
 */
function formatLocalTimestamp(
  input: number | string | undefined,
  options?: { includeRelative?: boolean },
): string {
  let ms: number | undefined
  if (typeof input === 'number') {
    ms = Number.isFinite(input) && input > 0 ? input : undefined
  } else if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) return '—'
    const parsed = Date.parse(trimmed)
    if (!Number.isFinite(parsed) || parsed <= 0) return trimmed
    ms = parsed
  }
  if (ms === undefined) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const absMin = Math.abs(offsetMin)
  const hh = pad(Math.floor(absMin / 60))
  const mm = pad(absMin % 60)
  const tz = mm === '00' ? `UTC${sign}${Number(hh)}` : `UTC${sign}${hh}:${mm}`
  if (options?.includeRelative) {
    const diffMs = ms - Date.now()
    if (diffMs > 0 && diffMs < 86_400_000) {
      const mins = Math.max(1, Math.ceil(diffMs / 60_000))
      return `${local} (${tz}, ${mins} 分钟后)`
    }
  }
  return `${local} (${tz})`
}

function formatRemoteTime(ts: number | undefined): string {
  return formatLocalTimestamp(ts, { includeRelative: true })
}

function remotePhaseBadge(phase: DesktopRemotePhase): string {
  switch (phase) {
    case 'running':
      return '<span class="chip ok">运行中（Desktop 托管）</span>'
    case 'external':
      return '<span class="chip ok">运行中（外部 CLI 宿主）</span>'
    case 'starting':
      return '<span class="chip risk-med">正在启动…</span>'
    case 'error':
      return '<span class="chip risk-high">启动失败 / 异常</span>'
    case 'stopped':
      return '<span class="chip">已停止</span>'
  }
}

function renderSafeQrSvg(svg: string): string {
  const trimmed = svg.trim()
  if (
    trimmed.startsWith('<svg')
    && trimmed.endsWith('</svg>')
    && !/<script|<foreignObject|javascript:|on[a-z]+\s*=/iu.test(trimmed)
  ) {
    return trimmed
  }
  return `<p class="meta">无效二维码载荷</p>`
}

function summarizeUnifiedDiff(diffText: string): { additions: number; deletions: number; hunks: number } {
  let additions = 0
  let deletions = 0
  let hunks = 0
  if (!diffText) return { additions, deletions, hunks }
  for (const line of diffText.split('\n')) {
    if (line.startsWith('@@ ')) {
      hunks += 1
    } else if (line.startsWith('+') && !line.startsWith('+++ ')) {
      additions += 1
    } else if (line.startsWith('-') && !line.startsWith('--- ')) {
      deletions += 1
    }
  }
  return { additions, deletions, hunks }
}

function renderColoredDiffHtml(diffText: string): string {
  const lines = diffText.replaceAll('\r\n', '\n').split('\n')
  const rows = lines.map((line) => {
    let cls = 'diff-ctx'
    if (
      line.startsWith('diff --git ')
      || line.startsWith('index ')
      || line.startsWith('--- ')
      || line.startsWith('+++ ')
      || line.startsWith('new file mode ')
      || line.startsWith('deleted file mode ')
    ) {
      cls = 'diff-file-hdr'
    } else if (line.startsWith('@@ ')) {
      cls = 'diff-hunk'
    } else if (line.startsWith('+')) {
      cls = 'diff-add'
    } else if (line.startsWith('-')) {
      cls = 'diff-del'
    }
    return `<span class="diff-line ${cls}">${escapeHtml(line) || '&nbsp;'}</span>`
  }).join('')
  return `<div class="diff-viewer" role="region" aria-label="Git Unified Diff">${rows}</div>`
}

function basenamePath(rawPath: string): string {
  const normalized = rawPath.replace(/[/\\]+$/u, '')
  if (!normalized) return rawPath
  const parts = normalized.split(/[/\\]/u)
  return parts[parts.length - 1] || normalized
}

function renderSessionWorkspaceCell(s: DesktopLiveSessionView): string {
  const ws = s.workspace
  const chips: string[] = []
  if (ws?.isWorktree) {
    const wtName = ws.worktreeName || basenamePath(ws.repoRoot ?? s.cwd ?? '')
    chips.push(`<span class="chip">Worktree · ${escapeHtml(wtName)}</span>`)
  }
  if (ws?.branch) {
    chips.push(`<span class="chip ${ws.dirty ? 'risk-med' : 'ok'}">${escapeHtml(ws.branch)}</span>`)
  }
  if (ws?.dirty === true) {
    chips.push(`<span class="chip risk-med">已改 ${String(ws.changedFiles ?? 0)} 项</span>`)
  } else if (ws?.dirty === false) {
    chips.push('<span class="chip ok">干净</span>')
  }
  if ((ws?.ahead ?? 0) > 0) {
    chips.push(`<span class="chip">↑${String(ws?.ahead ?? 0)}</span>`)
  }
  if ((ws?.behind ?? 0) > 0) {
    chips.push(`<span class="chip risk-med">↓${String(ws?.behind ?? 0)}</span>`)
  }
  if (chips.length > 0) {
    return `<div class="chips">${chips.join('')}</div>`
  }
  return s.cwd ? `<span class="meta"><code>${escapeHtml(s.cwd)}</code></span>` : '<span class="meta">—</span>'
}

function sessionPriorityScore(s: DesktopLiveSessionView): number {
  const pending = (s.pendingApprovals ?? 0) + (s.pendingQuestions ?? 0)
  return (pending > 0 ? 4 : 0) + (s.status === 'running' ? 2 : 0) + (s.workspace?.dirty ? 1 : 0)
}

function renderWorktreeDashboard(liveSessions: readonly DesktopLiveSessionView[]): string {
  const groupsMap = new Map<string, {
    key: string
    label: string
    pathLabel: string
    sessions: DesktopLiveSessionView[]
    worktreeRoots: Set<string>
    dirty: boolean
    pendingTotal: number
    runningCount: number
    maxUpdatedAtMs: number
  }>()

  let runningCount = 0
  let pendingTotal = 0
  const dirtyWorkspaces = new Set<string>()

  for (const s of liveSessions) {
    const ws = s.workspace
    const commonRoot = ws?.commonRepoRoot ?? ws?.repoRoot ?? s.cwd ?? ''
    const key = commonRoot || '__unscoped__'
    const wtRoot = ws?.repoRoot ?? s.cwd ?? s.id
    const pending = (s.pendingApprovals ?? 0) + (s.pendingQuestions ?? 0)
    if (s.status === 'running') runningCount += 1
    pendingTotal += pending
    if (ws?.dirty) dirtyWorkspaces.add(wtRoot)

    let group = groupsMap.get(key)
    if (!group) {
      group = {
        key,
        label: commonRoot ? basenamePath(commonRoot) : '未绑定工作目录',
        pathLabel: commonRoot,
        sessions: [],
        worktreeRoots: new Set<string>(),
        dirty: false,
        pendingTotal: 0,
        runningCount: 0,
        maxUpdatedAtMs: 0,
      }
      groupsMap.set(key, group)
    }
    group.sessions.push(s)
    if (wtRoot) group.worktreeRoots.add(wtRoot)
    if (ws?.dirty) group.dirty = true
    group.pendingTotal += pending
    if (s.status === 'running') group.runningCount += 1
    if ((s.updatedAtMs ?? 0) > group.maxUpdatedAtMs) {
      group.maxUpdatedAtMs = s.updatedAtMs ?? 0
    }
  }

  const groups = [...groupsMap.values()].sort((a, b) => {
    const pendingDiff = (b.pendingTotal > 0 ? 1 : 0) - (a.pendingTotal > 0 ? 1 : 0)
    if (pendingDiff !== 0) return pendingDiff
    const runDiff = (b.runningCount > 0 ? 1 : 0) - (a.runningCount > 0 ? 1 : 0)
    if (runDiff !== 0) return runDiff
    const dirtyDiff = (b.dirty ? 1 : 0) - (a.dirty ? 1 : 0)
    if (dirtyDiff !== 0) return dirtyDiff
    if (b.maxUpdatedAtMs !== a.maxUpdatedAtMs) return b.maxUpdatedAtMs - a.maxUpdatedAtMs
    return a.label.localeCompare(b.label)
  })

  const metricsHtml = `<div class="worktree-metrics">
    <span class="metric-pill">工作区组数 <strong>${String(groups.length)}</strong></span>
    <span class="metric-pill${runningCount > 0 ? ' ok' : ''}">运行中 <strong>${String(runningCount)}</strong></span>
    <span class="metric-pill${pendingTotal > 0 ? ' risk-med' : ''}">待处理 <strong>${String(pendingTotal)}</strong></span>
    <span class="metric-pill${dirtyWorkspaces.size > 0 ? ' risk-med' : ''}">脏工作区 <strong>${String(dirtyWorkspaces.size)}</strong></span>
  </div>`

  const groupsHtml = groups.map((group) => {
    const sortedSessions = [...group.sessions].sort((a, b) => {
      const scoreDiff = sessionPriorityScore(b) - sessionPriorityScore(a)
      if (scoreDiff !== 0) return scoreDiff
      return (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0)
    })
    const multiWorktreeChip = group.worktreeRoots.size > 1
      ? `<span class="chip">${String(group.worktreeRoots.size)} worktrees</span>`
      : ''
    const pathHtml = group.pathLabel
      ? `<span class="meta"><code>${escapeHtml(group.pathLabel)}</code></span>`
      : ''
    const rowsHtml = sortedSessions.map((s) => {
      const title = s.title ? `<div><strong>${escapeHtml(s.title)}</strong></div>` : ''
      const preview = s.preview ? `<div class="session-sub">${escapeHtml(s.preview)}</div>` : ''
      const engineBadge = s.engine ? `<span class="chip">${escapeHtml(s.engine)}</span> ` : ''
      const statusBadge = s.status === 'running'
        ? '<span class="chip ok">运行中</span>'
        : s.status === 'idle'
          ? '<span class="chip">空闲</span>'
          : ''
      const modelBadge = s.model ? ` <span class="chip">${escapeHtml(s.model)}</span>` : ''
      const pendingBadges = [
        ...(s.pendingApprovals ? [`<span class="chip risk-med">审批 ${String(s.pendingApprovals)}</span>`] : []),
        ...(s.pendingQuestions ? [`<span class="chip risk-med">提问 ${String(s.pendingQuestions)}</span>`] : []),
      ].join(' ') || '<span class="meta">—</span>'
      return `<tr>
        <td>${title}${engineBadge}<code>${escapeHtml(s.id)}</code>${preview}</td>
        <td>${renderSessionWorkspaceCell(s)}</td>
        <td>${statusBadge}${modelBadge}</td>
        <td>${pendingBadges}</td>
        <td><button class="secondary small" data-git-inspect="${escapeHtml(s.id)}">查看 Diff</button></td>
      </tr>`
    }).join('')
    return `<div class="worktree-group">
      <div class="worktree-group-hdr">
        <div><strong>${escapeHtml(group.label)}</strong> ${multiWorktreeChip}</div>
        ${pathHtml}
      </div>
      <table>
        <thead><tr><th>会话与摘要</th><th>Worktree / Git</th><th>模型 / 状态</th><th>待处理</th><th>代码审阅</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`
  }).join('')

  return `<section class="panel">
    <h2>活跃与可接入会话 · Worktree 看板（${String(liveSessions.length)}）</h2>
    ${metricsHtml}
    ${groupsHtml}
  </section>`
}

export function renderRemotePage(model: RemotePageModel): string {
  const presetHosts = new Set<string>(['', ...model.lanCandidates, '0.0.0.0', '127.0.0.1'])
  const isCustomHost = !presetHosts.has(model.settings.listenHost)
  const selectedHost = isCustomHost ? '__custom__' : model.settings.listenHost
  const customHostValue = isCustomHost ? model.settings.listenHost : ''

  const hostOptions = [
    `<option value=""${selectedHost === '' ? ' selected' : ''}>自动选择局域网 IP（当前：${escapeHtml(model.effectiveListenHost)}）</option>`,
    ...model.lanCandidates.map(
      (ip) => `<option value="${escapeHtml(ip)}"${selectedHost === ip ? ' selected' : ''}>${escapeHtml(ip)}（本机网卡）</option>`,
    ),
    `<option value="0.0.0.0"${selectedHost === '0.0.0.0' ? ' selected' : ''}>0.0.0.0（绑定全部网卡）</option>`,
    `<option value="127.0.0.1"${selectedHost === '127.0.0.1' ? ' selected' : ''}>127.0.0.1（仅本机回环 / ADB 转发）</option>`,
    `<option value="__custom__"${selectedHost === '__custom__' ? ' selected' : ''}>自定义监听地址…</option>`,
  ].join('')

  const engineChips = (model.engines ?? []).map((eng) => {
    const label = eng.displayName ?? eng.id
    const ver = eng.version ? ` ${eng.version}` : ''
    return eng.available
      ? `<span class="chip ok">${escapeHtml(label)}${escapeHtml(ver)}</span>`
      : `<span class="chip">${escapeHtml(label)} 未就绪</span>`
  }).join('')

  const hasStandaloneEngineReady = (model.engines ?? []).some((e) => e.available && e.id !== 'dsh')
  const apiKeyChip = model.apiKeyPresent
    ? '<span class="chip ok">DEEPSEEK_API_KEY 已配置</span>'
    : hasStandaloneEngineReady
      ? '<span class="chip ok">Standalone 多引擎模式（无需 DEEPSEEK_API_KEY）</span>'
      : '<span class="chip risk-high">缺少 DEEPSEEK_API_KEY</span>'

  const statusLine = `<div class="status-line">
    ${remotePhaseBadge(model.phase)}
    ${apiKeyChip}
    ${engineChips}
    <span class="chip">在线连接 ${String(model.activeConnections)}</span>
    ${(model.pendingApprovals ?? 0) > 0 ? `<span class="chip risk-med">待审批 ${String(model.pendingApprovals)}</span>` : ''}
    ${(model.pendingQuestions ?? 0) > 0 ? `<span class="chip risk-med">待回答 ${String(model.pendingQuestions)}</span>` : ''}
    ${model.isolated ? '<span class="chip">独立数据目录</span>' : ''}
  </div>`

  const errorBanner = model.error === undefined
    ? ''
    : `<pre class="error">${escapeHtml(model.error)}</pre>`
  const noticeBanner = model.notice === undefined
    ? ''
    : `<pre class="ok">${escapeHtml(model.notice)}</pre>`

  const primaryControls = (() => {
    switch (model.phase) {
      case 'starting':
        return `<button id="remote-start" disabled>正在启动…</button>
          <button class="danger" id="remote-stop">取消启动</button>`
      case 'running':
        return `<button class="secondary" id="remote-start">应用配置并重启</button>
          <button class="danger" id="remote-stop">停止 Remote Host</button>
          <button id="remote-new-pairing">刷新配对二维码</button>`
      case 'external':
        return `<button class="danger" id="remote-stop">停止外部 Host</button>
          <button id="remote-new-pairing">刷新配对二维码</button>`
      case 'stopped':
      case 'error':
        return `<button id="remote-start">启动 Remote Host</button>`
    }
  })()

  const pendingBlock = model.pendingCandidates.length === 0
    ? ''
    : `<section class="panel pending">
        <h2>待授权配对请求（${String(model.pendingCandidates.length)}）</h2>
        <p>请核对手机端显示的设备名与请求标识，确认后再授予能力。</p>
        ${model.pendingCandidates.map((c) => {
          const canApprove = c.maxAllowedCapabilities.includes('approve')
          const caps = c.maxAllowedCapabilities.map(escapeHtml).join(', ') || 'observe'
          const approveToggle = canApprove
            ? `<label class="opt">
                <input type="checkbox" checked data-allow-approve="${escapeHtml(c.candidateId)}" />
                <span>允许手机远程审批工具调用（<code>approve</code>）</span>
              </label>`
            : `<p class="meta">该请求未包含远程审批（<code>approve</code>）权限。</p>`
          return `<div class="pending-item">
            <div><strong>${escapeHtml(c.displayName || '未命名设备')}</strong> · <code>${escapeHtml(c.deviceId)}</code></div>
            <p class="meta">请求 ID: <code>${escapeHtml(c.candidateId)}</code> · 状态: ${escapeHtml(c.state)} · 过期: ${escapeHtml(formatRemoteTime(c.expiresAt))} · 上限能力: <code>${caps}</code></p>
            ${approveToggle}
            <div class="row">
              <button class="small" data-confirm-candidate="${escapeHtml(c.candidateId)}">确认授权此设备</button>
            </div>
          </div>`
        }).join('')}
      </section>`

  const pairingBlock = model.pairing === undefined
    ? ''
    : `<section class="panel">
        <h2>扫码配对手机客户端</h2>
        ${model.pairing.loopbackWarning
          ? `<div class="panel warn"><p>${escapeHtml(model.pairing.loopbackWarning)}</p></div>`
          : ''}
        <div class="pair-grid">
          <div class="qr-wrap" aria-label="Remote Pairing QR">${renderSafeQrSvg(model.pairing.qrSvg)}</div>
          <div class="pair-info">
            <dl>
              <dt>Host 指纹</dt><dd><code>${escapeHtml(model.hostFingerprint || '—')}</code></dd>
              <dt>局域网 WebSocket</dt><dd><code>${escapeHtml(model.lanUrl || '—')}</code></dd>
              ${model.relayUrl
                ? `<dt>盲中继 Relay</dt><dd><code>${escapeHtml(model.relayUrl)}</code>${model.relayRoomId ? ` · room <code>${escapeHtml(model.relayRoomId)}</code>` : ''}</dd>`
                : ''}
              ${model.signalingUrl
                ? `<dt>WebRTC 信令</dt><dd><code>${escapeHtml(model.signalingUrl)}</code>${model.signalingRoomId ? ` · room <code>${escapeHtml(model.signalingRoomId)}</code>` : ''}</dd>`
                : ''}
              ${model.stunUrls.length > 0
                ? `<dt>STUN</dt><dd><code>${escapeHtml(model.stunUrls.join(', '))}</code></dd>`
                : ''}
              <dt>配对码过期时间</dt><dd><code>${escapeHtml(formatRemoteTime(model.pairing.expiresAt))}</code></dd>
            </dl>
            <template id="copy-pairing-json">${escapeHtml(model.pairing.pairingJson)}</template>
            <template id="copy-deeplink">${escapeHtml(model.pairing.deepLink)}</template>
            <template id="copy-host-fingerprint">${escapeHtml(model.hostFingerprint)}</template>
            <div class="row">
              <button class="secondary small" id="copy-pairing-json-btn">复制配对 JSON</button>
              <button class="secondary small" id="copy-deeplink-btn">复制 Deep Link</button>
              ${model.hostFingerprint ? '<button class="secondary small" id="copy-host-fp-btn">复制指纹</button>' : ''}
            </div>
          </div>
        </div>
      </section>`

  const devicesRows = model.devices.map((d) => {
    const isRevoked = d.revokedAt !== undefined
    const statusChip = isRevoked
      ? `<span class="chip risk-high">已吊销 (${escapeHtml(formatRemoteTime(d.revokedAt))})</span>`
      : '<span class="chip ok">有效</span>'
    const actionBtn = isRevoked
      ? '<span class="meta">—</span>'
      : `<button class="danger small" data-revoke-device="${escapeHtml(d.deviceId)}">吊销</button>`
    return `<tr>
      <td><div>${escapeHtml(d.displayName || '未命名设备')}</div><code>${escapeHtml(d.deviceId)}</code></td>
      <td><code>${escapeHtml(d.capabilities.join(', ') || '—')}</code></td>
      <td>配对: ${escapeHtml(formatRemoteTime(d.pairedAt))}<br/>最近: ${escapeHtml(formatRemoteTime(d.lastSeenAt))}</td>
      <td>${statusChip}</td>
      <td>${actionBtn}</td>
    </tr>`
  }).join('')

  const liveSessions = model.liveSessions ?? []
  const liveSessionsBlock = (model.phase === 'running' || model.phase === 'external') && liveSessions.length > 0
    ? renderWorktreeDashboard(liveSessions)
    : ''

  const gitPreview = model.gitPreview
  const gitPreviewBlock = gitPreview === undefined
    ? ''
    : (() => {
        const sidEsc = escapeHtml(gitPreview.sessionId)
        const isStaged = gitPreview.staged === true
        const pathAttr = gitPreview.diffPath ? ` data-git-path="${escapeHtml(gitPreview.diffPath)}"` : ''
        const diffRaw = gitPreview.diffText ?? ''
        const hasDiffText = diffRaw.trim() !== ''
        const diffStats = summarizeUnifiedDiff(diffRaw)
        const statsChips = hasDiffText
          ? `<span class="chip diff-stat-add">+${String(diffStats.additions)}</span> <span class="chip diff-stat-del">-${String(diffStats.deletions)}</span> <span class="chip">${String(diffStats.hunks)} hunks</span>`
          : ''
        return `<section class="panel" id="remote-git-preview">
        <h2>Git 只读变更审阅 · <code>${sidEsc}</code></h2>
        ${gitPreview.error
          ? `<pre class="error">${escapeHtml(gitPreview.error)}</pre>`
          : `<div class="chips">
               <span class="chip">分支 ${escapeHtml(gitPreview.branch || 'HEAD')} (↑${String(gitPreview.ahead)} ↓${String(gitPreview.behind)})</span>
               <span class="chip">变更文件 ${String(gitPreview.files.length)}</span>
               ${statsChips}
               ${gitPreview.truncated ? '<span class="chip risk-med">Diff 已按上限截断</span>' : ''}
             </div>
             <p class="meta">工作区 <code>${escapeHtml(gitPreview.repoRoot)}</code>${gitPreview.diffPath ? ` · 筛选文件 <code>${escapeHtml(gitPreview.diffPath)}</code>` : ''}</p>
             <div class="row">
               <button class="${isStaged ? 'secondary small' : 'small'}" data-git-scope="unstaged" data-git-inspect="${sidEsc}"${pathAttr}>工作区未暂存</button>
               <button class="${isStaged ? 'small' : 'secondary small'}" data-git-scope="staged" data-git-inspect="${sidEsc}"${pathAttr}>已暂存 Staged</button>
               <button class="${gitPreview.diffPath ? 'secondary small' : 'small'}" data-git-inspect="${sidEsc}" data-git-staged="${isStaged ? '1' : '0'}">全部文件</button>
             </div>
             ${gitPreview.files.length === 0
               ? '<p class="meta">当前工作区干净，暂无未提交改动。</p>'
               : `<div class="chips">${gitPreview.files.map((f) => {
                   const activeFile = gitPreview.diffPath === f.path
                   const tag = f.untracked ? '?' : `${f.indexStatus}${f.workTreeStatus}`.trim() || 'M'
                   return `<button class="${activeFile ? 'small' : 'secondary small'}" data-git-inspect-file="${escapeHtml(f.path)}" data-git-session="${sidEsc}" data-git-staged="${isStaged ? '1' : '0'}">${escapeHtml(tag)} ${escapeHtml(f.path)}</button>`
                 }).join('')}</div>`}
             ${hasDiffText
               ? renderColoredDiffHtml(diffRaw)
               : '<pre>（当前筛选范围无文本 Diff，可能为纯未跟踪/空白改动或工作区干净）</pre>'}`}
        <template id="copy-remote-diff">${escapeHtml(diffRaw)}</template>
        <div class="row">
          <button class="secondary small" data-git-inspect="${sidEsc}" data-git-staged="${isStaged ? '1' : '0'}"${pathAttr}>刷新当前视图</button>
          <button class="secondary small" id="copy-remote-diff-btn"${copyDisabledAttrs(diffRaw)}>复制 Diff</button>
          <button class="secondary small" id="remote-git-clear">关闭 Diff 面板</button>
        </div>
      </section>`
      })()

  const devicesBlock = `<section class="panel">
    <h2>已信任设备（${String(model.devices.length)}）</h2>
    ${model.devices.length === 0
      ? '<p class="meta">暂无已配对设备。启动 Remote Host 后用手机扫描上方二维码，或在此管理离线吊销。</p>'
      : `<table>
          <thead><tr><th>设备</th><th>授权能力</th><th>时间</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${devicesRows}</tbody>
        </table>`}
  </section>`

  const configBlock = `<section class="panel">
    <h2>宿主机与网络配置</h2>
    ${model.phase === 'external'
      ? '<p class="meta">当前附着到外部 CLI 托管的 Remote Host；若要改用下方配置，请先停止外部 Host 再点启动。</p>'
      : ''}
    <dl>
      <dt>PID / 实际监听地址</dt><dd><code>${escapeHtml(model.pid)}</code> · <code>${escapeHtml(model.effectiveListenHost)}</code></dd>
      <dt>官方数据目录（Session 真源）</dt><dd><code>${escapeHtml(model.dshHome)}</code>${model.isolated ? '（隔离）' : ''}</dd>
      <dt>远程设备信任库目录</dt><dd><code>${escapeHtml(model.configDir)}</code></dd>
    </dl>
    <div class="field-grid">
      <div class="field">
        <label for="listen-host-select">监听地址 (listenHost)</label>
        <select id="listen-host-select">${hostOptions}</select>
        <input type="text" class="custom-host-input${isCustomHost ? '' : ' hidden-row'}" id="listen-host-custom" value="${escapeHtml(customHostValue)}" placeholder="自定义 IP / 主机名（选自定义时生效）"${isCustomHost ? '' : ' disabled'} />
      </div>
      <div class="field">
        <label for="remote-port">监听端口（0 = 自动分配）</label>
        <input type="number" id="remote-port" min="0" max="65535" value="${escapeHtml(String(model.settings.port))}" />
      </div>
      <div class="field">
        <label for="remote-relay">盲中继 WebSocket (relayUrl)</label>
        <input type="text" id="remote-relay" value="${escapeHtml(model.settings.relayUrl)}" placeholder="可选，如 wss://relay.example.com" />
      </div>
      <div class="field">
        <label for="remote-signaling">WebRTC 信令 (signalingUrl)</label>
        <input type="text" id="remote-signaling" value="${escapeHtml(model.settings.signalingUrl)}" placeholder="可选，如 wss://signal.example.com" />
      </div>
      <div class="field">
        <label for="remote-stun">STUN 地址（逗号分隔）</label>
        <input type="text" id="remote-stun" value="${escapeHtml(model.settings.stunUrls)}" placeholder="可选，如 stun:stun.l.google.com:19302" />
      </div>
      <div class="field">
        <label for="remote-engines">Agent 引擎（auto/dsh/claude/codex/opencode）</label>
        <input type="text" id="remote-engines" value="${escapeHtml(model.settings.engines ?? '')}" placeholder="默认自动检测本机全部已安装引擎" />
      </div>
    </div>
    <label class="opt">
      <input type="checkbox" id="remote-mdns"${model.settings.enableMdns ? ' checked' : ''} />
      <span>开启 mDNS 局域网广播发现</span>
    </label>
  </section>`

  const logsBlock = `<section class="panel">
    <h2>宿主机日志</h2>
    <pre>${escapeHtml(model.logs || '(no remote host log yet)')}</pre>
    <template id="copy-remote-logs">${escapeHtml(model.logs || '')}</template>
    <div class="row">
      <button class="secondary small" id="copy-remote-logs-btn"${copyDisabledAttrs(model.logs || '')}>复制日志</button>
    </div>
  </section>`

  return shellDocument(
    `${model.product} · 远程控制`,
    (nonce) => `<h1>远程控制与手机配对</h1>
     <p>拉起 Multi-Agent 安全控制面宿主机（DSH / Claude Code / Codex CLI / OpenCode ACP），供移动端扫码经 Noise IK 端到端加密访问与 Git Diff 代码审阅。</p>
     ${statusLine}
     ${errorBanner}
     ${noticeBanner}
     <div class="row">
       ${primaryControls}
       <button class="secondary" id="remote-refresh">刷新状态</button>
       <button class="secondary" data-go="official">返回会话</button>
     </div>
     ${pendingBlock}
     ${pairingBlock}
     ${liveSessionsBlock}
     ${gitPreviewBlock}
     ${devicesBlock}
     ${configBlock}
     ${logsBlock}
     <script nonce="${nonce}">
       ${COPY_FEEDBACK_JS}
       const readTpl = (id) => {
         const el = document.getElementById(id)
         if (!el) return ''
         return 'content' in el ? (el.content.textContent ?? '') : (el.textContent ?? '')
       }
       const hostSelect = document.getElementById('listen-host-select')
       const hostCustom = document.getElementById('listen-host-custom')
       const syncCustomHost = () => {
         if (!hostCustom) return
         const custom = hostSelect?.value === '__custom__'
         hostCustom.disabled = !custom
         hostCustom.classList.toggle('hidden-row', !custom)
       }
       syncCustomHost()
       hostSelect?.addEventListener('change', syncCustomHost)
       document.getElementById('remote-start')?.addEventListener('click', () => {
         const listenHost = hostSelect?.value === '__custom__'
           ? (hostCustom?.value ?? '')
           : (hostSelect?.value ?? '')
         const enginesVal = (document.getElementById('remote-engines')?.value ?? '').trim()
         window.dshCommunity?.remoteStart({
           listenHost,
           port: Number(document.getElementById('remote-port')?.value ?? 0),
           enableMdns: document.getElementById('remote-mdns')?.checked !== false,
           relayUrl: document.getElementById('remote-relay')?.value ?? '',
           signalingUrl: document.getElementById('remote-signaling')?.value ?? '',
           stunUrls: document.getElementById('remote-stun')?.value ?? '',
           ...(enginesVal ? { engines: enginesVal } : {}),
         })
       })
       document.getElementById('remote-stop')?.addEventListener('click', () => {
         window.dshCommunity?.remoteStop()
       })
       document.getElementById('remote-refresh')?.addEventListener('click', () => {
         window.dshCommunity?.remoteRefresh()
       })
       document.getElementById('remote-new-pairing')?.addEventListener('click', () => {
         window.dshCommunity?.remoteNewPairing()
       })
       const copyPairingBtn = document.getElementById('copy-pairing-json-btn')
       copyPairingBtn?.addEventListener('click', () => {
         copyWithFeedback(copyPairingBtn, readTpl('copy-pairing-json'))
       })
       const copyDeeplinkBtn = document.getElementById('copy-deeplink-btn')
       copyDeeplinkBtn?.addEventListener('click', () => {
         copyWithFeedback(copyDeeplinkBtn, readTpl('copy-deeplink'))
       })
       const copyHostFpBtn = document.getElementById('copy-host-fp-btn')
       copyHostFpBtn?.addEventListener('click', () => {
         copyWithFeedback(copyHostFpBtn, readTpl('copy-host-fingerprint'))
       })
       const copyRemoteLogsBtn = document.getElementById('copy-remote-logs-btn')
       copyRemoteLogsBtn?.addEventListener('click', () => {
         copyWithFeedback(copyRemoteLogsBtn, readTpl('copy-remote-logs'))
       })
       document.querySelectorAll('[data-confirm-candidate]').forEach((btn) => {
         btn.addEventListener('click', () => {
           const candidateId = btn.getAttribute('data-confirm-candidate') ?? ''
           let allowApprove = true
           document.querySelectorAll('[data-allow-approve]').forEach((cb) => {
             if (cb.getAttribute('data-allow-approve') === candidateId) {
               allowApprove = cb.checked === true
             }
           })
           window.dshCommunity?.remoteConfirmPairing({ candidateId, allowApprove })
         })
       })
       document.querySelectorAll('[data-revoke-device]').forEach((btn) => {
         btn.addEventListener('click', () => {
           const deviceId = btn.getAttribute('data-revoke-device') ?? ''
           if (deviceId) window.dshCommunity?.remoteRevokeDevice(deviceId)
         })
       })
       const copyRemoteDiffBtn = document.getElementById('copy-remote-diff-btn')
       copyRemoteDiffBtn?.addEventListener('click', () => {
         copyWithFeedback(copyRemoteDiffBtn, readTpl('copy-remote-diff'))
       })
       document.querySelectorAll('[data-git-inspect]').forEach((btn) => {
         btn.addEventListener('click', () => {
           const sessionId = btn.getAttribute('data-git-inspect') ?? ''
           const scope = btn.getAttribute('data-git-scope')
           const stagedAttr = btn.getAttribute('data-git-staged')
           const path = btn.getAttribute('data-git-path') ?? ''
           const staged = scope ? scope === 'staged' : (stagedAttr === '1')
           if (sessionId) {
             window.dshCommunity?.remoteGitInspect({
               sessionId,
               staged,
               ...(path ? { path } : {}),
             })
           }
         })
       })
       document.querySelectorAll('[data-git-inspect-file]').forEach((btn) => {
         btn.addEventListener('click', () => {
           const path = btn.getAttribute('data-git-inspect-file') ?? ''
           const sessionId = btn.getAttribute('data-git-session') ?? ''
           const staged = btn.getAttribute('data-git-staged') === '1'
           if (sessionId && path) window.dshCommunity?.remoteGitInspect({ sessionId, path, staged })
         })
       })
       document.getElementById('remote-git-clear')?.addEventListener('click', () => {
         window.dshCommunity?.remoteGitInspect({ clear: true })
       })
     </script>`,
    'remote',
  )
}
