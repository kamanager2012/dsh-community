import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcsClient } from "../../governor/acs_client.js";
import { AcsBridge } from "../../governor/acs_bridge.js";
import type { Plan } from "../../kernel/schema/index.js";

function makeRuntimeDir(): string {
  return mkdtempSync(join(tmpdir(), "acs-client-"));
}

function makePlan(files: string[]): Plan {
  return {
    task: "test task",
    scope: ["src/**"],
    risk: "low",
    files,
    steps: [{ order: 1, action: "fix", target: files[0] ?? "src/a.ts" }],
    tests: [],
    rollback: "git revert",
    approval: "AUTO",
    createdAt: "2026-01-01T00:00:00Z",
    frozen: true,
  };
}

describe("AcsClient — real ACS runtime file shapes", () => {
  it("reads allowed_dirs from ACTIVE_TASK.json (v5.x real shape)", () => {
    const dir = makeRuntimeDir();
    writeFileSync(join(dir, "ACTIVE_TASK.json"), JSON.stringify({
      version: "5.0",
      task: "fix-login",
      task_id: "fix-login",
      status: "ACTIVE",
      allowed_dirs: ["/proj/src", "/proj/data"],
      allowed_files: ["/proj/src"],
      blocked_commands: [],
      shadow_mode: false,
      proposal_required: false,
    }));
    const client = new AcsClient(dir);
    const s = client.status();
    expect(s.task).toBe("fix-login");
    expect(s.dirs).toEqual(["/proj/src", "/proj/data"]);
    expect(s.shadow).toBe(false);
    expect(s.proposal).toBe(false);
    expect(client.isPathInScope("/proj/src/a.ts")).toBe(true);
    expect(client.isPathInScope("/etc/passwd")).toBe(false);
  });

  it("reads window_score from VIOLATIONS.json (real shape)", () => {
    const dir = makeRuntimeDir();
    writeFileSync(join(dir, "ACTIVE_TASK.json"), JSON.stringify({ task_id: "t1", allowed_dirs: ["/proj"] }));
    writeFileSync(join(dir, "VIOLATIONS.json"), JSON.stringify({
      events: [{ ts: 1, score: 100, reason: "x", pinned: false }],
      window_score: 100,
    }));
    const client = new AcsClient(dir);
    const s = client.status();
    expect(s.violations.window).toBe(100);
    expect(s.acsAvailable).toBe(true);
    expect(client.getViolations().length).toBe(1);
  });

  it("falls back to legacy dirs key when allowed_dirs absent", () => {
    const dir = makeRuntimeDir();
    writeFileSync(join(dir, "ACTIVE_TASK.json"), JSON.stringify({ task: "old", dirs: ["/legacy"] }));
    const client = new AcsClient(dir);
    expect(client.getScope()).toEqual(["/legacy"]);
  });

  it("reports acsAvailable=false when runtime dir missing", () => {
    const client = new AcsClient("/nonexistent-xyz");
    const s = client.status();
    expect(s.acsAvailable).toBe(false);
    expect(s.dirs).toEqual([]);
    expect(s.locked).toBe(false);
  });
});

describe("AcsBridge — enforcement against real file shapes", () => {
  it("rejects plans out of the real ACS scope (fail closed)", () => {
    const dir = makeRuntimeDir();
    writeFileSync(join(dir, "ACTIVE_TASK.json"), JSON.stringify({ task_id: "t", allowed_dirs: ["/proj/src"] }));
    writeFileSync(join(dir, "VIOLATIONS.json"), JSON.stringify({ events: [], window_score: 0 }));
    const bridge = new AcsBridge(new AcsClient(dir));

    const inScope = bridge.preflight(makePlan(["/proj/src/a.ts"]));
    expect(inScope.ok).toBe(true);

    const outOfScope = bridge.preflight(makePlan(["/proj/other/b.ts"]));
    expect(outOfScope.ok).toBe(false);
    expect(outOfScope.reason).toContain("ACS scope violation");
  });

  it("rejects all writes when scope is empty (ACS baseline is read-only)", () => {
    // Regression: dirs.length === 0 used to skip enforcement entirely.
    const dir = makeRuntimeDir();
    writeFileSync(join(dir, "ACTIVE_TASK.json"), JSON.stringify({ task_id: "t", allowed_dirs: [] }));
    writeFileSync(join(dir, "VIOLATIONS.json"), JSON.stringify({ events: [], window_score: 0 }));
    const bridge = new AcsBridge(new AcsClient(dir));
    const result = bridge.preflight(makePlan(["/anything/at/all.ts"]));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ACS scope violation");
  });

  it("skips ACS rules only when ACS is not installed at all", () => {
    const bridge = new AcsBridge(new AcsClient("/nonexistent-xyz"));
    const result = bridge.preflight(makePlan(["/anything/at/all.ts"]));
    expect(result.ok).toBe(true); // AIOS rules only
  });
});
