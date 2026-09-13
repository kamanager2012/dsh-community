const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (updates) => ipcRenderer.invoke('save-config', updates),
  getRuntimeHealth: () => ipcRenderer.invoke('get-runtime-health'),
  getRuntimeLogs: () => ipcRenderer.invoke('get-runtime-logs'),
  listSessions: () => ipcRenderer.invoke('list-sessions'),
});
