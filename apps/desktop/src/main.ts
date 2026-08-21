/**
 * Community desktop shell. Reconstructs a tray-owned Host lifecycle around
 * the published official CLI. This file does not contain an agent loop.
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
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
  formatCommunityIdentity,
  hostProcessEnv,
  hydrateCatalog,
  isolatedDesktopRequested,
  listOfficialSessions,
  officialSessionRoot,
  parseRuntimeCatalog,
  PINNED_DSH_VERSION,
  pinDefault,
  resolveDesktopAppLayout,
  resolveEffectiveOfficialHome,
  resolveOfficialDsh,
  spawnOfficialWeb,
  type OfficialHost,
  type RuntimeCatalog,
} from '@dsh-community/dsh-bridge'
import { COMMUNITY_APP_ID, COMMUNITY_PRODUCT_NAME, WINDOW_TITLE } from './branding.ts'
import { renderChromePage, type ChromeActive } from './chrome.ts'
import { resolveLatestTestedPath } from './contracts-path.ts'
import { appendHostDiagnostics } from './host-log.ts'

import { readJsonFile, writeJsonFile } from './json-file.ts'
import { DESKTOP_IPC, LIFECYCLE_IPC } from './ipc-channels.ts'
import {
  MARKETPLACE_CATALOG_URL,
  MARKETPLACE_REGISTRY_URL,
  marketplaceSnapshot,
  parseInstalledPluginNames,
  parseMarketplaceCatalog,
  parseMarketplaceSnapshot,
  parsePluginActionRequest,
  pluginActionArgv,
  type MarketplaceSnapshot,
  type PluginAction,
} from './marketplace.ts'
import {
  renderAboutPage,
  renderDiagnosticsPage,
  renderErrorPage,
  renderLoadingPage,
  renderMarketplacePage,
  renderOfficialSessionsPage,
  renderRuntimePage,
  renderSettingsPage,
} from './pages.ts'
import { formatSessionMtime } from './session-view.ts'
import {
  ensureOfficialHostExtracted,
  isOfficialHostReady,
  officialHostArchive,
  officialHostBin,
  officialHostRoot,
} from './host-extract.ts'
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
let marketplace: MarketplaceSnapshot | undefined
let pluginTask: { readonly plugin: string; readonly action: PluginAction } | undefined
let pluginResult: { readonly plugin: string; readonly action: PluginAction; readonly ok: boolean; readonly log: string } | undefined
let pluginChild: ReturnType<typeof spawn> | undefined

const MARKETPLACE_CACHE_TTL_MS = 10 * 60 * 1000
const MARKETPLACE_PROFILE = 'web'

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
  const install = resolveOfficialDsh({ from: import.meta.url })
  return {
    product: COMMUNITY_PRODUCT_NAME,
    identity: formatCommunityIdentity(install.packageName, install.version),
    phase: snap?.phase ?? 'idle',
    isolated: isolatedNow(),
    origin,
    active,
  }
}

/** A newer page load can abort the previous one; that is normal, not a failure. */
async function loadWindowSafely(url: string): Promise<void> {
  if (window === undefined || window.isDestroyed()) return
  try {
    await window.loadURL(url)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('ERR_ABORTED')) return
    throw error
  }
}

/**
 * The readiness line can appear before the socket accepts connections, and
 * the official web can answer 502 while its backend warms up. Poll briefly
 * so the view does not land on ERR_CONNECTION_REFUSED.
 */
async function waitForOfficialWeb(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) })
      if (response.status < 500) return
    } catch {
      // not listening yet
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
  }
}

async function showHtml(html: string): Promise<void> {
  if (window === undefined || window.isDestroyed()) return
  showingOfficial = false
  layoutOfficial()
  await loadWindowSafely(dataUrl(html))
  if (!window.isVisible() && !quitting) window.show()
}

