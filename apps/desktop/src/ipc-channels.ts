/**
 * Lifecycle IPC only.
 *
 * Allowed: restart, snapshot (pid/port/phase), diagnostics logs, show official UI.
 * Forbidden: agent-running, tool-start, session-changed, approval-request
 * as Desktop channels. Those belong to official HTTP / session/event.
 */
export const LIFECYCLE_IPC = {
  restartHost: 'dsh:lifecycle:restart',
  snapshot: 'dsh:lifecycle:snapshot',
  diagnostics: 'dsh:lifecycle:diagnostics',
  openOfficial: 'dsh:lifecycle:open-official',
} as const

export const IPC = LIFECYCLE_IPC

export const LIFECYCLE_IPC_KEYS = [
  'dsh:lifecycle:restart',
  'dsh:lifecycle:snapshot',
  'dsh:lifecycle:diagnostics',
  'dsh:lifecycle:open-official',
] as const
