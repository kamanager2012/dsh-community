import { COMMUNITY_PRODUCT_NAME } from './branding.ts'

export interface AboutPageModel {
  readonly product: string
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function shellDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: dark; }
      html, body { height: 100%; margin: 0; background: #101218; color: #d9dee8;
        font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; }
      main { min-height: 100%; display: grid; place-items: center; padding: 32px; }
      .card { max-width: 42rem; }
      h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 0.6rem; }
      p, li { color: #9aa3b2; }
      code, pre { font: 12px/1.45 ui-monospace, SFMono-Regular, monospace; }
      pre { max-height: 12rem; overflow: auto; background: #0b0d12; padding: 12px; border-radius: 8px; }
      button { appearance: none; border: 0; border-radius: 8px; padding: 8px 14px;
        background: #2f6fed; color: white; font: inherit; cursor: pointer; }
      button.secondary { background: #2a303b; }
      .row { display: flex; gap: 8px; margin-top: 16px; }
      dt { color: #6d7686; font-size: 12px; }
      dd { margin: 0 0 10px; word-break: break-all; }
      table { width: 100%; border-collapse: collapse; margin: 12px 0 4px; font: 12px/1.45 ui-monospace, SFMono-Regular, monospace; }
      th, td { text-align: left; padding: 6px 8px 6px 0; border-bottom: 1px solid #2a303b; word-break: break-all; }
      th { color: #6d7686; font-weight: 500; }
    </style>
  </head>
  <body>
    <main><div class="card">${body}</div></main>
  </body>
</html>`
}

export function renderLoadingPage(): string {
  return shellDocument(
    COMMUNITY_PRODUCT_NAME,
    `<h1>${escapeHtml(COMMUNITY_PRODUCT_NAME)}</h1>
     <p>正在启动官方 <code>dsh web</code>。本窗口只做壳，不跑第二套 agent loop。</p>`,
  )
}

export function renderErrorPage(message: string): string {
  return shellDocument(
    `${COMMUNITY_PRODUCT_NAME} · 官方运行时`,
    `<h1>官方运行时没有就绪</h1>
     <p>这是社区壳。失败发生在已发布的 <code>@deepseek-ai/dsh</code> 子进程，而不是本仓的 harness 拷贝。</p>
     <pre>${escapeHtml(message)}</pre>
     <div class="row">
       <button id="retry">重新启动官方运行时</button>
     </div>
     <script>
       document.getElementById('retry')?.addEventListener('click', () => {
         window.dshCommunity?.restartHost()
       })
     </script>`,
  )
}

export function renderAboutPage(model: AboutPageModel): string {
  return shellDocument(
    `${model.product} · 关于`,
    `<h1>${escapeHtml(model.product)}</h1>
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
       <button class="secondary" id="back">返回会话</button>
     </div>
     <script>
       document.getElementById('retry')?.addEventListener('click', () => {
         window.dshCommunity?.restartHost()
       })
       document.getElementById('back')?.addEventListener('click', () => {
         window.dshCommunity?.openOfficial()
       })
     </script>`,
  )
}

export function renderOfficialSessionsPage(model: OfficialSessionsPageModel): string {
  const rows = model.sessions.length === 0
    ? '<p>官方 <code>~/.dsh/sessions</code> 里还没有 session。TUI / Web / 本窗口共用这一份，不会另建目录。</p>'
    : `<table>
         <thead><tr><th>session</th><th>project</th></tr></thead>
         <tbody>${model.sessions.map((session) =>
           `<tr><td><code>${escapeHtml(session.id)}</code></td><td><code>${escapeHtml(session.projectKey)}</code></td></tr>`,
         ).join('')}</tbody>
       </table>`
  return shellDocument(
    `${model.product} · 官方 Session`,
    `<h1>官方 Session</h1>
     <p>只读列出官方 <code>${escapeHtml(model.officialHome)}</code>${model.isolated ? '（隔离）' : ''} 下的 <code>sessions/</code>。恢复对话走官方 Web 或 <code>dsh-community-tui --resume &lt;id&gt;</code>。</p>
     ${rows}
     <div class="row">
       <button id="open">打开官方 Web</button>
       <button class="secondary" id="back">返回会话</button>
     </div>
     <script>
       document.getElementById('open')?.addEventListener('click', () => {
         window.dshCommunity?.openOfficial()
       })
       document.getElementById('back')?.addEventListener('click', () => {
         window.dshCommunity?.openOfficial()
       })
     </script>`,
  )
}

export function renderRuntimePage(model: RuntimePageModel): string {
  const rec = model.recommendation === 'stay'
    ? '当前安装就是契约验证过的版本，不必追 npm latest。'
    : model.canSwitchToTested
      ? '契约已验证更新的版本，可从菜单钉住 latest-tested。'
      : '契约 latest-tested 与当前安装不同，但本仓还只暂存一个官方包；先升 pin 并跑 contract CI，不要从 stdout 猜兼容性。'
  return shellDocument(
    `${model.product} · 运行时`,
    `<h1>Version Manager</h1>
     <p>这是 Desktop 发行能力：推荐 <code>latest-tested</code>，不是 npm latest。不实现第二套 runtime。</p>
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
       <button class="secondary" id="back">返回会话</button>
     </div>
     <script>
       document.getElementById('back')?.addEventListener('click', () => {
         window.dshCommunity?.openOfficial()
       })
     </script>`,
  )
}
