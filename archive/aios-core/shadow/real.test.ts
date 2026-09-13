// AIOS Core — Real shadow test.
// Uses actual vitest/tsc for verification, rule-based planner.
// Validates that the runtime produces correct plans and decisions
// for self-shadow tasks (aios-core managing its own development).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runTask } from "../kernel/runtime.js";
import { createRealDeps, resetSeq } from "./real_deps.js";
import { BATCH_1 } from "./tasks.js";
import { buildContext } from "../memory/context.js";
import { ScopeValidator } from "../governor/scope.js";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "real-shadow-"));
  resetSeq();
});

afterEach(async () => {
  try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("Real shadow — planner inference", () => {
  it("infers low risk for small patches", async () => {
    const deps = createRealDeps({}, tmpDir);
    const smallTasks = BATCH_1.filter((t) => t.category === "small-patch");

    for (const t of smallTasks) {
      const state = await runTask({ goal: t.goal, project: "aios-core" }, deps);
      expect(state.plan).not.toBeNull();
      expect(state.plan!.risk).toBe("low");
      expect(state.plan!.approval).toBe("AUTO");
    }
  });

  it("infers medium risk for config changes", async () => {
    const deps = createRealDeps({}, tmpDir);
    const configTasks = BATCH_1.filter((t) => t.category === "config");

    for (const t of configTasks) {
      const state = await runTask({ goal: t.goal, project: "aios-core" }, deps);
      expect(state.plan).not.toBeNull();
      expect(state.plan!.risk).toBe("medium");
      expect(state.plan!.approval).toBe("MANUAL");
    }
  });

  it("infers high risk for refactors and migrations", async () => {
    const deps = createRealDeps({}, tmpDir);
    const refactorTasks = BATCH_1.filter((t) => t.category === "refactor");

    for (const t of refactorTasks) {
      const state = await runTask({ goal: t.goal, project: "aios-core" }, deps);
      expect(state.plan).not.toBeNull();
      expect(state.plan!.risk).toBe("high");
      expect(state.plan!.approval).toBe("MANUAL");
    }
  });
});

describe("Real shadow — scope validation", () => {
  it("rejects plans with /etc/passwd via ScopeValidator", () => {
    const validator = new ScopeValidator();
    const plan = {
      task: "test",
      risk: "low" as const,
      files: ["some/code.ts", "/etc/passwd"],
      steps: [{ order: 1, action: "edit", target: "/etc/passwd" }],
      scope: ["src/**"],
      approval: "AUTO" as const,
      tests: [],
      rollback: "",
      createdAt: "2024-01-01",
      frozen: false,
    };
    const result = validator.validatePlan(plan);
    expect(result).toBe(false);
  });

  it("allows plans with safe files", () => {
    const validator = new ScopeValidator();
    const plan = {
      task: "test",
      risk: "low" as const,
      files: ["src/code.ts"],
      steps: [{ order: 1, action: "edit", target: "src/code.ts" }],
      scope: ["src/**"],
      approval: "AUTO" as const,
      tests: [],
      rollback: "",
      createdAt: "2024-01-01",
      frozen: false,
    };
    const result = validator.validatePlan(plan);
    expect(result).toBe(true);
  });
});

describe("Real shadow — memory accumulation", () => {
  it("accumulates tasks and decisions after commits", async () => {
    const deps = createRealDeps({}, tmpDir);
    const commitTasks = BATCH_1.filter((t) => t.expectDecision === "COMMIT" && t.category !== "rejection");

    for (const t of commitTasks.slice(0, 5)) {
      await runTask({ goal: t.goal, project: "aios-core" }, deps);
    }

    const memory = (deps as any)._memory as import("../memory/index.js").MemoryStore;
    const c = memory.count();
    expect(c.tasks).toBeGreaterThanOrEqual(5);
    expect(c.decisions).toBeGreaterThanOrEqual(5);
    expect(c.snapshots).toBeGreaterThanOrEqual(5);
  });
});

describe("Real shadow — context generation", () => {
  it("builds context from accumulated memory", async () => {
    const deps = createRealDeps({}, tmpDir);
    const tasks = BATCH_1.filter((t) => t.category === "small-patch").slice(0, 3);

    for (const t of tasks) {
      await runTask({ goal: t.goal, project: "aios-core" }, deps);
    }

    const memory = (deps as any)._memory as import("../memory/index.js").MemoryStore;
    const ctx = await buildContext(memory, null);
    expect(ctx.recentTasks.length).toBeGreaterThanOrEqual(1);
    expect(ctx.recentDecisions.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Real shadow — decision distribution", () => {
  it("produces COMMIT for all tasks in shadow mode", async () => {
    const deps = createRealDeps({}, tmpDir);
    const decisions: { id: string; decision: string | null }[] = [];

    const runnable = BATCH_1.filter((t) => t.id !== "R-013" && t.id !== "R-014" && t.id !== "R-015");

    for (const t of runnable) {
      const state = await runTask({ goal: t.goal, project: "aios-core" }, deps);
      decisions.push({ id: t.id, decision: state.decision });
    }

    const commits = decisions.filter((d) => d.decision === "COMMIT");
    expect(commits.length).toBe(runnable.length);
  });
});
