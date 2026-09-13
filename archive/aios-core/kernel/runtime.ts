// AIOS Core — Runtime loop (SSOT).
//
// Runtime is the ONLY state machine driver.
// Invariant checks run at every state transition after state is mutated.
// Violations are fatal in strict mode (default).

import type {
  Plan, TaskRequest, ExecutionResult, VerificationReport,
  ProjectState, Phase, Decision, MemoryUpdate, ExecutionTier,
  FailureRecord,
  RuntimeState, PhaseTransition, 
} from "./schema/index.js";
import type { ReconciliationInput, ReconciliationOutput } from "./reconciler.js";
import { reconcile } from "./reconciler.js";
import type { PlannerFn } from "./planner.js";
import type { ExecutorFn } from "./executor.js";
import type { VerifierFn } from "./verifier.js";
import { ScopeValidator } from "../governor/scope.js";
import { checkLimits, DEFAULT_LIMITS, type Limits } from "../governor/limits.js";
import type { MemoryStore } from "../memory/index.js";
import { Rollback } from "../governor/rollback.js";
import { AuditLog } from "../governor/audit.js";
import { checkInvariants, type InvariantViolation } from "./invariant.js";
import type { AuditEntry } from "../governor/audit.js";
import { classifyFailure, shouldRetry } from "./failure.js";
import { computeFingerprint, HashChain, verifyChain } from "./statehash.js";

// Re-export types moved to schema for backward compatibility
export type { RuntimeState, PhaseTransition, InvariantViolation } from "./schema/index.js";


export interface RuntimeDeps {
  planner: PlannerFn;
  executor: ExecutorFn;
  verifier: VerifierFn;
  scope: ScopeValidator;
  memory: MemoryStore;
  rollback: Rollback;
  audit: AuditLog;
  limits?: Limits;
  tier?: ExecutionTier;
  now: () => string;
  newId: () => string;
  askHuman?: (plan: Plan) => Promise<boolean>;
  readProjectState: (project: string) => Promise<ProjectState>;
  maxRetries?: number;
  maxAutoFix?: number;
  autoFixFn?: () => Promise<boolean>;
  strictInvariants?: boolean;
  hashChain?: HashChain;
  strictHashChain?: boolean;
}





async function auditAppend(deps: RuntimeDeps, entry: AuditEntry): Promise<void> {
  await deps.audit.append(entry);
  if (deps.hashChain) {
    const latest = deps.audit.all()[deps.audit.all().length - 1];
    if (latest) {
      const fp = await deps.hashChain.append(latest);

      // Runtime gate: verify chain integrity after each append
      // In strict mode (default), a broken chain is fatal
      if (deps.strictHashChain !== false) {
        const chain = deps.hashChain.getChain();
        const allEntries = deps.audit.all();
        const verification = await verifyChain(chain, allEntries);
        if (!verification.valid) {
          throw new Error(`Hash chain verification failed at seq=${fp.seq}: ${verification.message}`);
        }
      }
    }
  }
}

async function guardInvariants(
  state: RuntimeState,
  transition: PhaseTransition | undefined,
  deps: RuntimeDeps,
): Promise<void> {
  const result = checkInvariants(state, transition);
  if (result.ok) return;

  state.invariantViolations.push(...result.violations);

  for (const v of result.violations) {
    await auditAppend(deps, {
      at: deps.now(), taskId: state.taskId, phase: "INVARIANT_VIOLATION",
      execution: `${v.invariant}: ${v.message}`,
    });
  }

  if (deps.strictInvariants !== false) {
    throw new Error(`Invariant violation: ${result.violations[0]!.invariant} — ${result.violations[0]!.message}`);
  }
}

