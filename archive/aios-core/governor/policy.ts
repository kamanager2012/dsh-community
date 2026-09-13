// AIOS Core — Canonical policy schema and normalization.
//
// Pure data semantics only: no agent runtime, no sandbox, no filesystem IO.
// Vendor adapters may compile/translate this normalized policy into their own
// native permission representation. ScopeValidator consumes the same shape.

export interface CanonicalPolicy {
  allowedPaths: string[];
  deniedPaths: string[];
  allowedCommands: string[];
  deniedCommands: string[];
  deniedFileTypes: string[];
  /** Commands that are scope-valid but represent general-purpose execution.
   * Adapters may translate these to a native "ask"/approval policy. */
  elevatedCommands?: string[];
  /** Optional policy hints for vendor adapters that support approval rules. */
  askPaths?: string[];
  askCommands?: string[];
}

export type PolicyValidationResult =
  | { ok: true; policy: CanonicalPolicy }
  | { ok: false; error: string };

const REQUIRED_ARRAY_FIELDS = [
  "allowedPaths",
  "deniedPaths",
  "allowedCommands",
  "deniedCommands",
  "deniedFileTypes",
] as const;

const OPTIONAL_ARRAY_FIELDS = [
  "elevatedCommands",
  "askPaths",
  "askCommands",
] as const;

function readStringArray(
  value: Record<string, unknown>,
  key: string,
  required: boolean,
): { ok: true; value: string[] | undefined } | { ok: false; error: string } {
  const raw = value[key];
  if (raw === undefined && !required) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: `policy.${key} must be an array of strings` };
  if (!raw.every((item) => typeof item === "string")) {
    return { ok: false, error: `policy.${key} must contain only strings` };
  }
  return { ok: true, value: raw as string[] };
}

/** Strictly validate a serialized canonical policy. Unknown fields are ignored
 * for forward compatibility; required semantic fields may not be omitted. */
export function validatePolicy(value: unknown): PolicyValidationResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "policy must be an object" };
  }

  const source = value as Record<string, unknown>;
  const arrays: Record<string, string[] | undefined> = {};

  for (const key of REQUIRED_ARRAY_FIELDS) {
    const result = readStringArray(source, key, true);
    if (!result.ok) return result;
    arrays[key] = result.value;
  }
  for (const key of OPTIONAL_ARRAY_FIELDS) {
    const result = readStringArray(source, key, false);
    if (!result.ok) return result;
    arrays[key] = result.value;
  }

  const policy: CanonicalPolicy = {
    allowedPaths: arrays.allowedPaths!,
    deniedPaths: arrays.deniedPaths!,
    allowedCommands: arrays.allowedCommands!,
    deniedCommands: arrays.deniedCommands!,
    deniedFileTypes: arrays.deniedFileTypes!,
  };
  if (arrays.elevatedCommands !== undefined) policy.elevatedCommands = arrays.elevatedCommands;
  if (arrays.askPaths !== undefined) policy.askPaths = arrays.askPaths;
  if (arrays.askCommands !== undefined) policy.askCommands = arrays.askCommands;
  return { ok: true, policy };
}

function normalizeList(values: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

/** Deterministic normalization. It never adds defaults and never changes a
 * policy decision by turning an explicit empty list into a fallback value. */
export function normalizePolicy(policy: CanonicalPolicy): CanonicalPolicy {
  const normalized: CanonicalPolicy = {
    allowedPaths: normalizeList(policy.allowedPaths),
    deniedPaths: normalizeList(policy.deniedPaths),
    allowedCommands: normalizeList(policy.allowedCommands),
    deniedCommands: normalizeList(policy.deniedCommands),
    deniedFileTypes: normalizeList(policy.deniedFileTypes),
  };
  if (policy.elevatedCommands !== undefined) {
    normalized.elevatedCommands = normalizeList(policy.elevatedCommands);
  }
  if (policy.askPaths !== undefined) normalized.askPaths = normalizeList(policy.askPaths);
  if (policy.askCommands !== undefined) normalized.askCommands = normalizeList(policy.askCommands);
  return normalized;
}

/** Field-level overlay with explicit-empty semantics: when an override field is
 * provided, even `[]`, it replaces the base field. This avoids the common bug
 * where an intentionally empty allow/ask list silently falls back to defaults. */
export function overlayPolicy(
  base: CanonicalPolicy,
  override: Partial<CanonicalPolicy>,
): CanonicalPolicy {
  const merged: CanonicalPolicy = {
    allowedPaths: override.allowedPaths ?? base.allowedPaths,
    deniedPaths: override.deniedPaths ?? base.deniedPaths,
    allowedCommands: override.allowedCommands ?? base.allowedCommands,
    deniedCommands: override.deniedCommands ?? base.deniedCommands,
    deniedFileTypes: override.deniedFileTypes ?? base.deniedFileTypes,
  };

  const elevatedCommands = override.elevatedCommands ?? base.elevatedCommands;
  const askPaths = override.askPaths ?? base.askPaths;
  const askCommands = override.askCommands ?? base.askCommands;
  if (elevatedCommands !== undefined) merged.elevatedCommands = elevatedCommands;
  if (askPaths !== undefined) merged.askPaths = askPaths;
  if (askCommands !== undefined) merged.askCommands = askCommands;

  return normalizePolicy(merged);
}
