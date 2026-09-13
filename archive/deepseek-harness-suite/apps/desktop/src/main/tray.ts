import { Tray, Menu, nativeImage, app } from 'electron';
import type { DshSubprocessManager } from '@dsh-community/dsh-bridge';

export interface TrayCallbacks {
  onOpenWindow: () => void;
  onOpenPreferences: () => void;
  onRestartRuntime: () => void;
  onOpenLogs: () => void;
}

export class TrayManager {
  private tray: Tray | null = null;
  private callbacks: TrayCallbacks;
  private runtimeManager: DshSubprocessManager;

  constructor(runtimeManager: DshSubprocessManager, callbacks: TrayCallbacks) {
    this.runtimeManager = runtimeManager;
    this.callbacks = callbacks;
  }

  public init(): void {
    // 16x16 dummy image if no icon asset found
    const icon = nativeImage.createEmpty();
    this.tray = new Tray(icon);
    this.tray.setToolTip('DeepSeek Harness Desktop');
    this.updateMenu();

    this.tray.on('double-click', () => {
      this.callbacks.onOpenWindow();
    });
  }

  public updateMenu(): void {
    if (!this.tray) return;

    const health = this.runtimeManager.getHealth();
    const statusLabel = health.running
      ? `🟢 Runtime: Running (Port ${health.port || 3080})`
      : '🔴 Runtime: Stopped';

    const contextMenu = Menu.buildFromTemplate([
      { label: 'DeepSeek Harness Desktop', enabled: false },
      { type: 'separator' },
      { label: statusLabel, enabled: false },
      { label: `Uptime: ${health.uptimeSeconds}s`, enabled: false },
      { type: 'separator' },
      {
        label: 'Open Workspace / Web UI',
        click: () => this.callbacks.onOpenWindow(),
      },
      {
        label: 'Restart Runtime',
        click: () => this.callbacks.onRestartRuntime(),
      },
      {
        label: 'Preferences / Setup...',
        click: () => this.callbacks.onOpenPreferences(),
      },
      {
        label: 'View Runtime Logs',
        click: () => this.callbacks.onOpenLogs(),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => app.quit(),
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  public destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}
