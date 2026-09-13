// AIOS Core — Audit Replay.
//
// Reconstructs complete RuntimeState trajectory from audit log.
// Deterministic replay: same audit entries → same state trajectory.
// Reliability verdicts are derived from the frozen plan contract + recorded
// verification evidence; they are not duplicated as mutable audit state.

import type {
  Phase,
  Decision,
  Plan,
  ExecutionResult,
  VerificationReport,
  PhaseTransition,
  ReliabilityVerdict,
} from "./schema/index.js";
import { evaluateReliability } from "./reliability.js";
import type { AuditEntry } from "../governor/audit.js";
import { upgradeEntry, validateEntryVersion, CURRENT_SCHEMA_VERSION, type VersionedEntry } from "./schema_version.js";

// ── Replayed state at a single point in time ───────────────────────────────

export interface ReplayPoint {
  seq: number;
  at: string;
  taskId: string;
  phase: Phase | "IDLE";
  transition?: { from: Phase | "IDLE"; to: Phase; note?: string };
  plan?: Plan;
  execResult?: ExecutionResult;
  verifyReport?: VerificationReport;
  reliabilityVerdict?: ReliabilityVerdict;
  decision?: Decision;
  snapshotId?: string;
  limitsUsed?: { turns: number; context: number; retries: number };
  attempt?: number;
  autoFixAttempts?: number;
}

// ── Replayed trajectory for a task ─────────────────────────────────────────

export interface ReplayTrajectory {
  taskId: string;
  points: ReplayPoint[];
  transitions: PhaseTransition[];
  finalPhase: Phase | "IDLE";
  finalDecision: Decision | null;
  finalReliabilityVerdict?: ReliabilityVerdict;
  terminal: boolean;
  totalRetries: number;
  totalAutoFixAttempts: number;
  committed: boolean;
  rolledBack: boolean;
  reason: string;
}

// ── Replay from audit entries ──────────────────────────────────────────────

export function replayTask(rawEntries: AuditEntry[]): ReplayTrajectory {
  const upgraded = rawEntries.map((e) => {
    const v = validateEntryVersion(e as unknown as VersionedEntry);
    if (!v.valid) {
      throw new Error(`Cannot replay entry with future schema version ${v.version} (current: ${CURRENT_SCHEMA_VERSION})`);
    }
    return v.needsMigration ? (upgradeEntry(e as unknown as VersionedEntry) as unknown as AuditEntry) : e;
  });
  const entries_ = upgraded;
  if (entries_.length === 0) {
    return {
      taskId: "",
      points: [],
      transitions: [],
      finalPhase: "IDLE",
      finalDecision: null,
      terminal: false,
      totalRetries: 0,
      totalAutoFixAttempts: 0,
      committed: false,
      rolledBack: false,
      reason: "",
    };
  }

  const taskId = entries_[0]!.taskId;
  const points: ReplayPoint[] = [];
  const transitions: PhaseTransition[] = [];
  let finalPhase: Phase | "IDLE" = "IDLE";
  let finalDecision: Decision | null = null;
  let finalReliabilityVerdict: ReliabilityVerdict | undefined;
  let latestPlan: Plan | undefined;
  let latestVerifyReport: VerificationReport | undefined;
  let terminal = false;
  let committed = false;
  let rolledBack = false;
  let reason = "";
  let totalRetries = 0;
  let totalAutoFixAttempts = 0;

  for (const entry of entries_) {
    const point: ReplayPoint = {
      seq: entry.seq ?? 0,
      at: entry.at,
      taskId: entry.taskId,
      phase: (entry.toPhase ?? entry.phase) as Phase | "IDLE",
    };

    if (entry.plan) {
      point.plan = entry.plan;
      latestPlan = entry.plan;
    }
    if (entry.execResult) point.execResult = entry.execResult;
    if (entry.verifyReport) {
      point.verifyReport = entry.verifyReport;
      latestVerifyReport = entry.verifyReport;
    }
    if (entry.decision) point.decision = entry.decision;
    if (entry.snapshotId) point.snapshotId = entry.snapshotId;
    if (entry.limitsUsed) point.limitsUsed = entry.limitsUsed;
    if (entry.attempt) point.attempt = entry.attempt;
    if (entry.autoFixAttempts) point.autoFixAttempts = entry.autoFixAttempts;

    // Reliability is derived state. The live reconciler only evaluates a task
    // contract after the legacy verification gate passes, so replay mirrors
    // that exact ordering. Persisting the verdict separately would create two
    // sources of truth that could drift.
    if (latestPlan?.contract && latestVerifyReport?.status === "pass") {
      const verdict = evaluateReliability(
        latestPlan.contract,
        latestVerifyReport.evidence ?? [],
      );
      point.reliabilityVerdict = verdict;
      finalReliabilityVerdict = verdict;
    }

    if (entry.fromPhase && entry.toPhase) {
      point.transition = { from: entry.fromPhase, to: entry.toPhase };
      const t: PhaseTransition = {
        from: entry.fromPhase,
        to: entry.toPhase,
        taskId: entry.taskId,
      };
      transitions.push(t);
    }

    if (entry.attempt && entry.attempt > 1) {
      totalRetries += entry.attempt - 1;
    }
    if (entry.autoFixAttempts) {
      totalAutoFixAttempts = Math.max(totalAutoFixAttempts, entry.autoFixAttempts);
    }

    finalPhase = point.phase;
    if (entry.decision) finalDecision = entry.decision;
    if (entry.phase === "COMMIT") committed = true;
    if (entry.phase === "ROLLBACK") rolledBack = true;
    if (entry.phase === "DONE" || entry.phase === "COMMIT" || entry.phase === "ROLLBACK") terminal = true;
    if (entry.result) reason = entry.result;

    points.push(point);
  }

  return {
    taskId,
    points,
    transitions,
    finalPhase,
    finalDecision,
    ...(finalReliabilityVerdict ? { finalReliabilityVerdict } : {}),
    terminal,
    totalRetries,
    totalAutoFixAttempts,
    committed,
    rolledBack,
    reason,
  };
}

