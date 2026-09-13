/**
 * Reconciler 纯函数 property-based testing
 *
 * 使用 fast-check 做 property-based testing，验证:
 *   1. 相同输入 → 相同输出 (确定性)
 *   2. 输出结构始终合法
 *   3. 决策逻辑覆盖所有分支
 *
 * Reconciler 是 AIOS 的唯一决策出口，必须是纯函数。
 * v8.0 教训: 非纯函数的 reconciler 引入隐式依赖 → 行为不可预测。
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { reconcile } from "../../kernel/reconciler.js";
import type { ReconciliationInput } from "../../kernel/reconciler.js";
import type { Plan, ExecutionResult, VerificationReport, ProjectState } from "../../kernel/schema/index.js";

// ─── 自定义 arbitraries ────────────────────────────────

const planArb = fc.record({
  task: fc.string({ minLength: 1, maxLength: 20 }),
  scope: fc.array(fc.string({ minLength: 1, maxLength: 30 })),
  risk: fc.constantFrom("low", "medium", "high"),
  files: fc.array(fc.string({ minLength: 1, maxLength: 30 })),
  steps: fc.array(fc.record({
    order: fc.nat({ max: 10 }),
    action: fc.constantFrom("fix", "add", "remove", "modify"),
    target: fc.string({ minLength: 1, maxLength: 30 }),
  }), { minLength: 1, maxLength: 5 }),
  tests: fc.array(fc.string()),
  rollback: fc.constantFrom("git revert", "git restore", "snapshot"),
  approval: fc.constantFrom("AUTO", "MANUAL"),
  createdAt: fc.string({ minLength: 1, maxLength: 30 }),
  frozen: fc.boolean(),
});

const executionResultArb = fc.record({
  planId: fc.string({ minLength: 1, maxLength: 20 }),
  diff: fc.string(),
  stagingPath: fc.string(),
  status: fc.constantFrom("succeeded", "failed"),
  startedAt: fc.string({ minLength: 1 }),
  completedAt: fc.string({ minLength: 1 }),
  error: fc.string({ minLength: 1 }),
  attempt: fc.integer({ min: 1, max: 5 }),
});

const verificationReportArb = fc.record({
  planId: fc.string({ minLength: 1, maxLength: 20 }),
  status: fc.constantFrom("pass", "fail"),
  testsRun: fc.nat({ max: 100 }),
  testsPassed: fc.nat({ max: 100 }),
  testsFailed: fc.nat({ max: 100 }),
  logSummary: fc.string(),
  autoFixAttempts: fc.nat({ max: 3 }),
});

const projectStateArb = fc.record({
  goal: fc.string({ minLength: 1, maxLength: 50 }),
  active_task: fc.option(fc.string({ minLength: 1, maxLength: 20 })),
  branch: fc.string({ minLength: 1, maxLength: 30 }),
  phase: fc.constantFrom("IDLE", "PLAN", "EXECUTE", "VERIFY", "COMMIT", "DONE"),
  last_change: fc.string({ minLength: 1 }),
  project: fc.string({ minLength: 1 }),
});

const reconcileInputArb = fc.record({
  plan: planArb,
  executeResult: executionResultArb,
  verifyReport: verificationReportArb,
  projectState: projectStateArb,
  now: fc.string({ minLength: 1 }),
});

// ─── Property 1: 确定性 ────────────────────────────────

describe("Reconciler 确定性", () => {
  it("相同输入 → 相同输出 (500 次随机输入)", () => {
    fc.assert(
      fc.property(reconcileInputArb, (input) => {
        const result1 = reconcile(input as ReconciliationInput);
        const result2 = reconcile(input as ReconciliationInput);
        expect(result1).toEqual(result2);
      }),
      { numRuns: 500 },
    );
  });
});

// ─── Property 2: 输出结构 ──────────────────────────────

describe("Reconciler 输出结构", () => {
  it("输出始终包含 decision, memoryUpdate, reason", () => {
    fc.assert(
      fc.property(reconcileInputArb, (input) => {
        const result = reconcile(input as ReconciliationInput);
        expect(result).toHaveProperty("decision");
        expect(result).toHaveProperty("memoryUpdate");
        expect(result).toHaveProperty("reason");
      }),
      { numRuns: 300 },
    );
  });

  it("decision 只能是 COMMIT 或 ROLLBACK", () => {
    fc.assert(
      fc.property(reconcileInputArb, (input) => {
        const result = reconcile(input as ReconciliationInput);
        expect(["COMMIT", "ROLLBACK"]).toContain(result.decision);
      }),
      { numRuns: 300 },
    );
  });
});

// ─── Property 3: 决策逻辑 ──────────────────────────────

describe("Reconciler 决策逻辑", () => {
  it("执行成功 + 验证通过 → COMMIT", () => {
    fc.assert(
      fc.property(reconcileInputArb, (input) => {
        const successInput = {
          ...input,
          executeResult: { ...input.executeResult, status: "succeeded" },
          verifyReport: { ...input.verifyReport, status: "pass" },
        };
        const result = reconcile(successInput as ReconciliationInput);
        expect(result.decision).toBe("COMMIT");
      }),
      { numRuns: 100 },
    );
  });

  it("执行失败 → ROLLBACK (无论验证结果)", () => {
    fc.assert(
      fc.property(reconcileInputArb, (input) => {
        const failInput = {
          ...input,
          executeResult: { ...input.executeResult, status: "failed", error: "boom" },
          verifyReport: { ...input.verifyReport, status: "pass" },
        };
        const result = reconcile(failInput as ReconciliationInput);
        expect(result.decision).toBe("ROLLBACK");
      }),
      { numRuns: 100 },
    );
  });

  it("执行成功 + 验证失败 → ROLLBACK", () => {
    fc.assert(
      fc.property(reconcileInputArb, (input) => {
        const verifyFailInput = {
          ...input,
          executeResult: { ...input.executeResult, status: "succeeded" },
          verifyReport: { ...input.verifyReport, status: "fail" },
        };
        const result = reconcile(verifyFailInput as ReconciliationInput);
        expect(result.decision).toBe("ROLLBACK");
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 4: 不变式 ────────────────────────────────

describe("Reconciler 不变式", () => {
  it("ROLLBACK 不推进 phase 到 DONE", () => {
    fc.assert(
      fc.property(reconcileInputArb, (input) => {
        // 强制 ROLLBACK
        const rollbackInput = {
          ...input,
          executeResult: { ...input.executeResult, status: "failed", error: "forced" },
          verifyReport: { ...input.verifyReport, status: "fail" },
        };
        const result = reconcile(rollbackInput as ReconciliationInput);
        if (result.decision === "ROLLBACK" && result.memoryUpdate?.current) {
          expect(result.memoryUpdate.current.phase).not.toBe("DONE");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("COMMIT 推进 phase 到 DONE", () => {
    fc.assert(
      fc.property(reconcileInputArb, (input) => {
        const commitInput = {
          ...input,
          executeResult: { ...input.executeResult, status: "succeeded" },
          verifyReport: { ...input.verifyReport, status: "pass" },
        };
        const result = reconcile(commitInput as ReconciliationInput);
        if (result.decision === "COMMIT") {
          expect(result.memoryUpdate?.current?.phase).toBe("DONE");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("reason 永远非空", () => {
    fc.assert(
      fc.property(reconcileInputArb, (input) => {
        const result = reconcile(input as ReconciliationInput);
        expect(result.reason).toBeTruthy();
        expect(result.reason.length).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });
});
