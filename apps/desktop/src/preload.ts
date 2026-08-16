import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_IPC, LIFECYCLE_IPC } from './ipc-channels.ts'

contextBridge.exposeInMainWorld('dshCommunity', {
  restartHost: () => ipcRenderer.invoke(LIFECYCLE_IPC.restartHost),
  hostSnapshot: () => ipcRenderer.invoke(LIFECYCLE_IPC.snapshot),
  hostLogs: () => ipcRenderer.invoke(LIFECYCLE_IPC.diagnostics),
  openOfficial: () => ipcRenderer.invoke(LIFECYCLE_IPC.openOfficial),
  refreshMarketplace: () => ipcRenderer.invoke(LIFECYCLE_IPC.refreshMarketplace),
  copyText: (text: string) => ipcRenderer.invoke(DESKTOP_IPC.copyText, text),
  applySettings: (patch: { hideToTray?: boolean; isolated?: boolean }) =>
    ipcRenderer.invoke(DESKTOP_IPC.applySettings, patch),
  showSessions: () => ipcRenderer.invoke(DESKTOP_IPC.showSessions),
  showMarketplace: () => ipcRenderer.invoke(DESKTOP_IPC.showMarketplace),
  showSettings: () => ipcRenderer.invoke(DESKTOP_IPC.showSettings),
  showDiagnostics: () => ipcRenderer.invoke(DESKTOP_IPC.showDiagnostics),
  showRuntime: () => ipcRenderer.invoke(DESKTOP_IPC.showRuntime),
  showAbout: () => ipcRenderer.invoke(DESKTOP_IPC.showAbout),
})
