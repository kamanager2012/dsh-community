// AIOS Core — Executor (stateless).
//
// Industrial redesign: executor is a pure function.
// One attempt per call. No internal retry loop.
// Retry logic is owned by runtime, not executor.
//
// Per Charter §3: RETRY is a runtime concern, not an executor state.

import type { Plan, ExecutionResult } from "./schema/index.js";

// ── Executor function signature ────────────────────────────────────────────
// The executor takes a plan and returns a result. Stateless.

export interface ExecutorFn {
  (plan: Plan, stagingPath: string): Promise<ExecutionResult>;
}

// ── Adapter: IO operations the executor needs ──────────────────────────────

export interface ExecutorAdapter {
  applyPatch: (plan: Plan, stagingPath: string) => Promise<string>;
  runCommand: (cmd: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  now: () => string;
  newId: () => string;
}

// ── Factory: create a stateless executor function ──────────────────────────

export function createExecutor(adapter: ExecutorAdapter): ExecutorFn {
  return async (plan: Plan, stagingPath: string): Promise<ExecutionResult> => {
    try {
      const diff = await adapter.applyPatch(plan, stagingPath);
      const buildResult = await adapter.runCommand("npx tsc --noEmit");
      if (!buildResult.ok) {
        return {
          planId: adapter.newId(),
          diff: "",
          stagingPath,
          status: "failed",
          startedAt: adapter.now(),
          error: `build failed: ${buildResult.stderr}`,
          attempt: 1,
        };
      }
      return {
        planId: adapter.newId(),
        diff,
        stagingPath,
        status: "succeeded",
        startedAt: adapter.now(),
        attempt: 1,
      };
    } catch (err) {
      return {
        planId: adapter.newId(),
        diff: "",
        stagingPath,
        status: "failed",
        startedAt: adapter.now(),
        error: err instanceof Error ? err.message : String(err),
        attempt: 1,
      };
    }
  };
}
