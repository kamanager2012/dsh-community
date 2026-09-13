// AIOS Core — Reliability evaluation.
//
// This module is intentionally pure. It does not execute agents, tools, tests,
// policies, or sandboxes. It evaluates structured evidence against a frozen
// task contract and compares reliability runs across agent/model versions.

import type {
  EvidenceItem,
  EvidenceKind,
  ReliabilityVerdict,
  TaskContract,
} from "./schema/index.js";

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function addKindOnce(values: EvidenceKind[], kind: EvidenceKind): void {
  if (!values.includes(kind)) values.push(kind);
}

export function evaluateReliability(
  contract: TaskContract,
  evidence: EvidenceItem[],
): ReliabilityVerdict {
  const byKind = new Map<EvidenceKind, EvidenceItem[]>();
  for (const item of evidence) {
    const existing = byKind.get(item.kind) ?? [];
    existing.push(item);
    byKind.set(item.kind, existing);
  }

  const missingEvidence: EvidenceKind[] = [];
  const failedEvidence: EvidenceKind[] = [];
  const reasons: string[] = [];

  for (const kind of uniq(contract.requiredEvidence)) {
    const items = byKind.get(kind) ?? [];
    if (items.length === 0 || items.every((item) => item.status === "missing")) {
      missingEvidence.push(kind);
      reasons.push(`required evidence missing: ${kind}`);
      continue;
    }
    if (items.some((item) => item.status === "fail")) {
      failedEvidence.push(kind);
      reasons.push(`required evidence failed: ${kind}`);
    }
  }

  // Named invariants are concrete acceptance requirements, not documentation.
  // Every invariant listed in the contract must have matching structured
  // evidence with kind="invariant" and id=<invariant-name>.
  for (const invariant of uniq(contract.invariants ?? [])) {
    const items = (byKind.get("invariant") ?? []).filter((item) => item.id === invariant);
    if (items.length === 0 || items.every((item) => item.status === "missing")) {
      addKindOnce(missingEvidence, "invariant");
      reasons.push(`required invariant missing: ${invariant}`);
      continue;
    }
    if (items.some((item) => item.status === "fail")) {
      addKindOnce(failedEvidence, "invariant");
      reasons.push(`required invariant failed: ${invariant}`);
    }
  }

  const minTestsPassed = contract.acceptance?.minTestsPassed;
  if (minTestsPassed !== undefined) {
    const testEvidence = byKind.get("test") ?? [];
    const passed = testEvidence.reduce((sum, item) => sum + (item.metrics?.passed ?? 0), 0);
    if (testEvidence.length === 0 || testEvidence.every((item) => item.status === "missing")) {
      addKindOnce(missingEvidence, "test");
      reasons.push(`test evidence required for minTestsPassed=${minTestsPassed}`);
    } else if (passed < minTestsPassed) {
      addKindOnce(failedEvidence, "test");
      reasons.push(`tests passed ${passed} < required ${minTestsPassed}`);
    }
  }

  if (failedEvidence.length > 0) {
    return {
      status: "FAIL",
      reasons,
      missingEvidence,
      failedEvidence,
    };
  }

  if (missingEvidence.length > 0) {
    return {
      status: "INCOMPLETE",
      reasons,
      missingEvidence,
      failedEvidence,
    };
  }

  return {
    status: "PASS",
    reasons: reasons.length > 0 ? reasons : ["all required evidence satisfied"],
    missingEvidence: [],
    failedEvidence: [],
  };
}

export interface ReliabilityRun {
  taskId: string;
  project: string;
  agent: string;
  model: string;
  version: string;
  verdict: ReliabilityVerdict;
  fingerprint?: string;
  interventionCount?: number;
}

export interface RegressionChange {
  taskId: string;
  from: ReliabilityVerdict["status"];
  to: ReliabilityVerdict["status"];
}

export interface ReliabilityRegressionReport {
  regressions: RegressionChange[];
  improvements: RegressionChange[];
  unchanged: number;
  missingFromCandidate: string[];
  addedInCandidate: string[];
}

const STATUS_RANK: Record<ReliabilityVerdict["status"], number> = {
  FAIL: 0,
  INCOMPLETE: 1,
  PASS: 2,
};

export function compareReliabilityRuns(
  baseline: ReliabilityRun[],
  candidate: ReliabilityRun[],
): ReliabilityRegressionReport {
  const before = new Map(baseline.map((run) => [run.taskId, run]));
  const after = new Map(candidate.map((run) => [run.taskId, run]));

  const regressions: RegressionChange[] = [];
  const improvements: RegressionChange[] = [];
  const missingFromCandidate: string[] = [];
  const addedInCandidate: string[] = [];
  let unchanged = 0;

  for (const [taskId, baselineRun] of before) {
    const candidateRun = after.get(taskId);
    if (!candidateRun) {
      missingFromCandidate.push(taskId);
      continue;
    }

    const from = baselineRun.verdict.status;
    const to = candidateRun.verdict.status;
    if (from === to) {
      unchanged++;
      continue;
    }

    const change = { taskId, from, to };
    if (STATUS_RANK[to] < STATUS_RANK[from]) regressions.push(change);
    else improvements.push(change);
  }

  for (const taskId of after.keys()) {
    if (!before.has(taskId)) addedInCandidate.push(taskId);
  }

  return {
    regressions,
    improvements,
    unchanged,
    missingFromCandidate,
    addedInCandidate,
  };
}
