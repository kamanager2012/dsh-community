// governor-core — shared types.
//
// Lifted from AIOS 9.0 kernel/schema/index.ts (the kernel<->governor contract),
// decoupled here so the governance engine has zero dependency on any agent runtime.

import type { ExecutionIdentity } from "./types/identity.js";
export type { ExecutionIdentity } from "./types/identity.js";

// ── Governance decision surface (the agent-agnostic contract) ───────────────

/** A normalized tool invocation. Adapters (Claude Code hook, MCP gateway, ...)
 *  translate their native payloads into this shape. */
export interface ToolCall {
  /** Normalized tool name, e.g. "Bash" | "Write" | "Edit" | "Read". */
  tool: string;
  /** Full command line for shell-type tools. */
  command?: string;
  /** Target file path for file-type tools. */
  file?: string;
  /** Original adapter payload, kept verbatim for the audit trail. */
  raw?: unknown;
  /** Execution provenance (who/which run/attempt). Optional: standalone
   *  adapters may omit it; recorded into the audit chain when present. Does not
   *  influence the verdict in v0.1. */
  identity?: ExecutionIdentity;
}

export type Decision = "allow" | "deny" | "ask";

export interface Verdict {
  decision: Decision;
  /** Human-readable justification, surfaced to the agent and the audit log. */
  reason: string;
  /** Which rule/branch produced this verdict. */
  ruleId?: string;
  /** Present when decision is "ask": id the human uses to grant approval. */
  pendingId?: string;
}

// ── Types lifted from the 9.0 kernel schema ─────────────────────────────────

export type Risk = "low" | "medium" | "high";

export interface PlanStep {
  order: number;
  action: string;
  target: string;
}

export interface Plan {
  task: string;
  scope: string[];
  risk: Risk;
  files: string[];
  steps: PlanStep[];
  tests: string[];
  rollback: string;
  createdAt: string;
  frozen: boolean;
}

export interface ApprovalToken {
  planId: string;
  approvedBy: string;
  approvedAt: string;
  scope: string[];
  level: "L1" | "L2" | "L3";
}

/** Audit "mode" — governance phase a record belongs to. Kept as a superset of
 *  the 9.0 Mode plus the interception verdicts this tool emits. */
export type Mode =
  | "DISCOVER"
  | "PLAN"
  | "APPROVE"
  | "EXECUTE"
  | "VERIFY"
  | "COMMIT"
  | "ROLLBACK"
  | "INCIDENT"
  | "INTERCEPT";

export interface AuditEvent {
  mode: Mode;
  planId?: string;
  actor: string;
  action: string;
  reason?: string;
  /** Execution provenance snapshot for this decision. Part of the hashed
   *  payload, so tampering with it breaks the chain. */
  identity?: ExecutionIdentity;
  timestamp: string;
}
