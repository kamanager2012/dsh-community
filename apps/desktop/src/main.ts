/**
 * Community desktop shell. Reconstructs a tray-owned Host lifecycle around
 * the published official CLI. This file does not contain an agent loop.
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  session,
  Tray,
  type BrowserWindow,
  type WebContentsView,
} from 'electron'
import {
  createOfficialHost,
  hostProcessEnv,
  hydrateCatalog,
  isolatedDesktopRequested,
  listOfficialSessions,
  officialSessionRoot,
  parseRuntimeCatalog,
  pinDefault,
  resolveDesktopAppLayout,
  resolveEffectiveOfficialHome,
  resolveOfficialDsh,
  spawnOfficialWeb,
  type OfficialHost,
  type RuntimeCatalog,
} from '@dsh-community/dsh-bridge'
import { COMMUNITY_PRODUCT_NAME, WINDOW_TITLE } from './branding.ts'
import { renderChromePage, type ChromeActive } from './chrome.ts'
import { resolveLatestTestedPath } from './contracts-path.ts'
import { appendHostDiagnostics } from './host-log.ts'

import { readJsonFile, writeJsonFile } from './json-file.ts'
import { DESKTOP_IPC, LIFECYCLE_IPC } from './ipc-channels.ts'
import {
  renderAboutPage,
  renderDiagnosticsPage,
  renderErrorPage,
  renderLoadingPage,
  renderOfficialSessionsPage,
  renderRuntimePage,
  renderSettingsPage,
} from './pages.ts'
import { formatSessionMtime } from './session-view.ts'
import { assertHostLaunchPaths, resolveHostLaunchPaths } from './paths.ts'
import { buildRuntimeView, readLatestTested } from './runtime-view.ts'
import {
  applyDesktopSettingsPatch,
  DEFAULT_DESKTOP_SETTINGS,
  parseDesktopSettings,
  readSettingsPatch,
  type DesktopSettings,
} from './settings.ts'
import { decideHostCrash, decideWindowClose } from './shell-policy.ts'
import {
  DEFAULT_WINDOW_STATE,
  parseWindowState,
  windowStateFromBounds,
} from './window-state.ts'
import {
  attachOfficialWebView,
  createDesktopWindow,
  createOfficialWebView,
  layoutOfficialWebView,
  preloadPathFromMain,
} from './window.ts'

const MAIN_DIR = dirname(fileURLToPath(import.meta.url))
const WORKSPACE_ROOT = resolve(MAIN_DIR, '../../..')

let host: OfficialHost | undefined
let window: BrowserWindow | undefined
let officialView: WebContentsView | undefined
let tray: Tray | undefined
let origin = ''
let showingOfficial = false
let quitting = false
let settings = DEFAULT_DESKTOP_SETTINGS
let catalog: RuntimeCatalog | undefined

function trayAvailable(): boolean {
  return tray !== undefined && !tray.isDestroyed()
}

function desktopLayout() {
  return resolveDesktopAppLayout(app.getPath('userData'))
}

function isolatedNow(): boolean {
  return settings.isolated || isolatedDesktopRequested()
}

function officialHome(): string {
  return resolveEffectiveOfficialHome({
    env: process.env,
    homedir: app.getPath('home'),
    desktopUserData: app.getPath('userData'),
    isolated: settings.isolated,
  })
}

function hardenSession(): void {
  const desktopSession = session.defaultSession
  desktopSession.setPermissionCheckHandler(() => false)
  desktopSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
}

function launchPaths() {
  const homedir = app.getPath('home')
  return resolveHostLaunchPaths({
    isPackaged: app.isPackaged,
    from: import.meta.url,
    env: hostProcessEnv({
      env: process.env,
      homedir,
      desktopUserData: app.getPath('userData'),
      isolated: settings.isolated,
    }),
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    homedir,
    cwd: process.cwd(),
  })
}

function loadDesktopState(installed: string): {
  readonly settings: DesktopSettings
  readonly catalog: RuntimeCatalog
  readonly bounds: ReturnType<typeof parseWindowState>
} {
  const layout = desktopLayout()
  const testedPath = resolveLatestTestedPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    workspaceRoot: WORKSPACE_ROOT,
  })
  const latestTested = readLatestTested(
    testedPath === undefined ? undefined : readJsonFile(testedPath),
    installed,
  )
  return {
    settings: parseDesktopSettings(readJsonFile(layout.desktopSettings)),
    catalog: hydrateCatalog(parseRuntimeCatalog(readJsonFile(layout.runtimeVersions)), latestTested, installed),
    bounds: parseWindowState(readJsonFile(layout.windowState)),
  }
}

function persistCatalog(): void {
  if (catalog === undefined) return
  writeJsonFile(desktopLayout().runtimeVersions, catalog)
}

function persistWindowState(): void {
  if (window === undefined || window.isDestroyed()) return
  writeJsonFile(desktopLayout().windowState, windowStateFromBounds(window.getBounds()))
}

function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function layoutOfficial(): void {
  if (window === undefined || window.isDestroyed() || officialView === undefined) return
  layoutOfficialWebView(window, officialView, showingOfficial)
}

function chromeModel(active: ChromeActive) {
  const snap = host?.snapshot()
  return {
    product: COMMUNITY_PRODUCT_NAME,
    phase: snap?.phase ?? 'idle',
    isolated: isolatedNow(),
    origin,
    active,
  }
}

async function showHtml(html: string): Promise<void> {
  if (window === undefined || window.isDestroyed()) return
  showingOfficial = false
  layoutOfficial()
  await window.loadURL(dataUrl(html))
  if (!window.isVisible() && !quitting) window.show()
}

async function showOfficial(nextOrigin: string): Promise<void> {
  if (window === undefined || window.isDestroyed() || officialView === undefined) return
  origin = nextOrigin
  showingOfficial = true
  await window.loadURL(dataUrl(renderChromePage(chromeModel('official'))))
  const current = officialView.webContents.getURL()
  if (current !== nextOrigin && !current.startsWith(`${nextOrigin}/`)) {
    await officialView.webContents.loadURL(nextOrigin)
  }
  layoutOfficial()
  if (!window.isVisible() && !quitting) window.show()
}

function aboutModel() {
  const install = resolveOfficialDsh({ from: import.meta.url })
  const snap = host?.snapshot()
  const layout = desktopLayout()
  return {
    product: COMMUNITY_PRODUCT_NAME,
    officialPackage: install.packageName,
    officialVersion: install.version,
    officialBin: install.binPath,
    officialHome: officialHome(),
    desktopRoot: layout.root,
    isolated: isolatedNow(),
    latestTested: catalog?.latestTested ?? install.version,
    officialSessionCount: listOfficialSessions(officialSessionRoot(officialHome())).length,
    origin,
    phase: snap?.phase ?? 'idle',
    pid: snap && 'pid' in snap && snap.pid !== undefined ? String(snap.pid) : '—',
    logs: host?.logs() ?? '',
  }
}

function runtimeModel() {
  const install = resolveOfficialDsh({ from: import.meta.url })
  const layout = desktopLayout()
  const view = buildRuntimeView({
    installed: install.version,
    catalog: catalog ?? hydrateCatalog(undefined, install.version, install.version),
    officialHome: officialHome(),
    desktopRoot: layout.root,
    catalogPath: layout.runtimeVersions,
    isolated: isolatedNow(),
  })
  return { product: COMMUNITY_PRODUCT_NAME, ...view }
}

function officialSessionsModel() {
  const home = officialHome()
  return {
    product: COMMUNITY_PRODUCT_NAME,
    officialHome: home,
    isolated: isolatedNow(),
    sessions: listOfficialSessions(officialSessionRoot(home)).map((session) => ({
      id: session.id,
      projectKey: session.projectKey,
      transcript: session.transcript,
      updatedAt: formatSessionMtime(session.mtimeMs),
    })),
  }
}

function settingsModel() {
  return {
    product: COMMUNITY_PRODUCT_NAME,
    hideToTray: settings.hideToTray,
    isolated: isolatedNow(),
    envIsolated: isolatedDesktopRequested(),
    officialHome: officialHome(),
    isolatedHome: desktopLayout().isolatedOfficialHome,
  }
}

function diagnosticsModel() {
  const snap = host?.snapshot()
  return {
    product: COMMUNITY_PRODUCT_NAME,
    officialHome: officialHome(),
    isolated: isolatedNow(),
    origin,
    phase: snap?.phase ?? 'idle',
    pid: snap && 'pid' in snap && snap.pid !== undefined ? String(snap.pid) : '—',
    logs: host?.logs() ?? '',
  }
}

async function showAbout(): Promise<void> {
  await showHtml(renderAboutPage(aboutModel()))
}

async function showOfficialSessions(): Promise<void> {
  await showHtml(renderOfficialSessionsPage(officialSessionsModel()))
}

async function showRuntime(): Promise<void> {
  await showHtml(renderRuntimePage(runtimeModel()))
}

async function showSettings(): Promise<void> {
  await showHtml(renderSettingsPage(settingsModel()))
}

async function showDiagnostics(): Promise<void> {
  await showHtml(renderDiagnosticsPage(diagnosticsModel()))
}

function pinLatestTested(): void {
  if (catalog === undefined) return
  catalog = pinDefault(catalog, catalog.latestTested)
  persistCatalog()
  void showRuntime()
}

async function startOfficial(): Promise<void> {
  if (host === undefined) throw new Error('official host is not created')
  await showHtml(renderLoadingPage())
  const next = await host.start()
  await showOfficial(next)
}

async function restartOfficial(then: 'official' | 'settings' = 'official'): Promise<void> {
  if (host === undefined) throw new Error('official host is not created')
  await showHtml(renderLoadingPage())
  const next = await host.restart()
  origin = next
  if (then === 'settings') await showSettings()
  else await showOfficial(next)
}

function persistSettings(): void {
  writeJsonFile(desktopLayout().desktopSettings, settings)
}

async function applySettings(raw: unknown): Promise<void> {
  const previousIsolated = isolatedNow()
  settings = applyDesktopSettingsPatch(settings, readSettingsPatch(raw))
  persistSettings()
  if (isolatedNow() !== previousIsolated) {
    await restartOfficial('settings')
    return
  }
  await showSettings()
}

function copyDesktopText(text: unknown): boolean {
  if (typeof text !== 'string' || text.length === 0 || text.length > 16_384) return false
  clipboard.writeText(text)
  return true
}

function revealWindow(): void {
  if (window === undefined || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function createTray(): Tray | undefined {
  const iconPath = join(MAIN_DIR, '../resources/tray.png')
  const image = nativeImage.createFromPath(iconPath)
  const icon = image.isEmpty() ? nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAVElEQVRYR+3XsQ0AIAwDQeafGhmBFRiBFdi/q2QKKsrJ/c0V2ZIkSQbA7r33m7nIzD1jrZWqOmvtnXNu5n5mZs75XwAAAAAAAAAA/M0DcQ0SAf3eVOkAAAAASUVORK5CYII=',
  ) : image
  try {
    const next = new Tray(icon)
    next.setToolTip(COMMUNITY_PRODUCT_NAME)
    next.setContextMenu(Menu.buildFromTemplate([
      { label: '显示窗口', click: () => revealWindow() },
      { label: '重新启动官方运行时', click: () => void restartOfficial().catch(showStartFailure) },
      { label: '运行时 / Version Manager', click: () => void showRuntime() },
      { label: '官方 Session', click: () => void showOfficialSessions() },
      { label: '设置', click: () => void showSettings() },
      { label: 'Host 诊断', click: () => void showDiagnostics() },
      { label: '关于社区壳', click: () => void showAbout() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]))
    next.on('click', () => revealWindow())
    return next
  } catch {
    return undefined
  }
}

function showStartFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  void showHtml(renderErrorPage(message))
}

function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin'
      ? [{
          label: COMMUNITY_PRODUCT_NAME,
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            { role: 'quit' as const },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'About community shell', click: () => void showAbout() },
        { label: 'Desktop settings', accelerator: 'CmdOrCtrl+,', click: () => void showSettings() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Host',
      submenu: [
        { label: 'Restart official dsh web', accelerator: 'CmdOrCtrl+Shift+R', click: () => void restartOfficial().catch(showStartFailure) },
        { label: 'Show official UI', accelerator: 'CmdOrCtrl+Shift+O', click: () => {
          if (origin !== '') void showOfficial(origin)
        } },
        { label: 'Official sessions', accelerator: 'CmdOrCtrl+Shift+S', click: () => void showOfficialSessions() },
        { label: 'Host log', accelerator: 'CmdOrCtrl+Shift+L', click: () => void showDiagnostics() },
        { type: 'separator' },
        { label: 'Runtime / Version Manager', click: () => void showRuntime() },
        { label: 'Pin latest-tested', click: () => pinLatestTested() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
  ]))
}

function bindIpc(): void {
  ipcMain.handle(LIFECYCLE_IPC.restartHost, async () => {
    await restartOfficial()
  })
  ipcMain.handle(LIFECYCLE_IPC.snapshot, () => host?.snapshot() ?? { phase: 'idle', generation: 0 })
  ipcMain.handle(LIFECYCLE_IPC.diagnostics, () => host?.logs() ?? '')
  ipcMain.handle(LIFECYCLE_IPC.openOfficial, async () => {
    if (origin !== '') await showOfficial(origin)
  })
  ipcMain.handle(DESKTOP_IPC.copyText, (_event, text: unknown) => copyDesktopText(text))
  ipcMain.handle(DESKTOP_IPC.applySettings, async (_event, patch: unknown) => {
    await applySettings(patch)
  })
  ipcMain.handle(DESKTOP_IPC.showSessions, async () => {
    await showOfficialSessions()
  })
  ipcMain.handle(DESKTOP_IPC.showSettings, async () => {
    await showSettings()
  })
  ipcMain.handle(DESKTOP_IPC.showDiagnostics, async () => {
    await showDiagnostics()
  })
  ipcMain.handle(DESKTOP_IPC.showRuntime, async () => {
    await showRuntime()
  })
  ipcMain.handle(DESKTOP_IPC.showAbout, async () => {
    await showAbout()
  })
}

async function boot(): Promise<void> {
  const paths = launchPaths()
  assertHostLaunchPaths(paths)
  const install = resolveOfficialDsh({ from: import.meta.url })
  const loaded = loadDesktopState(install.version)
  settings = loaded.settings
  catalog = loaded.catalog
  persistCatalog()
  writeJsonFile(desktopLayout().desktopSettings, settings)

  const layout = desktopLayout()
  host = createOfficialHost({
    spawn: () => {
      const next = launchPaths()
      assertHostLaunchPaths(next)
      return spawnOfficialWeb({
        nodeExecutable: next.nodeExecutable,
        cliEntry: next.cliEntry,
        cwd: next.cwd,
        env: next.env,
        bind: { host: '127.0.0.1', port: 0 },
        electronRunAsNode: next.electronRunAsNode,
      })
    },
    onLog: (chunk) => {
      process.stderr.write(chunk)
      appendHostDiagnostics(layout.logs, chunk)
    },
  })

  host.onChange((snapshot) => {
    if (snapshot.phase !== 'failed') return
    if (decideHostCrash(quitting) === 'ignore') return
    void showHtml(renderErrorPage(snapshot.error))
  })

  tray = createTray()
  window = createDesktopWindow({
    preloadPath: preloadPathFromMain(MAIN_DIR),
    getOrigin: () => origin,
    bounds: loaded.bounds ?? DEFAULT_WINDOW_STATE,
  })
  officialView = createOfficialWebView(() => origin)
  attachOfficialWebView(window, officialView)
  layoutOfficial()
  window.setTitle(WINDOW_TITLE)
  window.on('resize', () => {
    persistWindowState()
    layoutOfficial()
  })
  window.on('move', () => persistWindowState())
  window.on('close', (event) => {
    persistWindowState()
    if (decideWindowClose({
      quitting,
      trayAvailable: trayAvailable() && settings.hideToTray,
    }) === 'hide') {
      event.preventDefault()
      window?.hide()
    }
  })
  window.on('closed', () => {
    officialView = undefined
    window = undefined
    showingOfficial = false
    if (!quitting && decideWindowClose({
      quitting,
      trayAvailable: trayAvailable() && settings.hideToTray,
    }) === 'quit') {
      app.quit()
    }
  })

  try {
    await startOfficial()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await showHtml(renderErrorPage(`${message}\n\nofficial ${install.packageName}@${install.version}`))
  }
}

app.setName(COMMUNITY_PRODUCT_NAME)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => revealWindow())
  app.on('activate', () => revealWindow())
  app.on('window-all-closed', () => {
    if (decideWindowClose({
      quitting,
      trayAvailable: trayAvailable() && settings.hideToTray,
    }) === 'quit') {
      app.quit()
    }
  })
  app.on('before-quit', (event) => {
    persistWindowState()
    if (quitting || host === undefined) {
      quitting = true
      return
    }
    event.preventDefault()
    quitting = true
    void host.shutdown().finally(() => {
      app.quit()
    })
  })
  void app.whenReady().then(() => {
    hardenSession()
    installMenu()
    bindIpc()
    return boot()
  })
}
