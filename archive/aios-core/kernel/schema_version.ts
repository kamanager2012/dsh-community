// AIOS Core — Event Schema Versioning.
//
// Every audit entry carries a schema version. This enables:
//   1. Backward-compatible replay of old audit logs
//   2. Forward-compatible migration when schema evolves
//   3. Explicit version negotiation between components
//
// Current version: 1
// Version rules:
//   - Breaking changes (field removed/renamed) → major version bump
//   - Additive changes (new optional field) → minor version bump
//   - Migrations transform v(N) → v(N+1) entries

export const CURRENT_SCHEMA_VERSION = 1;

export interface VersionedEntry {
  _v?: number;
  [key: string]: unknown;
}

// ── Migrations ─────────────────────────────────────────────────────────────
// Each migration transforms entries from version N to version N+1.
// Migrations are pure functions: entry → entry.

type Migration = (entry: VersionedEntry) => VersionedEntry;

const MIGRATIONS = new Map<number, Migration>();

// ── Upgrade entry to current version ───────────────────────────────────────

export function upgradeEntry(entry: VersionedEntry): VersionedEntry {
  let current = { ...entry };
  let version = current._v ?? 0;

  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = MIGRATIONS.get(version);
    if (!migration) {
      // No migration path — return as-is with current version stamp
      current._v = CURRENT_SCHEMA_VERSION;
      break;
    }
    current = migration(current);
    version = current._v ?? 0;
  }

  return current;
}

// ── Stamp a new entry with current version ─────────────────────────────────

export function stampEntry<T extends Record<string, unknown>>(entry: T): T & { _v: number } {
  return { ...entry, _v: CURRENT_SCHEMA_VERSION };
}

// ── Validate entry version ────────────────────────────────────────────────

export function validateEntryVersion(entry: VersionedEntry): {
  valid: boolean;
  version: number;
  needsMigration: boolean;
} {
  const version = entry._v ?? 0;
  return {
    valid: version <= CURRENT_SCHEMA_VERSION,
    version,
    needsMigration: version < CURRENT_SCHEMA_VERSION,
  };
}
