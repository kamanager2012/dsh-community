import { join } from 'node:path'
import { BrowserWindow, WebContentsView, shell, type WebContents } from 'electron'
import { WINDOW_TITLE } from './branding.ts'
import { officialViewBounds } from './chrome.ts'
import { decideNavigation, decideOfficialViewNavigation } from './navigation.ts'

const WINDOW_WIDTH = 1280
const WINDOW_HEIGHT = 840

function bindNavigation(
  contents: WebContents,
  decide: (url: string, origin: string) => ReturnType<typeof decideNavigation>,
  getOrigin: () => string,
): void {
  contents.on('will-navigate', (event, url) => {
    const decision = decide(url, getOrigin())
    if (decision === 'allow') return
    event.preventDefault()
    if (decision === 'open-external') void shell.openExternal(url)
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (decide(url, getOrigin()) === 'open-external') {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
}

export function createDesktopWindow(input: {
  readonly preloadPath: string
  readonly getOrigin: () => string
  readonly bounds?: { x?: number; y?: number; width: number; height: number }
}): BrowserWindow {
  const bounds = input.bounds
  const window = new BrowserWindow({
    width: bounds?.width ?? WINDOW_WIDTH,
    height: bounds?.height ?? WINDOW_HEIGHT,
    ...(bounds?.x === undefined ? {} : { x: bounds.x }),
    ...(bounds?.y === undefined ? {} : { y: bounds.y }),
    minWidth: 880,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: WINDOW_TITLE,
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  bindNavigation(window.webContents, decideNavigation, input.getOrigin)
  return window
}

/** Official `dsh web` only. No preload, no Desktop IPC. */
export function createOfficialWebView(getOrigin: () => string): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  bindNavigation(view.webContents, decideOfficialViewNavigation, getOrigin)
  return view
}

export function attachOfficialWebView(window: BrowserWindow, view: WebContentsView): void {
  window.contentView.addChildView(view)
}

export function layoutOfficialWebView(
  window: BrowserWindow,
  view: WebContentsView,
  visible: boolean,
): void {
  const size = window.getContentSize()
  const width = size[0] ?? 0
  const height = size[1] ?? 0
  const bounds = officialViewBounds(width, height, visible)
  view.setVisible(visible)
  view.setBounds(bounds)
}

export function preloadPathFromMain(mainDir: string): string {
  return join(mainDir, 'preload.js')
}
