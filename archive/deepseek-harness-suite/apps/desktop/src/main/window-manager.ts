import { BrowserWindow, shell, ipcMain } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ConfigStore } from './config-store.js';
import { sanitizeConfigUpdates, stripSecrets } from './config-sanitizer.js';
import { type DshSubprocessManager, DshSharedSessionStore } from '@dsh-community/dsh-bridge';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getRendererAsset(filename: string): string {
  const distCandidate = path.join(__dirname, '../renderer', filename);
  if (fs.existsSync(distCandidate)) return distCandidate;
  return path.join(__dirname, '../../src/renderer', filename);
}

export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private configStore: ConfigStore;
  private runtimeManager: DshSubprocessManager;

  constructor(configStore: ConfigStore, runtimeManager: DshSubprocessManager) {
    this.configStore = configStore;
    this.runtimeManager = runtimeManager;
    this.setupIpc();
  }

  private setupIpc(): void {
    ipcMain.handle('get-config', () => stripSecrets(this.configStore.get()));
    ipcMain.handle('save-config', (_, updates) => {
      this.configStore.save(sanitizeConfigUpdates(updates));
      this.runtimeManager.restart();
      this.loadDshWebUi();
      return true;
    });
    ipcMain.handle('get-runtime-health', () => this.runtimeManager.getHealth());
    ipcMain.handle('get-runtime-logs', () => this.runtimeManager.getLogs());
    ipcMain.handle('list-sessions', () => {
      const store = new DshSharedSessionStore();
      return store.listSessions();
    });
  }

  public showMainWindow(): void {
    if (this.mainWindow) {
      if (this.mainWindow.isMinimized()) this.mainWindow.restore();
      this.mainWindow.focus();
      return;
    }

    this.mainWindow = new BrowserWindow({
      width: 1200,
      height: 850,
      minWidth: 800,
      minHeight: 600,
      title: 'DeepSeek Harness Desktop',
      backgroundColor: '#121212',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: getRendererAsset('preload.js'),
      },
    });

    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const parsed = new URL(url);
        if (['http:', 'https:'].includes(parsed.protocol)) {
          shell.openExternal(url);
        }
      } catch {}
      return { action: 'deny' };
    });

    if (this.configStore.isFirstRun()) {
      this.loadSetupWizard();
    } else {
      this.loadDshWebUi();
    }

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });
  }

  public loadSetupWizard(): void {
    if (!this.mainWindow) return;
    const wizardHtml = getRendererAsset('index.html');
    this.mainWindow.loadFile(wizardHtml);
  }

  public loadDshWebUi(): void {
    if (!this.mainWindow) return;
    const health = this.runtimeManager.getHealth();
    const targetUrl = health.url || `http://127.0.0.1:${this.configStore.get().port || 3080}`;
    this.mainWindow.loadURL(targetUrl).catch((err) => {
      console.warn(`Failed to load ${targetUrl}, loading fallback wizard:`, err.message);
      this.loadSetupWizard();
    });
  }

  public destroy(): void {
    if (this.mainWindow) {
      this.mainWindow.close();
      this.mainWindow = null;
    }
  }
}