export async function runTask(
  request: TaskRequest,
  deps: RuntimeDeps,
): Promise<RuntimeState> {
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const maxRetries = deps.maxRetries ?? DEFAULT_LIMITS.maxRetries;
  const maxAutoFix = deps.maxAutoFix ?? 3;

  const state: RuntimeState = {
    taskId: deps.newId(),
    request,
    transitions: [],
    plan: null,
    execResult: null,
    verifyReport: null,
    decision: null,
    memoryUpdate: null,
    memoryCommitted: false,
    memoryRolledBack: false,
    terminal: false,
    reason: "",
    limitsUsed: { turns: 0, context: 0, retries: 0 },
    totalRetries: 0,
    totalAutoFixAttempts: 0,
    invariantViolations: [],
    failureRecord: null,
    hashChainLength: 0,
  };

  const projectState = await deps.readProjectState(request.project);

  // ── IDLE → PLAN ──────────────────────────────────────────────────────
  const t1: PhaseTransition = { from: "IDLE", to: "PLAN", taskId: state.taskId };
  state.transitions.push(t1);
  state.plan = await deps.planner(request);
  state.plan.frozen = true;
  state.limitsUsed.turns++;
  state.limitsUsed.context += estimateContext(request, projectState);
  await guardInvariants(state, t1, deps);
  await auditAppend(deps, {
    at: deps.now(), taskId: state.taskId, phase: "PLAN",
    fromPhase: "IDLE", toPhase: "PLAN",
    input: request.goal, plan: state.plan,
    limitsUsed: { ...state.limitsUsed },
  });

  const limitCheck = checkLimits(limits, state.limitsUsed);
  if (!limitCheck.ok) {
    state.terminal = true;
    state.reason = limitCheck.reason ?? "limits exceeded";
    await auditAppend(deps, {
      at: deps.now(), taskId: state.taskId, phase: "IDLE",
      result: "limits exceeded", limitsUsed: { ...state.limitsUsed },
    });
    return state;
  }

  // ── Scope check ──────────────────────────────────────────────────────
  if (!deps.scope.validatePlan(state.plan)) {
    state.decision = "ROLLBACK";
    state.terminal = true;
    state.reason = "plan rejected by scope";
    state.failureRecord = classifyFailure({
      phase: "PLAN", scopeRejected: true, taskId: state.taskId, at: deps.now(),
    });
    const ts: PhaseTransition = { from: "PLAN", to: "ROLLBACK", taskId: state.taskId, note: "scope rejected" };
    state.transitions.push(ts);
    state.transitions.push({ from: "ROLLBACK", to: "DONE", taskId: state.taskId });
    await applyRollback(state, deps, "plan rejected by scope");
    await guardInvariants(state, ts, deps);
    await auditAppend(deps, {
      at: deps.now(), taskId: state.taskId, phase: "ROLLBACK",
      fromPhase: "PLAN", toPhase: "ROLLBACK",
      decision: "ROLLBACK", result: "scope rejected",
    });
    return state;
  }

  // ── Approval gate ────────────────────────────────────────────────────
  if (state.plan.approval === "MANUAL") {
    const humanOk = await deps.askHuman?.(state.plan);
    if (humanOk !== true) {
      state.decision = "ROLLBACK";
      state.terminal = true;
      state.reason = "manual approval denied";
      state.failureRecord = classifyFailure({
        phase: "PLAN", approvalDenied: true, taskId: state.taskId, at: deps.now(),
      });
      state.transitions.push({ from: "PLAN", to: "ROLLBACK", taskId: state.taskId, note: "approval denied" });
      state.transitions.push({ from: "ROLLBACK", to: "DONE", taskId: state.taskId });
      await applyRollback(state, deps, "manual approval denied");
      await guardInvariants(state, { from: "PLAN", to: "ROLLBACK", taskId: state.taskId, note: "approval denied" }, deps);
      await auditAppend(deps, {
        at: deps.now(), taskId: state.taskId, phase: "ROLLBACK",
        fromPhase: "PLAN", toPhase: "ROLLBACK",
        decision: "ROLLBACK", result: "manual approval denied",
      });
      return state;
    }
  }

  // ── PLAN → EXECUTE ──────────────────────────────────────────────────
  const t2: PhaseTransition = { from: "PLAN", to: "EXECUTE", taskId: state.taskId };
  state.transitions.push(t2);
  await guardInvariants(state, t2, deps);
  await auditAppend(deps, {
    at: deps.now(), taskId: state.taskId, phase: "EXECUTE",
    fromPhase: "PLAN", toPhase: "EXECUTE", plan: state.plan,
  });

  let execResult: ExecutionResult;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    execResult = await deps.executor(state.plan, "/staging");
    execResult.attempt = attempt;
    if (execResult.status === "succeeded") break;

    // Classify failure to determine recovery strategy
    const failure = classifyFailure({
      phase: "EXECUTE",
      ...(execResult.error ? { error: execResult.error } : {}),
      execFailed: true,
      taskId: state.taskId,
      at: deps.now(),
    });
    state.failureRecord = failure;

    if (!shouldRetry(failure, attempt - 1)) {
      // Non-recoverable failure — stop retrying
      await auditAppend(deps, {
        at: deps.now(), taskId: state.taskId, phase: "EXECUTE",
        execution: `attempt ${attempt} failed (${failure.category}, not recoverable): ${execResult.error}`,
        execResult, attempt, limitsUsed: { ...state.limitsUsed },
      });
      break;
    }

    state.totalRetries++;
    state.limitsUsed.retries++;
    await auditAppend(deps, {
      at: deps.now(), taskId: state.taskId, phase: "EXECUTE",
      execution: `attempt ${attempt} failed (${failure.category}, retrying): ${execResult.error}`,
      execResult, attempt, limitsUsed: { ...state.limitsUsed },
    });

    const limitCheckExec = checkLimits(limits, state.limitsUsed);
    if (!limitCheckExec.ok) {
      state.terminal = true;
      state.reason = limitCheckExec.reason ?? "limits exceeded during execution";
      state.failureRecord = classifyFailure({
        phase: "EXECUTE", limitsExceeded: true, taskId: state.taskId, at: deps.now(),
      });
      await auditAppend(deps, {
        at: deps.now(), taskId: state.taskId, phase: "ROLLBACK",
        fromPhase: "EXECUTE", toPhase: "ROLLBACK",
        result: "limits exceeded during execution",
        execResult, limitsUsed: { ...state.limitsUsed },
      });
      await deps.rollback.restore();
      await deps.memory.clearStaging();
      state.memoryRolledBack = true;
      state.execResult = execResult;
      return state;
    }
  }

  state.execResult = execResult!;
  state.limitsUsed.turns++;
  await deps.memory.writeToStaging(`${state.taskId}/diff`, state.execResult.diff);
  await auditAppend(deps, {
    at: deps.now(), taskId: state.taskId, phase: "EXECUTE",
    execution: `completed after ${attempt} attempt(s)`,
    execResult: state.execResult, attempt, limitsUsed: { ...state.limitsUsed },
  });

  // ── EXECUTE → VERIFY ────────────────────────────────────────────────
  const t3: PhaseTransition = { from: "EXECUTE", to: "VERIFY", taskId: state.taskId };
  state.transitions.push(t3);

  if (state.execResult.status === "failed") {
    state.verifyReport = {
      planId: state.execResult.planId, status: "fail",
      testsRun: 0, testsPassed: 0, testsFailed: 0,
      logSummary: "executor reported failure", autoFixAttempts: 0,
    };
  } else {
    let verifyReport = await deps.verifier(state.execResult);
    let autoFixAttempts = 0;
    while (verifyReport.status === "fail" && autoFixAttempts < maxAutoFix && deps.autoFixFn) {
      const fixed = await deps.autoFixFn();
      autoFixAttempts++;
      state.totalAutoFixAttempts++;
      if (!fixed) break;
      verifyReport = await deps.verifier(state.execResult);
      verifyReport.autoFixAttempts = autoFixAttempts;
    }
    state.verifyReport = verifyReport;
  }

  state.limitsUsed.turns++;
  await guardInvariants(state, t3, deps);
  await auditAppend(deps, {
    at: deps.now(), taskId: state.taskId, phase: "VERIFY",
    fromPhase: "EXECUTE", toPhase: "VERIFY",
    execution: `pass=${state.verifyReport.testsPassed} fail=${state.verifyReport.testsFailed}`,
    verifyReport: state.verifyReport, autoFixAttempts: state.totalAutoFixAttempts,
    limitsUsed: { ...state.limitsUsed },
  });

  // ── VERIFY → COMMIT or ROLLBACK ──────────────────────────────────────
  const reconInput: ReconciliationInput = {
    plan: state.plan, executeResult: state.execResult,
    verifyReport: state.verifyReport, projectState, now: deps.now(),
  };
  const recon = reconcile(reconInput);
  state.decision = recon.decision;
  state.memoryUpdate = recon.memoryUpdate;
  state.reason = recon.reason;

  if (recon.decision === "COMMIT") {
    await applyCommit(state, deps, projectState, recon);
  } else {
    await applyRollbackFromReconciler(state, deps, recon);
  }

  // Compute final state fingerprint from hash chain
  if (deps.hashChain) {
    const latest = deps.hashChain.latest();
    if (latest) {
      state.lastFingerprint = latest.hash;
      state.hashChainLength = deps.hashChain.count();
    }
  } else {
    const allEntries = deps.audit.all();
    const fp = await computeFingerprint(allEntries, allEntries.length);
    if (fp) state.lastFingerprint = fp.hash;
  }

  return state;
}

