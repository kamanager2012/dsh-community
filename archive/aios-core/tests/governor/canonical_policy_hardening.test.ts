import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  comparePolicyEvalResults,
  evaluatePolicySuite,
  type PolicyEvalCase,
  type PolicyEvalObservation,
  type PolicyEvalResult,
} from "../../kernel/eval.js";
import type { CanonicalPolicy } from "../../governor/policy.js";
import { ScopeValidator } from "../../governor/scope.js";
import { loadAcsV1Cases } from "../helpers/acs_corpus.js";

interface StoredBaseline {
  profile: string;
  policy: CanonicalPolicy;
  metrics: {
    passed: number;
    failed: number;
    falseAllows: number;
    falseDenies: number;
    unexpectedAsks: number;
    missingObservations: number;
    dangerBlockRate: number;
    falsePositiveRate: number;
    accuracy: number;
  };
  falseAllowIds: string[];
  falseDenyIds: string[];
}

interface HardenedBaseline extends StoredBaseline {
  predecessor: string;
  improvementIds: string[];
  regressionIds: string[];
}

function loadJson<T>(version: string): T {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "shadow", "evals", "policy", version, "baseline.json"),
      "utf8",
    ),
  ) as T;
}

function observe(testCase: PolicyEvalCase, scope: ScopeValidator): PolicyEvalObservation {
  if (testCase.input.type === "path") {
    const allowed = scope.validatePath(testCase.input.value) && scope.validateFileType(testCase.input.value);
    return { caseId: testCase.id, actual: allowed ? "allow" : "deny" };
  }

  const command = testCase.input.value;
  if (!scope.validateCommand(command)) return { caseId: testCase.id, actual: "deny" };
  if (scope.isMassDelete(command)) return { caseId: testCase.id, actual: "deny" };
  if (scope.commandTargetsDeniedPath(command)) return { caseId: testCase.id, actual: "deny" };
  if (scope.usesElevatedCommand(command)) return { caseId: testCase.id, actual: "ask" };
  return { caseId: testCase.id, actual: "allow" };
}

function storedBaselineResults(cases: PolicyEvalCase[], baseline: StoredBaseline): PolicyEvalResult[] {
  const falseAllows = new Set(baseline.falseAllowIds);
  const falseDenies = new Set(baseline.falseDenyIds);

  return cases.map((testCase) => {
    if (falseAllows.has(testCase.id)) {
      return {
        caseId: testCase.id,
        category: testCase.category,
        expected: testCase.expected,
        actual: "allow",
        pass: false,
        severity: testCase.severity,
        failureKind: "false_allow",
      };
    }
    if (falseDenies.has(testCase.id)) {
      return {
        caseId: testCase.id,
        category: testCase.category,
        expected: testCase.expected,
        actual: "deny",
        pass: false,
        severity: testCase.severity,
        failureKind: "false_deny",
      };
    }
    return {
      caseId: testCase.id,
      category: testCase.category,
      expected: testCase.expected,
      actual: testCase.expected,
      pass: true,
      severity: testCase.severity,
    };
  });
}

describe("canonical default policy hardening", () => {
  it("matches canonical-v1.1 and has zero regression from canonical-v1", () => {
    const cases = loadAcsV1Cases();
    const baseline = loadJson<StoredBaseline>("canonical-v1");
    const hardened = loadJson<HardenedBaseline>("canonical-v1.1");
    const baselineResults = storedBaselineResults(cases, baseline);
    const scope = new ScopeValidator();
    const candidate = evaluatePolicySuite(cases, cases.map((testCase) => observe(testCase, scope)));
    const comparison = comparePolicyEvalResults(baselineResults, candidate.results);

    expect(hardened.profile).toBe("aios-default-policy-hardened-v1.1");
    expect(hardened.predecessor).toBe("canonical-v1");
    expect(scope.policy).toEqual(hardened.policy);

    expect({
      passed: candidate.passed,
      failed: candidate.failed,
      falseAllows: candidate.falseAllows,
      falseDenies: candidate.falseDenies,
      unexpectedAsks: candidate.unexpectedAsks,
      missingObservations: candidate.missingObservations,
      dangerBlockRate: candidate.dangerBlockRate,
      falsePositiveRate: candidate.falsePositiveRate,
      accuracy: candidate.accuracy,
    }).toEqual(hardened.metrics);

    const candidateFalseAllowIds = candidate.results
      .filter((result) => result.failureKind === "false_allow")
      .map((result) => result.caseId);
    const candidateFalseDenyIds = candidate.results
      .filter((result) => result.failureKind === "false_deny")
      .map((result) => result.caseId);
    const improvementIds = comparison.improvements.map((change) => change.caseId);
    const regressionIds = comparison.regressions.map((change) => change.caseId);

    expect(candidateFalseAllowIds).toEqual(hardened.falseAllowIds);
    expect(candidateFalseDenyIds).toEqual(hardened.falseDenyIds);
    expect(improvementIds).toEqual(hardened.improvementIds);
    expect(regressionIds).toEqual(hardened.regressionIds);
    expect(regressionIds).toEqual([]);
  });
});
