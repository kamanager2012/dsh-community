// AIOS Core — Vendor-neutral policy evaluation.
//
// Pure result evaluator. It does not execute commands, inspect files, or call
// any agent/vendor runtime. Adapters produce observations; this module decides
// whether those observations satisfy the benchmark case and compares versions.

export type PolicyExpectedDecision = "allow" | "deny";
export type PolicyObservedDecision = "allow" | "deny" | "ask";
export type PolicyEvalSeverity = "low" | "medium" | "high" | "critical";

export type PolicyEvalInput =
  | { type: "command"; value: string }
  | { type: "path"; value: string };

export interface PolicyEvalCase {
  id: string;
  category: string;
  description: string;
  expected: PolicyExpectedDecision;
  severity: PolicyEvalSeverity;
  input: PolicyEvalInput;
  source?: {
    repository?: string;
    path?: string;
    legacyId?: string;
  };
  tags?: string[];
}

export interface PolicyEvalObservation {
  caseId: string;
  actual: PolicyObservedDecision;
  reason?: string;
  latencyMs?: number;
}

export type PolicyEvalFailureKind =
  | "false_allow"
  | "false_deny"
  | "unexpected_ask"
  | "missing_observation";

export interface PolicyEvalResult {
  caseId: string;
  category: string;
  expected: PolicyExpectedDecision;
  actual: PolicyObservedDecision | "missing";
  pass: boolean;
  severity: PolicyEvalSeverity;
  failureKind?: PolicyEvalFailureKind;
  reason?: string;
  latencyMs?: number;
}

export interface PolicyEvalCategorySummary {
  total: number;
  passed: number;
  failed: number;
}

export interface PolicyEvalReport {
  total: number;
  passed: number;
  failed: number;
  falseAllows: number;
  falseDenies: number;
  unexpectedAsks: number;
  missingObservations: number;
  denyCases: number;
  denyCorrect: number;
  allowCases: number;
  allowCorrect: number;
  accuracy: number | null;
  dangerBlockRate: number | null;
  falsePositiveRate: number | null;
  byCategory: Record<string, PolicyEvalCategorySummary>;
  results: PolicyEvalResult[];
}

export interface PolicyEvalRegressionChange {
  caseId: string;
  fromPass: boolean;
  toPass: boolean;
  fromActual: PolicyEvalResult["actual"];
  toActual: PolicyEvalResult["actual"];
}

