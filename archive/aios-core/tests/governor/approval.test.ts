import { describe, it, expect } from "vitest";
import { inferApproval, checkApproval, effectiveApproval } from "../../governor/approval.js";
import type { Plan } from "../../kernel/schema/index.js";

const basePlan: Plan = {
  task: "test", scope: ["src/**"], risk: "low", files: ["src/a.ts"],
  steps: [{ order: 1, action: "edit", target: "src/a.ts" }],
  tests: [], rollback: "git revert", approval: "AUTO", createdAt: "", frozen: false,
};

describe("inferApproval", () => {
  it("returns AUTO for low risk small changes", () => {
    expect(inferApproval(basePlan)).toBe("AUTO");
  });

  it("returns MANUAL for medium risk", () => {
    expect(inferApproval({ ...basePlan, risk: "medium" })).toBe("MANUAL");
  });

  it("returns MANUAL for high risk", () => {
    expect(inferApproval({ ...basePlan, risk: "high" })).toBe("MANUAL");
  });

  it("returns MANUAL for config files", () => {
    expect(inferApproval({ ...basePlan, files: ["package.json"] })).toBe("MANUAL");
  });

  it("returns MANUAL for delete actions", () => {
    expect(inferApproval({ ...basePlan, steps: [{ order: 1, action: "delete", target: "src/a.ts" }] })).toBe("MANUAL");
  });
});

describe("effectiveApproval", () => {
  it("returns AUTO for unprotected low-risk plans", () => {
    expect(effectiveApproval(basePlan)).toBe("AUTO");
  });

  it("returns MANUAL for explicit MANUAL", () => {
    expect(effectiveApproval({ ...basePlan, approval: "MANUAL" })).toBe("MANUAL");
  });

  it("forces MANUAL when plan touches protected paths even if model said AUTO", () => {
    // Regression: the model could self-approve config/secret-adjacent
    // changes via `approval: AUTO` in its YAML — protected paths must
    // override to MANUAL.
    expect(effectiveApproval({ ...basePlan, files: [".env"] })).toBe("MANUAL");
    expect(effectiveApproval({ ...basePlan, files: ["config/secrets/prod.json"] })).toBe("MANUAL");
    expect(effectiveApproval({ ...basePlan, files: [".claude/settings.json"] })).toBe("MANUAL");
    expect(effectiveApproval({ ...basePlan, files: ["CLAUDE.md"] })).toBe("MANUAL");
  });

  it("keeps AUTO for plans with a protected path among safe files", () => {
    // .env.in.example is not .env
    expect(effectiveApproval({ ...basePlan, files: ["src/a.ts", ".env.example"] })).toBe("AUTO");
  });
});

describe("checkApproval", () => {
  it("AUTO plans pass immediately", () => {
    const result = checkApproval({ ...basePlan, approval: "AUTO" });
    expect(result.ok).toBe(true);
  });

  it("MANUAL plans require askHuman", () => {
    const result = checkApproval({ ...basePlan, approval: "MANUAL" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no askHuman");
  });

  it("MANUAL plans pass when human confirms", () => {
    const result = checkApproval(
      { ...basePlan, approval: "MANUAL" },
      () => true,
    );
    expect(result.ok).toBe(true);
  });

  it("MANUAL plans fail when human denies", () => {
    const result = checkApproval(
      { ...basePlan, approval: "MANUAL" },
      () => false,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("denied");
  });
});
