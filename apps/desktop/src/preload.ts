import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from './ipc-channels.ts'

contextBridge.exposeInMainWorld('dshCommunity', {
  restartHost: () => ipcRenderer.invoke(IPC.restartHost),
  hostSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  hostLogs: () => ipcRenderer.invoke(IPC.diagnostics),
  openOfficial: () => ipcRenderer.invoke(IPC.openOfficial),
})
