import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalPolicy } from "../../governor/policy.js";
import { loadAcsV1Cases } from "../helpers/acs_corpus.js";

interface CanonicalBaseline {
  schemaVersion: number;
  profile: string;
  policySemanticsCommit: string;
  policy: CanonicalPolicy;
  sourceCorpus: { name: string; commit: string; totalCases: number };
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

function loadBaseline(): CanonicalBaseline {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "shadow", "evals", "policy", "canonical-v1", "baseline.json"),
      "utf8",
    ),
  ) as CanonicalBaseline;
}

describe("canonical-v1 historical baseline", () => {
  it("is internally consistent with the pinned ACS-v1 corpus and provenance", () => {
    const cases = loadAcsV1Cases();
    const baseline = loadBaseline();
    const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
    const falseAllows = new Set(baseline.falseAllowIds);
    const falseDenies = new Set(baseline.falseDenyIds);

    expect(baseline.schemaVersion).toBe(1);
    expect(baseline.profile).toBe("aios-default-policy-pre-hardening");
    expect(baseline.policySemanticsCommit).toBe("aa927b7ef1488133b94bde274121281d6c0b0797");
    expect(baseline.sourceCorpus.name).toBe("acs-v1");
    expect(baseline.sourceCorpus.commit).toBe("a8e41fa27822f32d2a39163767ef2d5413b9c30d");
    expect(baseline.sourceCorpus.totalCases).toBe(105);
    expect(cases).toHaveLength(105);

    expect(baseline.policy.allowedPaths).toEqual(["**/*"]);
    expect(baseline.policy.deniedCommands).toEqual([
      "rm -rf /",
      "sudo",
      "shutdown",
      "reboot",
      "mkfs",
      "dd if=",
    ]);

    expect(falseAllows.size).toBe(baseline.falseAllowIds.length);
    expect(falseDenies.size).toBe(baseline.falseDenyIds.length);
    expect([...falseAllows].some((id) => falseDenies.has(id))).toBe(false);

    for (const id of falseAllows) {
      expect(byId.get(id)?.expected).toBe("deny");
    }
    for (const id of falseDenies) {
      expect(byId.get(id)?.expected).toBe("allow");
    }

    const denyCases = cases.filter((testCase) => testCase.expected === "deny").length;
    const allowCases = cases.filter((testCase) => testCase.expected === "allow").length;
    const failed = falseAllows.size + falseDenies.size;
    const passed = cases.length - failed;

    expect(baseline.metrics.falseAllows).toBe(falseAllows.size);
    expect(baseline.metrics.falseDenies).toBe(falseDenies.size);
    expect(baseline.metrics.failed).toBe(failed);
    expect(baseline.metrics.passed).toBe(passed);
    expect(baseline.metrics.missingObservations).toBe(0);
    expect(baseline.metrics.unexpectedAsks).toBe(0);
    expect(baseline.metrics.dangerBlockRate).toBeCloseTo((denyCases - falseAllows.size) / denyCases);
    expect(baseline.metrics.falsePositiveRate).toBeCloseTo(falseDenies.size / allowCases);
    expect(baseline.metrics.accuracy).toBeCloseTo(passed / cases.length);
  });
});
