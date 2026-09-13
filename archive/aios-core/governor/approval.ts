// AIOS Core — Approval gateway.
// Per Charter §8: AUTO (risk ≤ threshold) vs MANUAL (human decides).
// v1.1: ACS-aware. AcsClient is synchronous (reads JSON files).
// MANUAL decisions are flagged in audit.
// AUTO decisions are logged to both AIOS audit and ACS audit trail.

import type { Plan, Approval } from "../kernel/schema/index.js";
import type { AcsClient } from "./acs_client.js";

export interface ApprovalConfig {
  autoThreshold: number;
  protectedPaths: string[];
}

export const DEFAULT_APPROVAL_CONFIG: ApprovalConfig = {
  autoThreshold: 50,
  protectedPaths: [".env", "secrets/", ".claude/", "CLAUDE.md"],
};

export interface ApprovalResult {
  approved: boolean;
  level: Approval;
  reason: string;
  acsLocked: boolean;
}

/** Infer approval level from plan characteristics. */
export function inferApproval(plan: Plan): Approval {
  if (plan.risk === "high") return "MANUAL";
  if (plan.risk === "medium") return "MANUAL";
  if (plan.files.some((f) => isConfigFile(f) || isDestructiveAction(plan))) return "MANUAL";
  return "AUTO";
}

function isConfigFile(path: string): boolean {
  const configPatterns = ["package.json", "tsconfig", ".eslintrc", "vitest.config", "docker-compose", "Dockerfile", ".github"];
  return configPatterns.some((p) => path.includes(p));
}

function isDestructiveAction(plan: Plan): boolean {
  return plan.steps.some((s) => s.action === "delete" || s.action === "migrate");
}

// Template/sample suffixes never hold real secrets — `.env.example` must not
// be treated as `.env` (a substring match would, e.g. `.env.in.example`).
const TEMPLATE_SUFFIXES = [".example", ".template", ".sample", ".in"];

/** Segment-level protected-path match.
 *  - `secrets/` matches the `secrets` path segment (directory).
 *  - `.env` matches the `.env` segment or dotted variants like
 *    `.env.production`/`.env.local` — real env files — but not
 *    template/sample names like `.env.example`. */
function matchesProtectedPath(file: string, pattern: string): boolean {
  const pat = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  return file.split("/").some((seg) => {
    if (seg === pat) return true;
    if (!pat.startsWith(".") || !seg.startsWith(pat + ".")) return false;
    return !TEMPLATE_SUFFIXES.some((s) => seg.endsWith(s));
  });
}

function touchesProtectedPath(files: string[]): boolean {
  return files.some((f) => DEFAULT_APPROVAL_CONFIG.protectedPaths.some((p) => matchesProtectedPath(f, p)));
}

/** Effective approval level for a plan.
 *  Protected-path plans (config/secret-adjacent files) may NOT be
 *  self-approved via `approval: AUTO` in the model's YAML — they are forced
 *  to MANUAL regardless of what the model requested. */
export function effectiveApproval(plan: Plan): Approval {
  const touchesProtected = touchesProtectedPath(plan.files);
  if (touchesProtected && plan.approval === "AUTO") return "MANUAL";
  return plan.approval;
}

/** ACS-aware approval check (synchronous).
 *  Returns approved=true for AUTO plans (unless ACS is locked).
 *  Returns approved=false for MANUAL plans that need human confirmation. */
export function checkApprovalWithAcs(
  plan: Plan,
  acs?: AcsClient,
  askHuman?: (plan: Plan) => boolean,
): ApprovalResult {
  const acsLocked = acs ? acs.isLocked() : false;

  if (acsLocked) {
    return {
      approved: false,
      level: "MANUAL",
      reason: "ACS is locked — all operations denied until unlocked",
      acsLocked: true,
    };
  }

  // Check protected paths
  const touchesProtected = touchesProtectedPath(plan.files);
  if (touchesProtected && plan.approval === "AUTO") {
    return {
      approved: false,
      level: "MANUAL",
      reason: "plan touches protected paths — overrides AUTO to MANUAL",
      acsLocked: false,
    };
  }

  if (plan.approval === "AUTO") {
    return { approved: true, level: "AUTO", reason: "auto-approved", acsLocked: false };
  }

  // MANUAL — need human
  if (!askHuman) {
    return { approved: false, level: "MANUAL", reason: "manual approval required but no askHuman provided", acsLocked: false };
  }

  const confirmed = askHuman(plan);
  return {
    approved: confirmed,
    level: "MANUAL",
    reason: confirmed ? "human approved" : "human denied",
    acsLocked: false,
  };
}

/** Original checkApproval (backward compatible, no ACS). */
export function checkApproval(
  plan: Plan,
  askHuman?: (plan: Plan) => boolean,
): { ok: boolean; reason?: string } {
  if (plan.approval === "AUTO") return { ok: true };
  if (!askHuman) return { ok: false, reason: "manual approval required but no askHuman provided" };
  const confirmed = askHuman(plan);
  if (!confirmed) return { ok: false, reason: "manual approval denied" };
  return { ok: true };
}
