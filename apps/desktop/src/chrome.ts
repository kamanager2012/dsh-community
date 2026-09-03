export const CHROME_HEIGHT = 48

export type ChromeActive =
  | 'official'
  | 'sessions'
  | 'marketplace'
  | 'runtime'
  | 'settings'
  | 'diagnostics'
  | 'about'
  | 'loading'
  | 'error'

export interface ChromeBarModel {
  readonly product: string
  readonly identity: string
  readonly phase: string
  readonly isolated: boolean
  readonly origin: string
  readonly active: ChromeActive
}

export function officialViewBounds(
  width: number,
  height: number,
  visible: boolean,
  chromeHeight = CHROME_HEIGHT,
): { x: number; y: number; width: number; height: number } {
  if (!visible || width <= 0 || height <= chromeHeight) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  return { x: 0, y: chromeHeight, width, height: height - chromeHeight }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Thin bar that stays up while official `dsh web` fills the rest of the window. */
export function renderChromePage(model: ChromeBarModel): string {
  const status = `${model.phase}${model.isolated ? ' · 独立数据目录' : ' · 共用 ~/.dsh'}`
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(model.product)}</title>
    <style>
      :root { color-scheme: dark; }
      html, body { height: 100%; margin: 0; background: #101218; color: #d9dee8;
        font: 13px/1.4 ui-sans-serif, system-ui, sans-serif; overflow: hidden; }
      .bar { height: ${String(CHROME_HEIGHT)}px; box-sizing: border-box;
        display: flex; align-items: center; gap: 10px; padding: 0 12px;
        border-bottom: 1px solid #2a303b; background: #161922; }
      strong { font-weight: 600; white-space: nowrap; }
      .status { color: #9aa3b2; font: 12px/1.3 ui-monospace, SFMono-Regular, monospace;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      nav { margin-left: auto; display: flex; gap: 6px; flex-wrap: nowrap; }
      button { appearance: none; border: 0; border-radius: 6px; padding: 5px 9px;
        background: #2a303b; color: #d9dee8; font: inherit; cursor: pointer; }
      button[data-active="true"] { background: #2f6fed; color: white; }
    </style>
  </head>
  <body>
    <div class="bar">
      <strong title="${escapeHtml(model.product)}">${escapeHtml(model.identity)}</strong>
      <span class="status" title="${escapeHtml(model.origin || '')}">${escapeHtml(status)}</span>
      <nav>
        <button data-go="official" data-active="${String(model.active === 'official')}">官方 Web</button>
        <button data-go="sessions" data-active="${String(model.active === 'sessions')}">Session</button>
        <button data-go="marketplace" data-active="${String(model.active === 'marketplace')}">市场</button>
        <button data-go="runtime" data-active="${String(model.active === 'runtime')}">运行时</button>
        <button data-go="settings" data-active="${String(model.active === 'settings')}">设置</button>
        <button data-go="diagnostics" data-active="${String(model.active === 'diagnostics')}">诊断</button>
      </nav>
    </div>
    <script>
      const go = {
        official: () => window.dshCommunity?.openOfficial(),
        sessions: () => window.dshCommunity?.showSessions(),
        marketplace: () => window.dshCommunity?.showMarketplace(),
        runtime: () => window.dshCommunity?.showRuntime(),
        settings: () => window.dshCommunity?.showSettings(),
        diagnostics: () => window.dshCommunity?.showDiagnostics(),
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
