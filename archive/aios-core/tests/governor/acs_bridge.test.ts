import { describe, it, expect } from "vitest";
import { AcsClient, type AcsStatus } from "../../governor/acs_client.js";
import { AcsBridge, type MatrixVerdict } from "../../governor/acs_bridge.js";
import { ScopeValidator, ACS_DENIED_PATHS } from "../../governor/scope.js";
import { inferApproval, checkApprovalWithAcs } from "../../governor/approval.js";
import type { Plan } from "../../kernel/schema/index.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockClient(overrides?: Partial<AcsClient>): AcsClient {
  const client = new AcsClient("/nonexistent");
  // Default: scope matches makePlan()'s files: ["src/a.ts"]
  client.getScope = () => ["src/"];
  client.isLocked = () => false;
  client.status = () => makeStatus();
  if (overrides?.status) client.status = overrides.status;
  if (overrides?.isLocked) client.isLocked = overrides.isLocked;
  if (overrides?.getScope) client.getScope = overrides.getScope;
  if (overrides?.isPathInScope) client.isPathInScope = overrides.isPathInScope;
  return client;
}

function makeStatus(overrides?: Partial<AcsStatus>): AcsStatus {
  return {
    task: "test",
    dirs: ["src/"],
    shadow: false,
    proposal: false,
    violations: { window: 0, windowMax: 80, total: 0, totalMax: 150 },
    locked: false,
    acsAvailable: true,
    ...overrides,
  };
}

function makePlan(overrides?: Partial<Plan>): Plan {
  return {
    task: "test task",
    scope: ["src/**"],
    risk: "low",
    files: ["src/a.ts"],
    steps: [{ order: 1, action: "fix", target: "src/a.ts" }],
    tests: [],
    rollback: "git revert",
    approval: "AUTO",
    createdAt: "2026-01-01T00:00:00Z",
    frozen: true,
    ...overrides,
  };
}

// ── AcsClient ──────────────────────────────────────────────────────────────

describe("AcsClient", () => {
  it("reports locked status", () => {
    const client = createMockClient({ isLocked: () => true });
    expect(client.isLocked()).toBe(true);
  });

  it("reports unlocked status", () => {
    const client = createMockClient({ isLocked: () => false });
    expect(client.isLocked()).toBe(false);
  });

  it("returns scope directories", () => {
    const client = createMockClient({ getScope: () => ["src/", "lib/"] });
    expect(client.getScope()).toEqual(["src/", "lib/"]);
  });

  it("checks if path is in scope", () => {
    const client = createMockClient({ isPathInScope: (p: string) => p.startsWith("src/") });
    expect(client.isPathInScope("src/foo.ts")).toBe(true);
    expect(client.isPathInScope("etc/passwd")).toBe(false);
  });
});

// ── AcsBridge 4-way matrix ─────────────────────────────────────────────────

describe("AcsBridge", () => {
  it("returns SAFE_ALLOW when both AIOS and ACS allow", () => {
    const bridge = new AcsBridge(createMockClient({ status: () => makeStatus() }));
    const result = bridge.preflight(makePlan());
    expect(result.ok).toBe(true);
    expect(result.matrix?.verdict).toBe("SAFE_ALLOW");
  });

  it("returns RISK_ALLOW when AIOS allows but ACS scope denies", () => {
    const bridge = new AcsBridge(createMockClient({
      status: () => makeStatus({ dirs: ["lib/"] }),
      isLocked: () => false,
      getScope: () => ["lib/"],
    }));
    const result = bridge.preflight(makePlan({ files: ["src/a.ts"] }));
    expect(result.ok).toBe(false);
    expect(result.matrix?.verdict).toBe("RISK_ALLOW");
    expect(result.matrix?.acsDecision).toBe("DENY");
    expect(result.matrix?.aiosDecision).toBe("ALLOW");
  });

  it("returns SAFE_DENY when AIOS denies (protected path) but ACS allows", () => {
    const bridge = new AcsBridge(createMockClient({
      status: () => makeStatus({ dirs: [".claude/", "src/"] }),
      getScope: () => [".claude/", "src/"],
    }));
    const result = bridge.preflight(makePlan({ files: [".claude/hooks/acs_lite.py"] }));
    expect(result.ok).toBe(false);
    expect(result.matrix?.verdict).toBe("SAFE_DENY");
    expect(result.matrix?.aiosDecision).toBe("DENY");
    expect(result.matrix?.acsDecision).toBe("ALLOW");
  });

  it("returns RISK_DENY when both deny (ACS locked)", () => {
    const bridge = new AcsBridge(createMockClient({ status: () => makeStatus({ locked: true }) }));
    const result = bridge.preflight(makePlan({ files: [".claude/settings.json"] }));
    expect(result.ok).toBe(false);
    expect(result.matrix?.verdict).toBe("RISK_DENY");
  });

  it("returns RISK_ALLOW when violation pressure is high", () => {
    const bridge = new AcsBridge(createMockClient({
      status: () => makeStatus({ violations: { window: 70, windowMax: 80, total: 50, totalMax: 150 } }),
    }));
    const result = bridge.preflight(makePlan());
    expect(result.ok).toBe(false);
    expect(result.matrix?.verdict).toBe("RISK_ALLOW");
    expect(result.reason).toContain("violation pressure");
  });

  it("includes ACS status in result", () => {
    const bridge = new AcsBridge(createMockClient({ status: () => makeStatus() }));
    const result = bridge.preflight(makePlan());
    expect(result.acsStatus?.locked).toBe(false);
    expect(result.acsStatus?.scope).toEqual(["src/"]);
  });
});

