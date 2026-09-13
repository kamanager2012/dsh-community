/**
 * ACS v0.7.1 — AEP 集成测试
 * 验证 Pipeline ↔ AEP 连接
 */
import { describe, it, expect } from "vitest";
import { Pipeline } from "../src/runtime/pipeline.js";
import { DEFAULT_SCOPE } from "../src/constraint/scope-constraint.js";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let ctr = 0;
const tmp = (n: string) => join(tmpdir(), `aep-test-${ctr++}-${n}`);
const wf = (n: string, c: string) => { const p = tmp(n); writeFileSync(p, c, "utf-8"); return p; };
const rf = (p: string) => readFileSync(p, "utf-8");
const cl = (p: string) => { if (existsSync(p)) unlinkSync(p); };

// risk/confidence 需要 "LOW"|"MEDIUM"|"HIGH"|"CRITICAL"
const LOW = "LOW" as const;
const MEDIUM = "MEDIUM" as const;
const HIGH = "HIGH" as const;

describe("AEP ↔ Pipeline 集成", () => {

  it("无 plan 时 requirePatch=true 阻止写操作", () => {
    const p = new Pipeline();
    p.initTask({ ...DEFAULT_SCOPE, taskId: "t1", requirePatch: true });
    const r = p.checkWrite("/tmp/foo.ts", "const x = 1;");
    expect(r.passed).toBe(false);
    expect(r.stage).toBe("aep");
    expect(r.errors[0]).toContain("no active plan");
  });

  it("有 plan 时允许写操作", () => {
    const p = new Pipeline();
    p.initTask({ ...DEFAULT_SCOPE, taskId: "t2", requirePatch: true });
    const f = wf("in-plan.ts", "const a = 1;\n");
    const planResult = p.submitPlan({
      planId: "p1",
      summary: "修改 in-plan.ts",
      filesToModify: [f],
      reason: "修改文件内容以修复 bug",
      risk: MEDIUM,
      newFiles: [],
      deletions: false,
      patchLinesEstimate: 5,
      confidence: HIGH,
      format: "unified-diff",
    });
    expect(planResult.approved).toBe(true);

    const r = p.checkWrite(f, "const b = 2;\n");
    expect(r.passed).toBe(true);
    cl(f);
  });

  it("文件不在 plan 内时阻止", () => {
    const p = new Pipeline();
    p.initTask({ ...DEFAULT_SCOPE, taskId: "t3", requirePatch: true });
    const planFile = wf("planned.ts", "const a = 1;\n");
    const otherFile = wf("other.ts", "const b = 2;\n");
    p.submitPlan({
      planId: "p2",
      summary: "只改 planned.ts",
      filesToModify: [planFile],
      reason: "修改 planned 文件中的内容",
      risk: MEDIUM,
      newFiles: [],
      deletions: false,
      patchLinesEstimate: 3,
      confidence: HIGH,
      format: "unified-diff",
    });

    const r = p.checkWrite(otherFile, "const c = 3;\n");
    expect(r.passed).toBe(false);
    expect(r.stage).toBe("aep");
    expect(r.errors[0]).toContain("not in active plan");
    cl(planFile); cl(otherFile);
  });

  it("行数超出 plan 预估 2x 时 checkIntegrity 失败", () => {
    const p = new Pipeline();
    p.initTask({ ...DEFAULT_SCOPE, taskId: "t4", requirePatch: true });
    const f = wf("budget.ts", "// small\n");
    p.submitPlan({
      planId: "p3",
      summary: "小改 budget.ts",
      filesToModify: [f],
      reason: "修改 budget 文件中的小内容",
      risk: LOW,
      newFiles: [],
      deletions: false,
      patchLinesEstimate: 3,
      confidence: HIGH,
      format: "unified-diff",
    });

    p.lockSource(f);
    // 写入 8 行，超过 3*2=6 行限制
    writeFileSync(f, "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f2 = 6;\nconst g = 7;\nconst h = 8;\n", "utf-8");
    const r = p.checkIntegrity(f);
    expect(r.passed).toBe(false);
    expect(r.stage).toBe("aep-verify");
    expect(r.errors[0]).toContain("patch exceeds plan estimate");
    cl(f);
  });

  it("行数在 2x 范围内时 checkIntegrity 通过", () => {
    const p = new Pipeline();
    p.initTask({ ...DEFAULT_SCOPE, taskId: "t5", requirePatch: true });
    const f = wf("within-budget.ts", "const a = 1;\nconst b = 2;\n");
    p.submitPlan({
      planId: "p4",
      summary: "在预算内修改",
      filesToModify: [f],
      reason: "修改 within-budget 文件",
      risk: LOW,
      newFiles: [],
      deletions: false,
      patchLinesEstimate: 10,
      confidence: HIGH,
      format: "unified-diff",
    });

    p.lockSource(f);
    writeFileSync(f, "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n", "utf-8");
    const r = p.checkIntegrity(f);
    expect(r.passed).toBe(true);
    cl(f);
  });

  it("commit 清除 plan", () => {
    const p = new Pipeline();
    p.initTask({ ...DEFAULT_SCOPE, taskId: "t6", requirePatch: true });
    const f = wf("commit.ts", "const x = 1;\n");
    p.submitPlan({
      planId: "p5",
      summary: "提交测试 commit",
      filesToModify: [f],
      reason: "测试 commit 功能是否正常",
      risk: LOW,
      newFiles: [],
      deletions: false,
      patchLinesEstimate: 3,
      confidence: HIGH,
      format: "unified-diff",
    });

    const commit = p.commit();
    expect(commit.committed).toBe(true);
    expect(commit.planId).toBe("p5");

    // plan 清除后，无 plan 时写操作再次被阻止
    const r = p.checkWrite("/tmp/after.ts", "x");
    expect(r.passed).toBe(false);
    expect(r.stage).toBe("aep");
    cl(f);
  });

  it("abortPlan 清除 plan", () => {
    const p = new Pipeline();
    p.initTask({ ...DEFAULT_SCOPE, taskId: "t7", requirePatch: true });
    const f = wf("abort.ts", "const x = 1;\n");
    p.submitPlan({
      planId: "p6",
      summary: "abort 测试",
      filesToModify: [f],
      reason: "测试 abort 功能是否正常",
      risk: LOW,
      newFiles: [],
      deletions: false,
      patchLinesEstimate: 3,
      confidence: HIGH,
      format: "unified-diff",
    });

    p.abortPlan();
    const r = p.checkWrite(f, "const y = 2;\n");
    expect(r.passed).toBe(false);
    expect(r.stage).toBe("aep");
    cl(f);
  });

  it("requirePatch=false 时不强制 AEP", () => {
    const p = new Pipeline();
    p.initTask({ ...DEFAULT_SCOPE, taskId: "t8", requirePatch: false });
    const f = wf("no-aep.ts", "const x = 1;\n");
    // 无需 plan 即可写
    const r = p.checkWrite(f, "const y = 2;\n");
    expect(r.passed).toBe(true);
    cl(f);
  });
});
