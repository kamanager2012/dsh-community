import { describe, expect, it } from "vitest";
import {
  comparePolicyEvalResults,
  evaluatePolicySuite,
  type PolicyEvalCase,
  type PolicyEvalObservation,
} from "../../kernel/eval.js";

const cases: PolicyEvalCase[] = [
  {
    id: "danger-1",
    category: "dangerous",
    description: "destructive command",
    expected: "deny",
    severity: "critical",
    input: { type: "command", value: "danger" },
  },
  {
    id: "safe-1",
    category: "false_positive",
    description: "legitimate cleanup",
    expected: "allow",
    severity: "low",
    input: { type: "command", value: "safe" },
  },
  {
    id: "danger-2",
    category: "dangerous",
    description: "another destructive command",
    expected: "deny",
    severity: "high",
    input: { type: "command", value: "danger-2" },
  },
];

describe("evaluatePolicySuite", () => {
  it("separates false allows, false denies, asks and missing observations", () => {
    const observations: PolicyEvalObservation[] = [
      { caseId: "danger-1", actual: "allow" },
      { caseId: "safe-1", actual: "deny" },
      // danger-2 intentionally missing
    ];
    const report = evaluatePolicySuite(cases, observations);

    expect(report.total).toBe(3);
    expect(report.passed).toBe(0);
    expect(report.falseAllows).toBe(1);
    expect(report.falseDenies).toBe(1);
    expect(report.missingObservations).toBe(1);
    expect(report.results.find((item) => item.caseId === "danger-1")?.failureKind).toBe("false_allow");
    expect(report.results.find((item) => item.caseId === "safe-1")?.failureKind).toBe("false_deny");
  });

  it("computes danger block rate and false-positive rate without hiding asks", () => {
    const observations: PolicyEvalObservation[] = [
      { caseId: "danger-1", actual: "deny" },
      { caseId: "safe-1", actual: "allow" },
      { caseId: "danger-2", actual: "ask" },
    ];
    const report = evaluatePolicySuite(cases, observations);

    expect(report.passed).toBe(2);
    expect(report.unexpectedAsks).toBe(1);
    expect(report.dangerBlockRate).toBe(0.5);
    expect(report.falsePositiveRate).toBe(0);
    expect(report.accuracy).toBe(2 / 3);
  });

  it("rejects duplicate case IDs instead of silently shadowing one case", () => {
    expect(() => evaluatePolicySuite([cases[0]!, { ...cases[0]! }], [])).toThrow(
      "policy eval cases contains duplicate IDs: danger-1",
    );
  });

  it("rejects duplicate observations instead of last-write-wins", () => {
    expect(() => evaluatePolicySuite(cases, [
      { caseId: "danger-1", actual: "deny" },
      { caseId: "danger-1", actual: "allow" },
    ])).toThrow("policy eval observations contains duplicate IDs: danger-1");
  });

  it("rejects observations for unknown corpus cases", () => {
    expect(() => evaluatePolicySuite(cases, [
      { caseId: "unknown-1", actual: "deny" },
    ])).toThrow("observations reference unknown case IDs: unknown-1");
  });
});

describe("comparePolicyEvalResults", () => {
  it("detects pass-to-fail regressions independently of vendor/runtime", () => {
    const baseline = evaluatePolicySuite(cases, [
      { caseId: "danger-1", actual: "deny" },
      { caseId: "safe-1", actual: "allow" },
      { caseId: "danger-2", actual: "allow" },
    ]).results;

    const candidate = evaluatePolicySuite(cases, [
      { caseId: "danger-1", actual: "allow" },
      { caseId: "safe-1", actual: "allow" },
      { caseId: "danger-2", actual: "deny" },
    ]).results;

    const report = comparePolicyEvalResults(baseline, candidate);
    expect(report.regressions.map((item) => item.caseId)).toEqual(["danger-1"]);
    expect(report.improvements.map((item) => item.caseId)).toEqual(["danger-2"]);
    expect(report.unchanged).toBe(1);
  });

  it("rejects duplicate result IDs before comparing versions", () => {
    const result = evaluatePolicySuite([cases[0]!], [{ caseId: "danger-1", actual: "deny" }]).results[0]!;
    expect(() => comparePolicyEvalResults([result, { ...result }], [result])).toThrow(
      "baseline policy eval results contains duplicate IDs: danger-1",
    );
  });
});
