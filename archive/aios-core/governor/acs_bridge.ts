// AIOS Core — ACS Bridge.
// Connects AIOS Governor to ACS runtime state.
//
// Per Charter §9 Stage 1: read-only shadow mode.
// Produces a 4-way decision matrix comparing AIOS decisions with ACS state.
// This enables offline comparison without calling ACS's write interface.
//
// 4-way matrix (from 9.0 system report §七):
//
//   |                | ACS Allow | ACS Deny |
//   |----------------|-----------|----------|
//   | AIOS Allow     | SAFE_ALLOW| RISK_ALLOW|
//   | AIOS Deny      | SAFE_DENY | RISK_DENY |
//
// SAFE_ALLOW = both agree → proceed
// RISK_ALLOW = AIOS allows but ACS would deny → flag for review
// SAFE_DENY  = AIOS denies (ACS irrelevant) → blocked by AIOS
// RISK_DENY  = both deny → blocked

import type { Plan, Decision } from "../kernel/schema/index.js";
import { AcsClient } from "./acs_client.js";
import { ACS_DENIED_PATHS } from "./scope.js";

// ── 4-way matrix ───────────────────────────────────────────────────────────

export type MatrixVerdict = "SAFE_ALLOW" | "RISK_ALLOW" | "SAFE_DENY" | "RISK_DENY";

export interface MatrixResult {
  verdict: MatrixVerdict;
  aiosDecision: "ALLOW" | "DENY";
  acsDecision: "ALLOW" | "DENY";
  reason: string;
  acsLocked: boolean;
  acsScope: string[];
  violations: { window: number; windowMax: number; total: number; totalMax: number };
}

export interface AcsBridgeResult {
  ok: boolean;
  reason?: string | undefined;
  matrix?: MatrixResult;
  acsStatus?: {
    locked: boolean;
    scope: string[];
    violations: { window: number; total: number };
  };
}

export class AcsBridge {
  private readonly client: AcsClient;

  constructor(client?: AcsClient) {
    this.client = client ?? new AcsClient();
  }

  /** Pre-flight check with 4-way matrix decision.
   *  This is the primary entry point for runtime.ts. */
  preflight(plan: Plan): AcsBridgeResult {
    // Step 1: Determine AIOS decision
    const aiosDenyReason = this.checkAiosRules(plan);
    const aiosDecision: "ALLOW" | "DENY" = aiosDenyReason ? "DENY" : "ALLOW";

    // Step 2: Determine ACS decision
    const acsStatus = this.client.status();
    const acsDenyReason = this.checkAcsRules(plan, acsStatus);
    const acsDecision: "ALLOW" | "DENY" = acsDenyReason ? "DENY" : "ALLOW";

    // Step 3: Compute 4-way matrix
    const verdict = computeVerdict(aiosDecision, acsDecision);
    const reason = aiosDenyReason ?? acsDenyReason ?? "both allow";

    const matrix: MatrixResult = {
      verdict,
      aiosDecision,
      acsDecision,
      reason,
      acsLocked: acsStatus.locked,
      acsScope: acsStatus.dirs,
      violations: {
        window: acsStatus.violations.window,
        windowMax: acsStatus.violations.windowMax,
        total: acsStatus.violations.total,
        totalMax: acsStatus.violations.totalMax,
      },
    };

    // SAFE_ALLOW → ok=true, everything else → ok=false
    const ok = verdict === "SAFE_ALLOW";

    return {
      ok,
      reason: ok ? undefined : reason,
      matrix,
      acsStatus: {
        locked: acsStatus.locked,
        scope: acsStatus.dirs,
        violations: {
          window: acsStatus.violations.window,
          total: acsStatus.violations.total,
        },
      },
    };
  }

  /** Get ACS status for display. */
  status(): {
    locked: boolean;
    scope: string[];
    violations: { window: number; windowMax: number; total: number; totalMax: number };
  } {
    const s = this.client.status();
    return {
      locked: s.locked,
      scope: s.dirs,
      violations: s.violations,
    };
  }

  /** Check if a single path is allowed by ACS. */
  isPathAllowed(filePath: string): boolean {
    return this.client.isPathInScope(filePath);
  }

  // ── AIOS rules (synchronous) ──────────────────────────────────────────

  private checkAiosRules(plan: Plan): string | null {
    // Protected paths
    const protected_ = plan.files.filter((f) => ACS_DENIED_PATHS.some((p) => f.includes(p)));
    if (protected_.length > 0) {
      return `AIOS protected paths: ${protected_.join(", ")}`;
    }

    // Denied file types
    const deniedTypes = [".pem", ".key", ".p12", ".keystore", ".jks"];
    const badTypes = plan.files.filter((f) => deniedTypes.some((ext) => f.endsWith(ext)));
    if (badTypes.length > 0) {
      return `AIOS denied file types: ${badTypes.join(", ")}`;
    }

    return null;
  }

  // ── ACS rules (reads runtime files) ───────────────────────────────────

  private checkAcsRules(plan: Plan, status: ReturnType<AcsClient["status"]>): string | null {
    // ACS locked
    if (status.locked) {
      return "ACS is locked";
    }

    // ACS not installed (no runtime dir): AIOS rules still apply, ACS rules
    // are skipped — aios must keep working standalone.
    if (!status.acsAvailable) {
      return null;
    }

    // ACS scope check — FAIL CLOSED: with no active task scope, ACS baseline
    // is read-only, so every planned write is out of scope. (Previously
    // `dirs.length === 0` skipped enforcement entirely, silently disabling
    // the ACS gate whenever the scope file was missing or unparsed.)
    const outOfScope = plan.files.filter((f) => !status.dirs.some((dir) => f.startsWith(dir)));
    if (outOfScope.length > 0) {
      return `ACS scope violation: ${outOfScope.join(", ")}`;
    }

    // ACS violation pressure
    const pressure = status.violations.window / status.violations.windowMax;
    if (pressure > 0.8) {
      return `ACS violation pressure ${(pressure * 100).toFixed(0)}%`;
    }

    return null;
  }
}

// ── Pure ───────────────────────────────────────────────────────────────────

function computeVerdict(aios: "ALLOW" | "DENY", acs: "ALLOW" | "DENY"): MatrixVerdict {
  if (aios === "ALLOW" && acs === "ALLOW") return "SAFE_ALLOW";
  if (aios === "ALLOW" && acs === "DENY") return "RISK_ALLOW";
  if (aios === "DENY"  && acs === "ALLOW") return "SAFE_DENY";
  return "RISK_DENY"; // both deny
}