async function applyCommit(
  state: RuntimeState,
  deps: RuntimeDeps,
  projectState: ProjectState,
  recon: ReconciliationOutput,
): Promise<void> {
  const t: PhaseTransition = { from: "VERIFY", to: "COMMIT", taskId: state.taskId };
  state.transitions.push(t);

  const commitResult = await deps.memory.commitStaging(state.taskId, deps.now);
  state.memoryCommitted = true;

  const taskUpdate = recon.memoryUpdate.appendTask;
  const decisionUpdate = recon.memoryUpdate.appendDecision;

  if (taskUpdate) {
    await deps.memory.appendTask({
      taskId: taskUpdate.taskId ?? state.taskId,
      status: taskUpdate.status, decision: taskUpdate.decision, at: taskUpdate.at,
    });
  }
  if (decisionUpdate) {
    await deps.memory.appendDecision({
      id: decisionUpdate.id ?? deps.newId(),
      decision: decisionUpdate.decision, reason: decisionUpdate.reason, at: decisionUpdate.at,
    });
  }
  if (recon.memoryUpdate.current) {
    await deps.memory.writeToCurrent("project_state.json", JSON.stringify({
      ...projectState, ...recon.memoryUpdate.current,
    }, null, 2));
  }

  await guardInvariants(state, t, deps);

  state.transitions.push({ from: "COMMIT", to: "DONE", taskId: state.taskId });
  state.terminal = true;
  await auditAppend(deps, {
    at: deps.now(), taskId: state.taskId, phase: "COMMIT",
    fromPhase: "VERIFY", toPhase: "COMMIT",
    decision: "COMMIT", result: "committed",
    snapshotId: commitResult.snapshotId, limitsUsed: { ...state.limitsUsed },
  });
}