// ── Replay multiple tasks from full audit log ──────────────────────────────

export function replayAll(entries: AuditEntry[]): ReplayTrajectory[] {
  const byTask = new Map<string, AuditEntry[]>();
  for (const entry of entries) {
    const existing = byTask.get(entry.taskId) ?? [];
    existing.push(entry);
    byTask.set(entry.taskId, existing);
  }

  return Array.from(byTask.entries())
    .map(([_, taskEntries]) => ({ taskEntries, trajectories: replayTask(taskEntries.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) }))
    .sort((a, b) => {
      const aSeq = a.taskEntries[0]?.seq ?? 0;
      const bSeq = b.taskEntries[0]?.seq ?? 0;
      return aSeq - bSeq;
    })
    .map((r) => r.trajectories);
}

// ── Query: find nearest snapshot before a given seq ────────────────────────

export function findNearestSnapshot(
  entries: AuditEntry[],
  beforeSeq: number,
): string | undefined {
  let nearest: string | undefined;
  let nearestSeq = 0;

  for (const entry of entries) {
    if (entry.snapshotId && (entry.seq ?? 0) <= beforeSeq && (entry.seq ?? 0) > nearestSeq) {
      nearest = entry.snapshotId;
      nearestSeq = entry.seq ?? 0;
    }
  }

  return nearest;
}

// ── Query: reconstruct cumulative state at a given point ──────────────────

function latestField<T>(
  points: ReplayPoint[],
  select: (point: ReplayPoint) => T | undefined,
): T | undefined {
  for (let index = points.length - 1; index >= 0; index--) {
    const value = select(points[index]!);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function stateAtPoint(
  entries: AuditEntry[],
  seq: number,
): ReplayPoint | undefined {
  const target = entries.find((entry) => entry.seq === seq);
  if (!target) return undefined;

  // Scope reconstruction to the target task and every audited event up to the
  // requested sequence. Returning only the single target entry would lose
  // previously established plan/execute/verify state at COMMIT/ROLLBACK.
  const scoped = entries
    .filter((entry) => entry.taskId === target.taskId && (entry.seq ?? 0) <= seq)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const trajectory = replayTask(scoped);
  const finalPoint = trajectory.points[trajectory.points.length - 1];
  if (!finalPoint) return undefined;

  const plan = latestField(trajectory.points, (point) => point.plan);
  const execResult = latestField(trajectory.points, (point) => point.execResult);
  const verifyReport = latestField(trajectory.points, (point) => point.verifyReport);
  const reliabilityVerdict = latestField(trajectory.points, (point) => point.reliabilityVerdict);
  const decision = latestField(trajectory.points, (point) => point.decision);
  const snapshotId = latestField(trajectory.points, (point) => point.snapshotId);
  const limitsUsed = latestField(trajectory.points, (point) => point.limitsUsed);
  const attempt = latestField(trajectory.points, (point) => point.attempt);
  const autoFixAttempts = latestField(trajectory.points, (point) => point.autoFixAttempts);

  return {
    ...finalPoint,
    ...(plan ? { plan } : {}),
    ...(execResult ? { execResult } : {}),
    ...(verifyReport ? { verifyReport } : {}),
    ...(reliabilityVerdict ? { reliabilityVerdict } : {}),
    ...(decision ? { decision } : {}),
    ...(snapshotId ? { snapshotId } : {}),
    ...(limitsUsed ? { limitsUsed } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(autoFixAttempts !== undefined ? { autoFixAttempts } : {}),
  };
}
