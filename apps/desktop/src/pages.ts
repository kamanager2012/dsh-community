import { COMMUNITY_PRODUCT_NAME } from './branding.ts'
import {
  PLUGIN_CATEGORIES,
  PLUGIN_CATEGORY_LABELS,
  type MarketplaceCatalog,
  type MarketplaceSource,
  type PluginAction,
} from './marketplace.ts'

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
  readonly isolated: boolean
  readonly envIsolated: boolean
  readonly officialHome: string
  readonly isolatedHome: string
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
      button.small { padding: 4px 10px; font-size: 13px; }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
      pre.ok { background: #0b1a12; border: 1px solid #1d4a2c; }
      .chip.ok { color: #7ee2a8; border-color: #2f6fed; }
      .row { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
      nav.nav { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 18px; }
      nav.nav button { font-size: 13px; padding: 6px 10px; }
      label.opt { display: flex; gap: 8px; align-items: flex-start; margin: 10px 0; color: #d9dee8; }
      label.opt input { margin-top: 4px; }
      dt { color: #6d7686; font-size: 12px; }
      dd { margin: 0 0 10px; word-break: break-all; }
      table { width: 100%; border-collapse: collapse; margin: 12px 0 4px; font: 12px/1.45 ui-monospace, SFMono-Regular, monospace; }
      th, td { text-align: left; padding: 6px 8px 6px 0; border-bottom: 1px solid #2a303b; word-break: break-all; }
      th { color: #6d7686; font-weight: 500; }
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
    </style>
  </head>
  <body>
    <main><div class="card">
      <nav class="nav">
        <button class="secondary" data-go="official">官方 Web</button>
        <button class="secondary" data-go="sessions">Session</button>
        <button class="secondary" data-go="marketplace">市场</button>
        <button class="secondary" data-go="runtime">运行时</button>
        <button class="secondary" data-go="settings">设置</button>
        <button class="secondary" data-go="diagnostics">诊断</button>
      </nav>
      ${body}
    </div></main>
    <script>
      const go = {
        official: () => window.dshCommunity?.openOfficial(),
        sessions: () => window.dshCommunity?.showSessions(),
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

export function renderLoadingPage(detail?: string): string {
  const extra = detail === undefined || detail.length === 0
    ? ''
    : `<p>${escapeHtml(detail)}</p>`
  return shellDocument(
    COMMUNITY_PRODUCT_NAME,
    `<h1>${escapeHtml(COMMUNITY_PRODUCT_NAME)}</h1>
     <p>正在启动官方 <code>dsh web</code>。本窗口只做壳，不跑第二套 agent loop。</p>${extra}`,
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
    `<h1>${escapeHtml(model.identity)}</h1>
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
     <script>
       document.getElementById('retry')?.addEventListener('click', () => {
         window.dshCommunity?.restartHost()
       })
     </script>`,
  )
}

export function renderOfficialSessionsPage(model: OfficialSessionsPageModel): string {
  const rows = model.sessions.length === 0
    ? '<p>官方 <code>~/.dsh/sessions</code> 里还没有 session。TUI / Web / 本窗口共用这一份，不会另建目录。</p>'
    : `<table>
         <thead><tr><th>session</th><th>project</th><th>updated</th><th></th></tr></thead>
         <tbody>${model.sessions.map((session) =>
           `<tr>
              <td><code>${escapeHtml(session.id)}</code></td>
              <td><code>${escapeHtml(session.projectKey)}</code></td>
              <td>${escapeHtml(session.updatedAt)}</td>
              <td><button class="secondary" data-resume="${escapeHtml(session.id)}">复制 --resume</button></td>
            </tr>`,
         ).join('')}</tbody>
       </table>`
  return shellDocument(
    `${model.product} · 官方 Session`,
    `<h1>官方 Session</h1>
     <p>只读列出官方 <code>${escapeHtml(model.officialHome)}</code>${model.isolated ? '（隔离）' : ''} 下的 <code>sessions/</code>。恢复对话走官方 Web 或 <code>dsh-community-tui --resume &lt;id&gt;</code>。本页不另建 session 目录。</p>
     ${rows}
     <div class="row">
       <button data-go="official">打开官方 Web</button>
       <button class="secondary" data-go="sessions">刷新列表</button>
     </div>
     <script>
       document.querySelectorAll('[data-resume]').forEach((btn) => {
         btn.addEventListener('click', () => {
           const id = btn.getAttribute('data-resume')
           if (id) window.dshCommunity?.copyText('dsh-community-tui --resume ' + id)
         })
       })
     </script>`,
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
     </div>`,
  )
}

export function renderSettingsPage(model: SettingsPageModel): string {
  return shellDocument(
    `${model.product} · 设置`,
    `<h1>Desktop 设置</h1>
     <p>只改壳自己的偏好。官方 session 仍在 <code>${escapeHtml(model.officialHome)}</code>${model.isolated ? '（隔离）' : ''}。</p>
     <label class="opt">
       <input type="checkbox" id="hideToTray" ${model.hideToTray ? 'checked' : ''} />
       <span>关窗藏到托盘，官方 <code>dsh web</code> 继续跑</span>
     </label>
     <label class="opt">
       <input type="checkbox" id="isolated" ${model.isolated ? 'checked' : ''} ${model.envIsolated ? 'disabled' : ''} />
       <span>隔离官方数据到 <code>${escapeHtml(model.isolatedHome)}</code>（不再共用 <code>~/.dsh</code>）</span>
     </label>
     <p>${model.envIsolated
       ? '环境变量 <code>DSH_COMMUNITY_ISOLATED=1</code> 已强制隔离，界面关不掉。'
       : '默认不要开隔离。开了之后 TUI / 系统浏览器里的官方 session 不会出现在这个窗口。改这项会重启官方 <code>dsh web</code>。'}</p>
     <div class="row">
       <button id="save">保存</button>
       <button class="secondary" data-go="official">返回会话</button>
     </div>
     <script>
       document.getElementById('save')?.addEventListener('click', () => {
         window.dshCommunity?.applySettings({
           hideToTray: document.getElementById('hideToTray')?.checked === true,
           isolated: ${model.envIsolated ? 'true' : 'document.getElementById(\'isolated\')?.checked === true'},
         })
       })
     </script>`,
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
    : `<pre>${escapeHtml(model.error)}</pre>`
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
      : `<pre>${result.action === 'install' ? '安装' : '卸载'}失败：${escapeHtml(result.plugin)}\n\n${escapeHtml(result.log)}</pre>`
  const plugins = model.catalog?.plugins ?? []
  const installedSet = new Set(model.installed)
  const disabled = busy === undefined ? '' : ' disabled'
  const sections = PLUGIN_CATEGORIES.map((category) => {
    const members = plugins.filter((plugin) => plugin.category === category)
    if (members.length === 0) return ''
    const rows = members.map((plugin) => {
      const installed = installedSet.has(plugin.name)
      const chips = plugin.versions.map((version) => {
        const note = version.notes === undefined ? '' : ` · ${escapeHtml(version.notes)}`
        return `<span class="chip">v${escapeHtml(version.version)} · 验证线 ${escapeHtml(version.testedDsh)}${note}</span>`
      }).join('')
      const actionButton = installed
        ? `<button class="secondary small${disabled}" data-plugin-action="remove" data-plugin-name="${escapeHtml(plugin.name)}">卸载</button>`
        : `<button class="small${disabled}" data-plugin-action="install" data-plugin-name="${escapeHtml(plugin.name)}">安装到 web profile</button>`
      return `<li>
        <div class="plugin-head">
          <code class="plugin-name">${escapeHtml(plugin.name)}</code>
          <span class="author">by ${escapeHtml(plugin.author)}</span>
          ${installed ? '<span class="chip ok">已装</span>' : ''}
        </div>
        <p>${escapeHtml(plugin.description)}</p>
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
    `<h1>社区市场</h1>
     <p>浏览 <a href="${escapeHtml(model.registryUrl)}">插件目录 catalog.json</a>。安装/卸载按钮唤起官方 <code>dsh plugin --profile ${escapeHtml(model.profile)} add|remove</code>（写完 profile 后重启官方运行时生效）；本窗口不自己实现安装器。TUI profile 的安装仍走 <code>dsh-marketplace install &lt;name&gt;</code> 或上面这行官方命令。</p>
     <p class="meta">${escapeHtml(sourceLine)} · 抓取时间 ${escapeHtml(model.fetchedAt || '—')} · 已装 ${String(model.installed.length)} 个（${escapeHtml(model.profile)} profile）</p>
     ${errorBlock}
     <div class="row">
       <button id="refresh"${disabled}>刷新目录</button>
       <button class="secondary" data-go="official">返回会话</button>
     </div>
     ${busyBlock}
     ${resultBlock}
     ${body}
     <script>
       document.getElementById('refresh')?.addEventListener('click', () => {
         window.dshCommunity?.refreshMarketplace()
       })
       document.getElementById('restart')?.addEventListener('click', () => {
         window.dshCommunity?.restartHost()
       })
       document.querySelectorAll('[data-plugin-action]').forEach((btn) => {
         btn.addEventListener('click', () => {
           window.dshCommunity?.pluginAction(
             btn.getAttribute('data-plugin-name') ?? '',
             btn.getAttribute('data-plugin-action') ?? '',
           )
         })
       })
     </script>`,
  )
}

export function renderDiagnosticsPage(model: DiagnosticsPageModel): string {
  return shellDocument(
    `${model.product} · 诊断`,
    `<h1>Host 诊断</h1>
     <p>stdout / stderr 只当日志。这里不解析 agent 或工具状态。</p>
     <dl>
       <dt>官方数据</dt><dd><code>${escapeHtml(model.officialHome)}</code>${model.isolated ? '（隔离）' : ''}</dd>
       <dt>就绪 origin</dt><dd><code>${escapeHtml(model.origin || '—')}</code></dd>
       <dt>Host</dt><dd>${escapeHtml(model.phase)} · pid ${escapeHtml(model.pid)}</dd>
     </dl>
     <pre>${escapeHtml(model.logs || '(no host log yet)')}</pre>
     <div class="row">
       <button id="retry">重新启动官方运行时</button>
       <button class="secondary" id="copy">复制日志</button>
       <button class="secondary" data-go="official">返回会话</button>
     </div>
     <script>
       document.getElementById('retry')?.addEventListener('click', () => {
         window.dshCommunity?.restartHost()
       })
       document.getElementById('copy')?.addEventListener('click', () => {
         window.dshCommunity?.copyText(${JSON.stringify(model.logs || '')})
       })
     </script>`,
  )
}
