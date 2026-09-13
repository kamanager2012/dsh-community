import { describe, expect, it } from "vitest";
import { evaluateReliability } from "../../kernel/reliability.js";
import type { EvidenceItem, TaskContract } from "../../kernel/schema/index.js";

const contract: TaskContract = {
  version: 1,
  requiredEvidence: ["test"],
  invariants: ["no-out-of-scope-write", "public-api-stable"],
};

const base: EvidenceItem[] = [
  {
    kind: "test",
    status: "pass",
    summary: "tests pass",
    metrics: { passed: 3, failed: 0, total: 3 },
  },
];

const invariants: EvidenceItem[] = [
  {
    kind: "invariant",
    id: "no-out-of-scope-write",
    status: "pass",
    summary: "no writes outside declared scope",
  },
  {
    kind: "invariant",
    id: "public-api-stable",
    status: "pass",
    summary: "public API unchanged",
  },
];

describe("named invariant contracts", () => {
  it("treats a missing named invariant as INCOMPLETE", () => {
    const verdict = evaluateReliability(contract, [base[0]!, invariants[0]!]);

    expect(verdict.status).toBe("INCOMPLETE");
    expect(verdict.missingEvidence).toContain("invariant");
    expect(verdict.reasons).toContain("required invariant missing: public-api-stable");
  });

  it("treats a failed named invariant as FAIL", () => {
    const failed: EvidenceItem = {
      ...invariants[1]!,
      status: "fail",
      summary: "export signature changed",
    };
    const verdict = evaluateReliability(contract, [base[0]!, invariants[0]!, failed]);

    expect(verdict.status).toBe("FAIL");
    expect(verdict.failedEvidence).toContain("invariant");
    expect(verdict.reasons).toContain("required invariant failed: public-api-stable");
  });

  it("passes only when every named invariant has passing evidence", () => {
    const verdict = evaluateReliability(contract, [...base, ...invariants]);

    expect(verdict.status).toBe("PASS");
  });
});
