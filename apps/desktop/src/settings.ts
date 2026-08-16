export interface DesktopSettings {
  readonly hideToTray: boolean
  readonly isolated: boolean
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  hideToTray: true,
  isolated: false,
}

export function parseDesktopSettings(raw: unknown): DesktopSettings {
  if (raw === null || typeof raw !== 'object') return DEFAULT_DESKTOP_SETTINGS
  const value = raw as Record<string, unknown>
  return {
    hideToTray: value.hideToTray !== false,
    isolated: value.isolated === true,
  }
}

export function applyDesktopSettingsPatch(
  current: DesktopSettings,
  patch: Partial<DesktopSettings>,
): DesktopSettings {
  return {
    hideToTray: patch.hideToTray ?? current.hideToTray,
    isolated: patch.isolated ?? current.isolated,
  }
}

export function readSettingsPatch(raw: unknown): Partial<DesktopSettings> {
  if (raw === null || typeof raw !== 'object') return {}
  const value = raw as Record<string, unknown>
  const patch: { hideToTray?: boolean; isolated?: boolean } = {}
  if (typeof value.hideToTray === 'boolean') patch.hideToTray = value.hideToTray
  if (typeof value.isolated === 'boolean') patch.isolated = value.isolated
  return patch
}
