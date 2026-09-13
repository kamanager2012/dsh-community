// AIOS Core — Failure Classification Engine.
//
// Industrial redesign: failure is a computable object.
// Every failure is classified into a taxonomy category,
// which determines recovery strategy (retry / escalate / abort).
//
// This module is a pure function: FailureInput → FailureRecord.

import type { Phase, FailureCategory, FailureRecord } from "./schema/index.js";

// ── Classification rules ───────────────────────────────────────────────────
// Order matters: first match wins. More specific rules first.

interface ClassificationRule {
  category: FailureCategory;
  match: (input: FailureInput) => boolean;
  recoverable: boolean;
  maxRetries: number;
}

export interface FailureInput {
  phase: Phase | "IDLE";
  error?: string;
  exitCode?: number;
  scopeRejected?: boolean;
  approvalDenied?: boolean;
  limitsExceeded?: boolean;
  verifyFailed?: boolean;
  execFailed?: boolean;
  taskId: string;
  at: string;
}

const RULES: ClassificationRule[] = [
  // Permission failures — never recoverable by retry
  {
    category: "permission",
    match: (i) => i.scopeRejected === true,
    recoverable: false,
    maxRetries: 0,
  },
  {
    category: "permission",
    match: (i) => i.approvalDenied === true,
    recoverable: false,
    maxRetries: 0,
  },

  // Resource failures — not recoverable by retry (need different inputs)
  {
    category: "resource",
    match: (i) => i.limitsExceeded === true,
    recoverable: false,
    maxRetries: 0,
  },

  // Transient failures — safe to retry
  {
    category: "transient",
    match: (i) => isTransientError(i.error),
    recoverable: true,
    maxRetries: 3,
  },

  // Corruption — data integrity issues
  {
    category: "corruption",
    match: (i) => isCorruptionError(i.error),
    recoverable: false,
    maxRetries: 0,
  },

  // Partial success — executor succeeded partially
  {
    category: "partial_success",
    match: (i) => i.execFailed !== true && i.verifyFailed === true && hasPartialPass(i.error),
    recoverable: true,
    maxRetries: 1,
  },

  // Deterministic failures — executor or verify failed, not transient
  {
    category: "deterministic",
    match: (i) => i.execFailed === true || i.verifyFailed === true,
    recoverable: false,
    maxRetries: 0,
  },
];

// ── Classify ───────────────────────────────────────────────────────────────

export function classifyFailure(input: FailureInput): FailureRecord {
  for (const rule of RULES) {
    if (rule.match(input)) {
      return {
        category: rule.category,
        phase: input.phase,
        message: input.error ?? `${rule.category} failure in ${input.phase}`,
        recoverable: rule.recoverable,
        maxRetries: rule.maxRetries,
        taskId: input.taskId,
        at: input.at,
        ...(input.error !== undefined ? { detail: input.error } : {}),
      };
    }
  }

  // Default: unknown → treat as deterministic (safe)
  return {
    category: "unknown",
    phase: input.phase,
    message: input.error ?? "unclassified failure",
    recoverable: false,
    maxRetries: 0,
    taskId: input.taskId,
    at: input.at,
  };
}

// ── Recovery policy ────────────────────────────────────────────────────────
// Given a failure record, should the system retry?

export function shouldRetry(failure: FailureRecord, currentAttempts: number): boolean {
  if (!failure.recoverable) return false;
  if (currentAttempts >= failure.maxRetries) return false;
  return true;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isTransientError(error?: string): boolean {
  if (!error) return false;
  const signals = [
    "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE",
    "timeout", "timed out", "temporary", "retry",
    "rate limit", "throttl", "429", "503", "502",
  ];
  const lower = error.toLowerCase();
  return signals.some((s) => lower.includes(s.toLowerCase()));
}

function isCorruptionError(error?: string): boolean {
  if (!error) return false;
  const signals = [
    "checksum mismatch", "hash mismatch", "integrity",
    "corrupt", "invalid state", "invariant violation",
    "unexpected state",
  ];
  const lower = error.toLowerCase();
  return signals.some((s) => lower.includes(s.toLowerCase()));
}

function hasPartialPass(error?: string): boolean {
  if (!error) return false;
  // If verify log mentions SOME passing tests (>0), it's partial success
  const m1 = /passed[:\s]+(\d+)/i.exec(error);
  if (m1 && parseInt(m1[1]!, 10) > 0) return true;
  const m2 = /(\d+)\s+passed/i.exec(error);
  if (m2 && parseInt(m2[1]!, 10) > 0) return true;
  return false;
}
