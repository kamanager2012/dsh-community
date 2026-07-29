// governor-core — Policy loader. Pure config I/O; no runtime deps.

import { readFile } from "node:fs/promises";
import { ScopeValidator, DEFAULT_POLICY, type ScopePolicy } from "./scope.js";

export type PolicyLoadResult =
  | { ok: true; policy: ScopePolicy; source: string; loadedAt: string }
  | { ok: false; error: string };

export async function loadPolicy(path: string, now: () => string): Promise<PolicyLoadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    return { ok: false, error: `cannot read policy file: ${err instanceof Error ? err.message : String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `policy file is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const validation = validatePolicy(parsed);
  if (!validation.ok) return { ok: false, error: validation.error };
  return { ok: true, policy: validation.policy, source: path, loadedAt: now() };
}

export function validatePolicy(value: unknown):
  | { ok: true; policy: ScopePolicy }
  | { ok: false; error: string } {
  if (value === null || typeof value !== "object") {
    return { ok: false, error: "policy must be an object" };
  }
  const v = value as Record<string, unknown>;
  for (const key of ["allowedPaths", "deniedPaths", "allowedCommands", "deniedCommands"] as const) {
    if (!Array.isArray(v[key])) {
      return { ok: false, error: `policy.${key} must be an array of strings` };
    }
    if (!(v[key] as unknown[]).every((x) => typeof x === "string")) {
      return { ok: false, error: `policy.${key} must contain only strings` };
    }
  }
  // elevatedCommands is optional; when present it must be a string array.
  if (v.elevatedCommands !== undefined) {
    if (!Array.isArray(v.elevatedCommands) || !v.elevatedCommands.every((x) => typeof x === "string")) {
      return { ok: false, error: "policy.elevatedCommands must be an array of strings" };
    }
  }
  const policy: ScopePolicy = {
    allowedPaths: v.allowedPaths as string[],
    deniedPaths: v.deniedPaths as string[],
    allowedCommands: v.allowedCommands as string[],
    deniedCommands: v.deniedCommands as string[],
  };
  if (v.elevatedCommands !== undefined) policy.elevatedCommands = v.elevatedCommands as string[];
  return { ok: true, policy };
}

/** Merge: project policy overrides default at the field level (full replace, not concat). */
export function mergeWithDefault(p: ScopePolicy): ScopePolicy {
  return {
    allowedPaths: p.allowedPaths.length > 0 ? p.allowedPaths : DEFAULT_POLICY.allowedPaths,
    deniedPaths: p.deniedPaths.length > 0 ? p.deniedPaths : DEFAULT_POLICY.deniedPaths,
    allowedCommands: p.allowedCommands.length > 0 ? p.allowedCommands : DEFAULT_POLICY.allowedCommands,
    deniedCommands: p.deniedCommands.length > 0 ? p.deniedCommands : DEFAULT_POLICY.deniedCommands,
    // Use the project value verbatim when defined so an explicit [] disables
    // escalation; fall back to the default only when the field is omitted.
    elevatedCommands: p.elevatedCommands ?? DEFAULT_POLICY.elevatedCommands,
  };
}

export function makeValidator(p: ScopePolicy): ScopeValidator {
  return new ScopeValidator(p);
}
