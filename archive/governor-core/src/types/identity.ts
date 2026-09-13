// governor-core — Execution identity model (v0.1).
//
// Answers the future audit question: "who initiated this action, in which run,
// after how many attempts, from which delegation/replay lineage?" — without
// pulling in any runtime. Every field except agentId is optional so a
// standalone adapter (e.g. the Claude Code hook, no runtime) still populates a
// valid identity, while a runtime can layer on run/attempt/lineage over time.
//
// Recorded into the audit chain for provenance; it does NOT influence the
// allow/deny/ask verdict and does NOT bind approval tokens in v0.1 — those are
// deliberately later phases (context-aware decisions, runtime token binding).

export interface ExecutionIdentity {
  /** The agent identity that initiated the action. Distinct from the audit
   *  sink's static actor — a single host can front many agents. */
  agentId: string;
  /** One task lifecycle. Absent in standalone (no-runtime) mode. */
  runId?: string;
  /** Attempt within a run: a retry is a new attempt of the SAME run, not a new
   *  run — keeping the audit lineage intact across retries. */
  attemptId?: string;
  /** Parent run for agent delegation (a spawned sub-run points at its parent). */
  parentRunId?: string;
  /** Fork / replay / recovery lineage: distinguishes a resumed original from an
   *  experimental branch of the same execution. */
  lineageId?: string;
  /** Monotonic time/generation ordinal, when a runtime supplies one. */
  executionEpoch?: number;
}
