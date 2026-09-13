// AIOS Core — Runtime Invariants.
//
// Industrial correctness layer: defines what MUST be true at every
// state transition. Violations are fatal — they indicate a bug in
// the runtime, not in user code.
//
// These are NOT policy rules (scope/approval/limits).
// These are structural invariants of the state machine itself.

import type { Phase, Decision, RuntimeState, PhaseTransition, InvariantViolation } from "./schema/index.js";

// ── Invariant definition ───────────────────────────────────────────────────



export interface InvariantCheckResult {
  ok: boolean;
  violations: InvariantViolation[];
}

// ── Invariant checks ───────────────────────────────────────────────────────

type InvariantFn = (state: RuntimeState, transition?: PhaseTransition) => InvariantViolation | null;

const INVARIANTS: { name: string; check: InvariantFn }[] = [
  // INV-1: COMMIT must follow VERIFY with pass
  {
    name: "COMMIT_AFTER_VERIFY_PASS",
    check: (state, transition) => {
      if (transition?.to !== "COMMIT") return null;
      if (state.verifyReport?.status !== "pass") {
        return {
          invariant: "COMMIT_AFTER_VERIFY_PASS",
          message: `COMMIT attempted but verifyReport.status=${state.verifyReport?.status ?? "null"}`,
          taskId: state.taskId,
          phase: "COMMIT",
          transition,
          state: JSON.stringify({ verifyStatus: state.verifyReport?.status }),
        };
      }
      return null;
    },
  },

  // INV-2: ROLLBACK must clear staging
  {
    name: "ROLLBACK_CLEARS_STAGING",
    check: (state, transition) => {
      if (transition?.to !== "ROLLBACK") return null;
      // We can't directly check staging contents, but we verify the flag is set
      if (!state.memoryRolledBack && state.decision === "ROLLBACK") {
        return {
          invariant: "ROLLBACK_CLEARS_STAGING",
          message: "ROLLBACK transition but memoryRolledBack not set",
          taskId: state.taskId,
          phase: "ROLLBACK",
          transition,
          state: JSON.stringify({ memoryRolledBack: state.memoryRolledBack }),
        };
      }
      return null;
    },
  },

  // INV-3: Decision must come from reconciler (not arbitrary)
  {
    name: "DECISION_FROM_RECONCILER",
    check: (state, _transition) => {
      if (state.decision !== null && state.memoryUpdate === null && state.terminal) {
        // Terminal state with decision but no reconciler output
        // Exception: scope/approval rejections set decision directly
        if (state.reason !== "plan rejected by scope" && state.reason !== "manual approval denied") {
          return {
            invariant: "DECISION_FROM_RECONCILER",
            message: `Terminal decision=${state.decision} with no memoryUpdate and reason="${state.reason}"`,
            taskId: state.taskId,
            phase: _transition?.to ?? "IDLE",
            state: JSON.stringify({ decision: state.decision, reason: state.reason }),
          };
        }
      }
      return null;
    },
  },

  // INV-4: Terminal state must not have further transitions
  {
    name: "TERMINAL_NO_FURTHER_TRANSITIONS",
    check: (state, transition) => {
      if (!state.terminal) return null;
      if (transition && state.transitions.length > 0) {
        const lastTransition = state.transitions[state.transitions.length - 1]!;
        if (lastTransition.to !== "DONE" && lastTransition.to !== "COMMIT" && lastTransition.to !== "ROLLBACK") {
          return {
            invariant: "TERMINAL_NO_FURTHER_TRANSITIONS",
            message: `Terminal but last transition is ${lastTransition.from}->${lastTransition.to}`,
            taskId: state.taskId,
            phase: lastTransition.to,
            transition,
            state: JSON.stringify({ terminal: state.terminal, lastTo: lastTransition.to }),
          };
        }
      }
      return null;
    },
  },

  // INV-5: Plan must be frozen after PLAN phase
  {
    name: "PLAN_FROZEN_AFTER_PLAN",
    check: (state, _transition) => {
      if (state.plan === null) return null;
      if (!state.plan.frozen && state.transitions.some((t) => t.to === "EXECUTE" || t.to === "VERIFY")) {
        return {
          invariant: "PLAN_FROZEN_AFTER_PLAN",
          message: "Plan not frozen before EXECUTE/VERIFY",
          taskId: state.taskId,
          phase: "EXECUTE",
          state: JSON.stringify({ frozen: state.plan.frozen }),
        };
      }
      return null;
    },
  },

  // INV-6: Cannot transition to EXECUTE without a plan
  {
    name: "EXECUTE_REQUIRES_PLAN",
    check: (state, transition) => {
      if (transition?.to !== "EXECUTE") return null;
      if (state.plan === null) {
        return {
          invariant: "EXECUTE_REQUIRES_PLAN",
          message: "EXECUTE transition but plan is null",
          taskId: state.taskId,
          phase: "EXECUTE",
          transition,
          state: JSON.stringify({ hasPlan: false }),
        };
      }
      return null;
    },
  },
];

// ── Check all invariants ───────────────────────────────────────────────────

export function checkInvariants(
  state: RuntimeState,
  transition?: PhaseTransition,
): InvariantCheckResult {
  const violations: InvariantViolation[] = [];

  for (const { name, check } of INVARIANTS) {
    try {
      const violation = check(state, transition);
      if (violation) violations.push(violation);
    } catch (err) {
      violations.push({
        invariant: name,
        message: `invariant check threw: ${err instanceof Error ? err.message : String(err)}`,
        taskId: state.taskId,
        phase: transition?.to ?? "IDLE",
        transition,
        state: "check-error",
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

// Re-export for backward compatibility
export type { InvariantViolation } from "./schema/index.js";
