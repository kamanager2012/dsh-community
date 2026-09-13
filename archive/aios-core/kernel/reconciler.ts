// AIOS Core — Reconciler (pure reducer).
//
// Industrial redesign: reconciler is a pure function.
// No side effects. No ID generation. No IO.
// Input → Output. Runtime applies the decision.
//
// Per Charter §6: this is the ONLY place that may AUTHORIZE a memory write.
// But it does not PERFORM the write. Runtime does.
// Per discipline: the Reconciler MUST NOT call any model.
// It is a pure deterministic function of its inputs.

import type {
  Plan,
  ExecutionResult,
  VerificationReport,
  ProjectState,
  Decision,
  MemoryUpdate,
  ReliabilityVerdict,
} from "./schema/index.js";
import { evaluateReliability } from "./reliability.js";

// ── Input ──────────────────────────────────────────────────────────────────

export interface ReconciliationInput {
  plan: Plan;
  executeResult: ExecutionResult;
  verifyReport: VerificationReport;
  projectState: ProjectState;
  now: string;
}

// ── Output ─────────────────────────────────────────────────────────────────

export interface ReconciliationOutput {
  decision: Decision;
  memoryUpdate: MemoryUpdate;
  reason: string;
  reliabilityVerdict?: ReliabilityVerdict;
}

function rollbackForReliability(
  input: ReconciliationInput,
  verdict: ReliabilityVerdict,
): ReconciliationOutput {
  const taskId = input.projectState.active_task;
  const detail = verdict.reasons.join("; ");
  return {
    decision: "ROLLBACK",
    memoryUpdate: {
      appendIncident: {
        taskId,
        reason: `reliability ${verdict.status.toLowerCase()}: ${detail}`,
        at: input.now,
      },
    },
    reason: `reliability gate ${verdict.status.toLowerCase()}: ${detail}`,
    reliabilityVerdict: verdict,
  };
}

// ── Pure reducer ───────────────────────────────────────────────────────────
// No class. No state. No ID generation.
// IDs are filled in by runtime when applying the decision.

export function reconcile(input: ReconciliationInput): ReconciliationOutput {
  // Executor failed → ROLLBACK
  if (input.executeResult.status === "failed") {
    const taskId = input.projectState.active_task;
    return {
      decision: "ROLLBACK",
      memoryUpdate: {
        appendIncident: {
          taskId,
          reason: `executor failed: ${input.executeResult.error ?? "unknown"}`,
          at: input.now,
        },
      },
      reason: `executor reported failure: ${input.executeResult.error ?? "unknown"}`,
    };
  }

  // Existing verification remains a hard gate. A task contract may only make
  // acceptance stricter; it never bypasses build/test/lint/e2e failures.
  if (input.verifyReport.status === "fail") {
    const incidentTaskId = input.projectState.active_task;
    return {
      decision: "ROLLBACK",
      memoryUpdate: {
        appendIncident: {
          taskId: incidentTaskId,
          reason: `verify failed: ${input.verifyReport.logSummary.slice(0, 200)}`,
          at: input.now,
        },
      },
      reason: `verify failed (${input.verifyReport.testsFailed} tests failed); rolling back`,
    };
  }

  // Contract-aware tasks require structured evidence before COMMIT.
  // Legacy tasks without a contract preserve the original verify-pass behavior.
  let reliabilityVerdict: ReliabilityVerdict | undefined;
  if (input.plan.contract) {
    reliabilityVerdict = evaluateReliability(
      input.plan.contract,
      input.verifyReport.evidence ?? [],
    );
    if (reliabilityVerdict.status !== "PASS") {
      return rollbackForReliability(input, reliabilityVerdict);
    }
  }

  // Verify passed (and contract evidence passed, when present) → COMMIT
  const taskId = input.projectState.active_task;
  const output: ReconciliationOutput = {
    decision: "COMMIT",
    memoryUpdate: {
      current: { phase: "DONE", active_task: null, last_change: input.now },
      appendTask: {
        taskId,
        status: "completed",
        decision: "COMMIT",
        at: input.now,
      },
      appendDecision: {
        decision: "COMMIT",
        reason: reliabilityVerdict ? "verify and reliability evidence passed" : "verify passed",
        at: input.now,
      },
    },
    reason: reliabilityVerdict
      ? "verify passed; reliability evidence satisfied; promote staging to formal memory"
      : "verify passed; promote staging to formal memory",
  };
  if (reliabilityVerdict) output.reliabilityVerdict = reliabilityVerdict;
  return output;
}
