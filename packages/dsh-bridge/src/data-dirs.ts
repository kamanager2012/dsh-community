import { join } from 'node:path'

/** Official env and default directory name. Desktop must not invent another. */
export const OFFICIAL_DSH_HOME_ENV = 'DSH_HOME'
export const OFFICIAL_DSH_HOME_DIR = '.dsh'

/** Opt-in only. Default is to share the official home with TUI and Web. */
export const ISOLATED_DESKTOP_ENV = 'DSH_COMMUNITY_ISOLATED'

export function resolveOfficialDshHome(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string,
): string {
  const fromEnv = env[OFFICIAL_DSH_HOME_ENV]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv
  return join(homedir, OFFICIAL_DSH_HOME_DIR)
}

export interface DesktopAppLayout {
  readonly root: string
  readonly runtimeVersions: string
  readonly desktopSettings: string
  readonly windowState: string
  readonly updateCache: string
  readonly logs: string
  readonly crashReports: string
  readonly isolatedOfficialHome: string
}

/** Electron userData (or equivalent). Never used as DSH_HOME by default. */
export function resolveDesktopAppLayout(userData: string): DesktopAppLayout {
  return {
    root: userData,
    runtimeVersions: join(userData, 'runtime-versions.json'),
    desktopSettings: join(userData, 'desktop-settings.json'),
    windowState: join(userData, 'window-state.json'),
    updateCache: join(userData, 'update-cache'),
    logs: join(userData, 'logs'),
    crashReports: join(userData, 'crash-reports'),
    isolatedOfficialHome: join(userData, 'isolated-dsh'),
  }
}

export function isolatedDesktopRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ISOLATED_DESKTOP_ENV] === '1'
}

/**
 * Env for the official child. Default: pass DSH_HOME through so TUI / Web /
 * Desktop see the same session store. Isolated mode is explicit.
 */
export function hostProcessEnv(input: {
  readonly env: NodeJS.ProcessEnv
  readonly homedir: string
  readonly desktopUserData: string
}): NodeJS.ProcessEnv {
  if (!isolatedDesktopRequested(input.env)) {
    return { ...input.env }
  }
  const layout = resolveDesktopAppLayout(input.desktopUserData)
  return {
    ...input.env,
    [OFFICIAL_DSH_HOME_ENV]: layout.isolatedOfficialHome,
  }
}
