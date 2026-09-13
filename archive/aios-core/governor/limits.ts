// AIOS Core — Limits.
// Per Charter §8: termination conditions, not budgets.
// These are hard stops that prevent runaway execution.
// They are NOT cost tracking. They are NOT budget gates.

export interface Limits {
  /** Maximum steps a single execution may take. */
  maxTurns: number;
  /** Maximum context tokens injected into the agent at once. */
  maxContext: number;
  /** Maximum retries inside executor on a single task. */
  maxRetries: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxTurns: 50,
  maxContext: 200_000,
  maxRetries: 3,
};

export function checkLimits(limits: Limits, used: { turns: number; context: number; retries: number }): { ok: boolean; reason?: string } {
  if (used.turns >= limits.maxTurns) {
    return { ok: false, reason: `turn limit reached (${used.turns}/${limits.maxTurns})` };
  }
  if (used.context >= limits.maxContext) {
    return { ok: false, reason: `context limit reached (${used.context}/${limits.maxContext})` };
  }
  // Note: retry limit is enforced inside Executor per-task, not as a cumulative gate here.
  // `used.retries` tracks total retries across tasks for observability, but the per-task
  // limit (maxRetries) is checked inside Executor.run() by its while loop.
  return { ok: true };
}
