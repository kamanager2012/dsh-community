/**
 * Lifecycle IPC only.
 *
 * Allowed: restart, snapshot (pid/port/phase), diagnostics logs, show official UI,
 * refresh the read-only marketplace catalog view.
 * Forbidden: agent-running, tool-start, session-changed, approval-request
 * as Desktop channels. Those belong to official HTTP / session/event.
 */
export const LIFECYCLE_IPC = {
  restartHost: 'dsh:lifecycle:restart',
  snapshot: 'dsh:lifecycle:snapshot',
  diagnostics: 'dsh:lifecycle:diagnostics',
  openOfficial: 'dsh:lifecycle:open-official',
  refreshMarketplace: 'dsh:lifecycle:marketplace-refresh',
} as const

/** Desktop-owned shell chrome. Not a second harness protocol. */
export const DESKTOP_IPC = {
  copyText: 'dsh:desktop:copy-text',
  applySettings: 'dsh:desktop:apply-settings',
  showSessions: 'dsh:desktop:show-sessions',
  showMarketplace: 'dsh:desktop:show-marketplace',
  showSettings: 'dsh:desktop:show-settings',
  showDiagnostics: 'dsh:desktop:show-diagnostics',
  showRuntime: 'dsh:desktop:show-runtime',
  showAbout: 'dsh:desktop:show-about',
  pluginAction: 'dsh:desktop:plugin-action',
} as const

export const IPC = { ...LIFECYCLE_IPC, ...DESKTOP_IPC }

export const LIFECYCLE_IPC_KEYS = [
  'dsh:lifecycle:restart',
  'dsh:lifecycle:snapshot',
  'dsh:lifecycle:diagnostics',
  'dsh:lifecycle:open-official',
  'dsh:lifecycle:marketplace-refresh',
] as const

export const DESKTOP_IPC_KEYS = [
  'dsh:desktop:copy-text',
  'dsh:desktop:apply-settings',
  'dsh:desktop:show-sessions',
  'dsh:desktop:show-marketplace',
  'dsh:desktop:show-settings',
  'dsh:desktop:show-diagnostics',
  'dsh:desktop:show-runtime',
  'dsh:desktop:show-about',
  'dsh:desktop:plugin-action',
] as const