async function showOfficial(nextOrigin: string): Promise<void> {
  if (window === undefined || window.isDestroyed() || officialView === undefined) return
  origin = nextOrigin
  showingOfficial = true
  await loadWindowSafely(dataUrl(renderChromePage(chromeModel('official'))))
  const current = officialView.webContents.getURL()
  if (current !== nextOrigin && !current.startsWith(`${nextOrigin}/`)) {
    try {
      await officialView.webContents.loadURL(nextOrigin)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('ERR_ABORTED')) throw error
    }
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
    identity: formatCommunityIdentity(install.packageName, install.version),
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

function marketplaceCachePath(): string {
  return join(desktopLayout().root, 'marketplace-catalog.json')
}

function marketplaceModel() {
  const snapshot = marketplace
  return {
    product: COMMUNITY_PRODUCT_NAME,
    ...(snapshot?.catalog === undefined ? {} : { catalog: snapshot.catalog }),
    source: snapshot?.source ?? 'none',
    fetchedAt: snapshot?.fetchedAt ?? '',
    ...(snapshot?.error === undefined ? {} : { error: snapshot.error }),
    registryUrl: MARKETPLACE_REGISTRY_URL,
    installed: installedPluginNames(),
    profile: MARKETPLACE_PROFILE,
    ...(pluginTask === undefined ? {} : { busy: pluginTask }),
    ...(pluginResult === undefined ? {} : { result: pluginResult }),
  }
}

/** Installed names in the official web profile. No second store. */
function installedPluginNames(): readonly string[] {
  const profilePackage = join(officialHome(), 'profiles', MARKETPLACE_PROFILE, 'package.json')
  return parseInstalledPluginNames(readJsonFile(profilePackage))
}

async function runPluginAction(request: { name: string; action: PluginAction }): Promise<void> {
  if (pluginTask !== undefined || quitting) return
  const known = (marketplace?.catalog?.plugins ?? []).some((plugin) => plugin.name === request.name)
  if (!known) return
  pluginTask = { plugin: request.name, action: request.action }
  pluginResult = undefined
  await showHtml(renderMarketplacePage(marketplaceModel()))
  const paths = launchPaths()
  const install = resolveOfficialDsh({ from: import.meta.url })
  const env = paths.electronRunAsNode
    ? { ...paths.env, ELECTRON_RUN_AS_NODE: '1' }
    : paths.env
  const child = spawn(
    paths.nodeExecutable,
    [install.binPath, ...pluginActionArgv({ profile: MARKETPLACE_PROFILE, action: request.action, name: request.name })],
    {
      cwd: paths.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  pluginChild = child
  const chunks: string[] = []
  child.stdout?.on('data', (chunk: Buffer | string) => chunks.push(chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer | string) => chunks.push(chunk.toString()))
  const finish = (ok: boolean, log: string): void => {
    pluginResult = { plugin: request.name, action: request.action, ok, log }
    pluginTask = undefined
    pluginChild = undefined
    if (!quitting) void showHtml(renderMarketplacePage(marketplaceModel()))
  }
  child.on('error', (error) => finish(false, error.message))
  child.on('exit', (code, signal) => finish(
    code === 0,
    signal === null ? chunks.join('') : `${chunks.join('')}\n终止于 ${signal}`,
  ))
}

async function fetchLiveMarketplace(): Promise<
  { catalog: NonNullable<MarketplaceSnapshot['catalog']>; fetchedAt: string } | undefined
> {
  try {
    const response = await fetch(MARKETPLACE_CATALOG_URL, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return undefined
    const raw: unknown = await response.json()
    const catalog = parseMarketplaceCatalog(raw)
    if (catalog === undefined) return undefined
    return { catalog, fetchedAt: new Date().toISOString() }
  } catch {
    return undefined
  }
}

async function refreshMarketplaceCatalog(force: boolean): Promise<void> {
  const cached = parseMarketplaceSnapshot(readJsonFile(marketplaceCachePath()))
  const cacheFresh = cached !== undefined
    && !Number.isNaN(Date.parse(cached.fetchedAt))
    && Date.now() - Date.parse(cached.fetchedAt) < MARKETPLACE_CACHE_TTL_MS
  if (!force && cacheFresh) {
    marketplace = cached
    return
  }
  const live = await fetchLiveMarketplace()
  if (live !== undefined) {
    marketplace = marketplaceSnapshot({
      catalog: live.catalog,
      source: 'live',
      fetchedAt: live.fetchedAt,
    })
    writeJsonFile(marketplaceCachePath(), marketplace)
    return
  }
  if (cached !== undefined) {
    marketplace = marketplaceSnapshot({
      ...(cached.catalog === undefined ? {} : { catalog: cached.catalog }),
      source: 'cache',
      fetchedAt: cached.fetchedAt,
      error: '在线抓取失败，展示最近一次缓存。',
    })
    return
  }
  marketplace = marketplaceSnapshot({
    source: 'none',
    fetchedAt: new Date().toISOString(),
    error: `无法抓取目录:${MARKETPLACE_CATALOG_URL}`,
  })
}

async function showMarketplace(force = false): Promise<void> {
  await refreshMarketplaceCatalog(force)
  await showHtml(renderMarketplacePage(marketplaceModel()))
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
  await waitForOfficialWeb(next, 8_000)
  await showOfficial(next)
}

async function restartOfficial(then: 'official' | 'settings' = 'official'): Promise<void> {
  if (host === undefined) throw new Error('official host is not created')
  await showHtml(renderLoadingPage())
  const next = await host.restart()
  origin = next
  await waitForOfficialWeb(next, 8_000)
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
      { label: '社区市场', click: () => void showMarketplace() },
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
        { label: 'Community marketplace', accelerator: 'CmdOrCtrl+Shift+M', click: () => void showMarketplace() },
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
  ipcMain.handle(LIFECYCLE_IPC.refreshMarketplace, async () => {
    await showMarketplace(true)
  })
  ipcMain.handle(DESKTOP_IPC.copyText, (_event, text: unknown) => copyDesktopText(text))
  ipcMain.handle(DESKTOP_IPC.applySettings, async (_event, patch: unknown) => {
    await applySettings(patch)
  })
  ipcMain.handle(DESKTOP_IPC.showSessions, async () => {
    await showOfficialSessions()
  })
  ipcMain.handle(DESKTOP_IPC.showMarketplace, async () => {
    await showMarketplace()
  })
  ipcMain.handle(DESKTOP_IPC.pluginAction, async (_event, raw: unknown) => {
    const request = parsePluginActionRequest(raw)
    if (request === undefined) return
    await runPluginAction(request)
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

async function preparePackagedRuntime(): Promise<void> {
  if (!app.isPackaged) return
  const dest = officialHostRoot(app.getPath('userData'), PINNED_DSH_VERSION)
  if (isOfficialHostReady(dest)) {
    process.env.DSH_COMMUNITY_BIN = officialHostBin(dest)
    return
  }
  await showHtml(renderLoadingPage('第一次启动，正在解开官方 Runtime，只做一次。'))
  process.env.DSH_COMMUNITY_BIN = ensureOfficialHostExtracted({
    archivePath: officialHostArchive(process.resourcesPath),
    destRoot: dest,
  })
}

async function boot(): Promise<void> {
  const loaded = loadDesktopState(PINNED_DSH_VERSION)
  settings = loaded.settings
  catalog = loaded.catalog
  persistCatalog()
  writeJsonFile(desktopLayout().desktopSettings, settings)

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
    await preparePackagedRuntime()
    const paths = launchPaths()
    assertHostLaunchPaths(paths)
    const install = resolveOfficialDsh({ from: import.meta.url })
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
          execArgv: next.electronRunAsNode ? ['--expose-internals'] : [],
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
    await startOfficial()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await showHtml(renderErrorPage(message))
  }
}

app.setName(COMMUNITY_PRODUCT_NAME)
if (process.platform === 'win32') {
  app.setAppUserModelId(COMMUNITY_APP_ID)
}

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
    pluginChild?.kill('SIGTERM')
    void host.shutdown().finally(() => {
      app.quit()
    })
  })
  void app.whenReady().then(() => {
    hardenSession()
    installMenu()
    bindIpc()
    return boot()
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`dsh-community desktop failed to boot: ${message}\n`)
    app.quit()
  })
}
