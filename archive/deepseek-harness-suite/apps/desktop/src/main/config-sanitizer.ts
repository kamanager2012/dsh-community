import type { DshConfig } from '@dsh-community/dsh-bridge';

/**
 * IPC boundary hardening for renderer-supplied config updates.
 *
 * The renderer is untrusted content (it hosts the DSH web UI). Only explicitly
 * safe UI preference keys may be written through `save-config`. Runtime
 * execution settings and network endpoints can never be modified via IPC.
 */

/** Keys the setup wizard/preferences UI is allowed to persist. */
const SAFE_UI_KEYS = [
  'apiKey',
  'model',
  'workspacePath',
  'runtimeVersion',
  'sandboxMode',
] as const satisfies readonly (keyof DshConfig)[];

type SafeUiKey = (typeof SAFE_UI_KEYS)[number];

/** Keys that must never pass through IPC: they enable arbitrary execution or key exfiltration. */
const DENIED_IPC_KEYS: readonly (keyof DshConfig)[] = [
  'runtimeExecutable',
  'runtimeExecutableArgs',
  'baseUrl',
];

const SANDBOX_MODES: readonly string[] = ['strict', 'workspace_only', 'unrestricted'];
const STRING_UI_KEYS: readonly SafeUiKey[] = ['apiKey', 'model', 'workspacePath', 'runtimeVersion'];

export class ConfigUpdateRejectedError extends TypeError {
  constructor(key: string) {
    super(`save-config rejected: "${key}" cannot be modified through IPC.`);
    this.name = 'ConfigUpdateRejectedError';
  }
}

export function sanitizeConfigUpdates(updates: unknown): Partial<DshConfig> {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new TypeError('save-config rejected: updates must be a plain object.');
  }

  const rec = updates as Record<string, unknown>;

  for (const key of DENIED_IPC_KEYS) {
    if (key in rec) {
      throw new ConfigUpdateRejectedError(key);
    }
  }

  const out: Partial<DshConfig> = {};
  for (const key of SAFE_UI_KEYS) {
    if (!(key in rec)) continue;
    const value = rec[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      throw new TypeError(`save-config rejected: "${key}" must be a string.`);
    }
    if (key === 'sandboxMode' && !SANDBOX_MODES.includes(value)) {
      throw new TypeError(`save-config rejected: invalid sandboxMode "${value}".`);
    }
    (out as Record<string, unknown>)[key] = value;
  }

  return out;
}

export function stripSecrets(config: Readonly<DshConfig>): DshConfig {
  const { apiKey: _apiKey, ...rest } = config;
  return rest as DshConfig;
}
