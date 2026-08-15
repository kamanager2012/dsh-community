export interface DesktopSettings {
  readonly hideToTray: boolean
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  hideToTray: true,
}

export function parseDesktopSettings(raw: unknown): DesktopSettings {
  if (raw === null || typeof raw !== 'object') return DEFAULT_DESKTOP_SETTINGS
  const value = raw as Record<string, unknown>
  return {
    hideToTray: value.hideToTray !== false,
  }
}