// ── ScopeValidator with ACS ─────────────────────────────────────────────────

describe("ScopeValidator ACS integration", () => {
  it("does not inject ACS/Claude-specific paths into canonical default policy", () => {
    const sv = new ScopeValidator();
    expect(sv.validatePath(".claude/audit/entry.json")).toBe(true);
    expect(sv.validatePath(".claude/hooks/acs_lite.py")).toBe(true);
    expect(sv.validatePath(".claude/settings.json")).toBe(true);
  });

  it("denies ACS protected paths when legacy ACS compatibility is explicitly enabled", () => {
    const sv = new ScopeValidator({
      acs: createMockClient({ getScope: () => [".claude/"] }),
    });
    const result = sv.validatePlanWithAcs(makePlan({ files: [".claude/hooks/acs_lite.py"] }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ACS protected path");
  });

  it("validatePlanWithAcs passes for in-scope plan", () => {
    const sv = new ScopeValidator({ acs: createMockClient() });
    const result = sv.validatePlanWithAcs(makePlan());
    expect(result.ok).toBe(true);
  });

  it("validatePlanWithAcs fails when ACS is locked", () => {
    const sv = new ScopeValidator({ acs: createMockClient({ isLocked: () => true }) });
    const result = sv.validatePlanWithAcs(makePlan());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ACS is locked");
  });

  it("validatePlanWithAcs fails for out-of-scope files", () => {
    const sv = new ScopeValidator({ acs: createMockClient({
      getScope: () => ["lib/"],
      isPathInScope: (p: string) => p.startsWith("lib/"),
    }) });
    const result = sv.validatePlanWithAcs(makePlan({ files: ["src/a.ts"] }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ACS scope violation");
  });
});

// ── Approval with ACS ───────────────────────────────────────────────────────

describe("Approval ACS integration", () => {
  it("auto-approves low risk plan when ACS is not locked", () => {
    const result = checkApprovalWithAcs(makePlan(), createMockClient());
    expect(result.approved).toBe(true);
    expect(result.level).toBe("AUTO");
  });

  it("rejects when ACS is locked", () => {
    const result = checkApprovalWithAcs(makePlan(), createMockClient({ isLocked: () => true }));
    expect(result.approved).toBe(false);
    expect(result.acsLocked).toBe(true);
  });

  it("overrides AUTO to MANUAL for protected paths", () => {
    const result = checkApprovalWithAcs(
      makePlan({ approval: "AUTO", files: [".env"] }),
      createMockClient(),
    );
    expect(result.approved).toBe(false);
    expect(result.level).toBe("MANUAL");
  });

  it("still infers MANUAL for high risk plans", () => {
    expect(inferApproval(makePlan({ risk: "high" }))).toBe("MANUAL");
    expect(inferApproval(makePlan({ risk: "medium" }))).toBe("MANUAL");
    expect(inferApproval(makePlan({ risk: "low" }))).toBe("AUTO");
  });
});

// ── 4-way matrix verdict table ──────────────────────────────────────────────

describe("4-way matrix verdict computation", () => {
  it("SAFE_ALLOW: both AIOS and ACS allow", () => {
    const bridge = new AcsBridge(createMockClient({ status: () => makeStatus() }));
    const result = bridge.preflight(makePlan({ files: ["src/a.ts"] }));
    expect(result.matrix?.verdict).toBe("SAFE_ALLOW");
  });

  it("RISK_ALLOW: AIOS allows, ACS denies (scope mismatch)", () => {
    const bridge = new AcsBridge(createMockClient({
      status: () => makeStatus({ dirs: ["lib/"] }),
      getScope: () => ["lib/"],
    }));
    const result = bridge.preflight(makePlan({ files: ["src/a.ts"] }));
    expect(result.matrix?.verdict).toBe("RISK_ALLOW");
  });

  it("SAFE_DENY: AIOS denies (protected path), ACS allows", () => {
    const bridge = new AcsBridge(createMockClient({
      status: () => makeStatus({ dirs: [".claude/", "src/"] }),
      getScope: () => [".claude/", "src/"],
    }));
    const result = bridge.preflight(makePlan({ files: [".claude/settings.json"] }));
    expect(result.matrix?.verdict).toBe("SAFE_DENY");
  });

  it("RISK_DENY: AIOS denies, ACS also denies (locked)", () => {
    const bridge = new AcsBridge(createMockClient({ status: () => makeStatus({ locked: true }) }));
    const result = bridge.preflight(makePlan({ files: [".claude/settings.json"] }));
    expect(result.matrix?.verdict).toBe("RISK_DENY");
  });
});