export interface PolicyEvalRegressionReport {
  regressions: PolicyEvalRegressionChange[];
  improvements: PolicyEvalRegressionChange[];
  unchanged: number;
  missingFromCandidate: string[];
  addedInCandidate: string[];
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function assertUniqueIds(label: string, ids: string[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size > 0) {
    throw new Error(`${label} contains duplicate IDs: ${[...duplicates].sort().join(", ")}`);
  }
}

function assertObservationsBelongToCases(
  cases: PolicyEvalCase[],
  observations: PolicyEvalObservation[],
): void {
  const known = new Set(cases.map((item) => item.id));
  const unknown = [...new Set(
    observations.filter((item) => !known.has(item.caseId)).map((item) => item.caseId),
  )].sort();
  if (unknown.length > 0) {
    throw new Error(`observations reference unknown case IDs: ${unknown.join(", ")}`);
  }
}

function classify(
  expected: PolicyExpectedDecision,
  actual: PolicyObservedDecision,
): PolicyEvalFailureKind | undefined {
  if (actual === "ask") return "unexpected_ask";
  if (expected === actual) return undefined;
  return expected === "deny" ? "false_allow" : "false_deny";
}

export function evaluatePolicySuite(
  cases: PolicyEvalCase[],
  observations: PolicyEvalObservation[],
): PolicyEvalReport {
  // Benchmark ambiguity is itself an invalid run. Never let Map's last-write
  // behavior silently choose which duplicated case/observation becomes truth.
  assertUniqueIds("policy eval cases", cases.map((item) => item.id));
  assertUniqueIds("policy eval observations", observations.map((item) => item.caseId));
  assertObservationsBelongToCases(cases, observations);

  const observationByCase = new Map(observations.map((item) => [item.caseId, item]));
  const results: PolicyEvalResult[] = [];
  const byCategory: Record<string, PolicyEvalCategorySummary> = {};

  let passed = 0;
  let falseAllows = 0;
  let falseDenies = 0;
  let unexpectedAsks = 0;
  let missingObservations = 0;
  let denyCases = 0;
  let denyCorrect = 0;
  let allowCases = 0;
  let allowCorrect = 0;

  for (const testCase of cases) {
    if (testCase.expected === "deny") denyCases++;
    else allowCases++;

    const observation = observationByCase.get(testCase.id);
    let result: PolicyEvalResult;

    if (!observation) {
      missingObservations++;
      result = {
        caseId: testCase.id,
        category: testCase.category,
        expected: testCase.expected,
        actual: "missing",
        pass: false,
        severity: testCase.severity,
        failureKind: "missing_observation",
      };
    } else {
      const failureKind = classify(testCase.expected, observation.actual);
      const pass = failureKind === undefined;
      if (pass) {
        passed++;
        if (testCase.expected === "deny") denyCorrect++;
        else allowCorrect++;
      } else if (failureKind === "false_allow") {
        falseAllows++;
      } else if (failureKind === "false_deny") {
        falseDenies++;
      } else if (failureKind === "unexpected_ask") {
        unexpectedAsks++;
      }

      result = {
        caseId: testCase.id,
        category: testCase.category,
        expected: testCase.expected,
        actual: observation.actual,
        pass,
        severity: testCase.severity,
        ...(failureKind ? { failureKind } : {}),
        ...(observation.reason ? { reason: observation.reason } : {}),
        ...(observation.latencyMs !== undefined ? { latencyMs: observation.latencyMs } : {}),
      };
    }

    results.push(result);
    const category = byCategory[testCase.category] ?? { total: 0, passed: 0, failed: 0 };
    category.total++;
    if (result.pass) category.passed++;
    else category.failed++;
    byCategory[testCase.category] = category;
  }

  const total = cases.length;
  const failed = total - passed;
  return {
    total,
    passed,
    failed,
    falseAllows,
    falseDenies,
    unexpectedAsks,
    missingObservations,
    denyCases,
    denyCorrect,
    allowCases,
    allowCorrect,
    accuracy: ratio(passed, total),
    dangerBlockRate: ratio(denyCorrect, denyCases),
    falsePositiveRate: ratio(falseDenies, allowCases),
    byCategory,
    results,
  };
}

export function comparePolicyEvalResults(
  baseline: PolicyEvalResult[],
  candidate: PolicyEvalResult[],
): PolicyEvalRegressionReport {
  assertUniqueIds("baseline policy eval results", baseline.map((item) => item.caseId));
  assertUniqueIds("candidate policy eval results", candidate.map((item) => item.caseId));

  const before = new Map(baseline.map((item) => [item.caseId, item]));
  const after = new Map(candidate.map((item) => [item.caseId, item]));
  const regressions: PolicyEvalRegressionChange[] = [];
  const improvements: PolicyEvalRegressionChange[] = [];
  const missingFromCandidate: string[] = [];
  const addedInCandidate: string[] = [];
  let unchanged = 0;

  for (const [caseId, baselineResult] of before) {
    const candidateResult = after.get(caseId);
    if (!candidateResult) {
      missingFromCandidate.push(caseId);
      continue;
    }

    if (baselineResult.pass === candidateResult.pass) {
      unchanged++;
      continue;
    }

    const change: PolicyEvalRegressionChange = {
      caseId,
      fromPass: baselineResult.pass,
      toPass: candidateResult.pass,
      fromActual: baselineResult.actual,
      toActual: candidateResult.actual,
    };
    if (baselineResult.pass && !candidateResult.pass) regressions.push(change);
    else improvements.push(change);
  }

  for (const caseId of after.keys()) {
    if (!before.has(caseId)) addedInCandidate.push(caseId);
  }

  return {
    regressions,
    improvements,
    unchanged,
    missingFromCandidate,
    addedInCandidate,
  };
}
