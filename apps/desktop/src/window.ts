import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'
import { WINDOW_TITLE } from './branding.ts'
import { decideNavigation } from './navigation.ts'

const WINDOW_WIDTH = 1280
const WINDOW_HEIGHT = 840

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

  window.webContents.on('will-navigate', (event, url) => {
    const decision = decideNavigation(url, input.getOrigin())
    if (decision === 'allow') return
    event.preventDefault()
    if (decision === 'open-external') void shell.openExternal(url)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (decideNavigation(url, input.getOrigin()) === 'open-external') {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  return window
}

export function preloadPathFromMain(mainDir: string): string {
  return join(mainDir, 'preload.js')
}