async function applyRollback(
  state: RuntimeState,
  deps: RuntimeDeps,
  reason: string,
): Promise<void> {
  await deps.rollback.restore();
  await deps.memory.clearStaging();
  state.memoryRolledBack = true;
  await deps.memory.appendIncident({ id: deps.newId(), taskId: state.taskId, reason, at: deps.now() });
}

async function applyRollbackFromReconciler(
  state: RuntimeState,
  deps: RuntimeDeps,
  recon: ReconciliationOutput,
): Promise<void> {
  state.failureRecord = classifyFailure({
    phase: "VERIFY",
    error: recon.reason,
    execFailed: state.execResult?.status === "failed",
    verifyFailed: state.verifyReport?.status === "fail",
    taskId: state.taskId,
    at: deps.now(),
  });
  const t: PhaseTransition = { from: "VERIFY", to: "ROLLBACK", taskId: state.taskId, note: recon.reason };
  state.transitions.push(t);

  await deps.rollback.restore();
  await deps.memory.clearStaging();
  state.memoryRolledBack = true;

  const incidentUpdate = recon.memoryUpdate.appendIncident;
  if (incidentUpdate) {
    await deps.memory.appendIncident({
      id: incidentUpdate.id ?? deps.newId(),
      taskId: incidentUpdate.taskId ?? state.taskId,
      reason: incidentUpdate.reason, at: incidentUpdate.at,
    });
  }

  await guardInvariants(state, t, deps);

  state.transitions.push({ from: "ROLLBACK", to: "DONE", taskId: state.taskId });
  state.terminal = true;
  await auditAppend(deps, {
    at: deps.now(), taskId: state.taskId, phase: "ROLLBACK",
    fromPhase: "VERIFY", toPhase: "ROLLBACK",
    decision: "ROLLBACK", result: recon.reason, limitsUsed: { ...state.limitsUsed },
  });
}

function estimateContext(req: TaskRequest, state: ProjectState): number {
  return (req.goal.length + (req.context?.length ?? 0) + 200) * 4;
}
