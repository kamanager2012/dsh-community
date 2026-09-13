/**
 * ACS Runtime Pipeline
 * =====================
 * 执行总闸。所有工具调用依次经过全部约束检查，
 * 任何一步失败 → 直接 BLOCK，不继续执行。
 *
 * AEP 集成：requirePatch=true 时，写操作必须先有已审批的 plan。
 * VERIFY 步骤在 checkIntegrity 中执行，COMMIT 步骤由 commit() 方法执行。
 */

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { ScopeEnforcer, ScopeConfig } from "../constraint/scope-constraint.js";
import { PathFreeze } from "../constraint/path-freeze.js";
import { WriteBudget, BudgetConfig } from "../constraint/write-budget.js";
import { PatchConstraint } from "../patch/patch.js";
import { FileIntegrity, FileFingerprint } from "../integrity/manifest.js";
import { ASTGuard, ASTSnapshot, ASTDiff } from "../integrity/ast-guard.js";
import { SemanticGuard } from "../integrity/semantic-guard.js";
import { SourceLock } from "../integrity/source-lock.js";
import { ApprovalGate } from "./approval-gate.js";
import { AEP, Plan } from "../../aep/index.js";
import { appendViolation } from "../audit/violation-log.js";

export interface PipelineResult {
  passed: boolean;
  stage: string;
  errors: string[];
  violationTotal: number;
}

export class Pipeline {
  readonly scope = new ScopeEnforcer();
  readonly pathFreeze = new PathFreeze();
  readonly budget = new WriteBudget();
  readonly patch = new PatchConstraint();
  readonly integrity = new FileIntegrity();
  readonly ast = new ASTGuard();
  readonly semantic = new SemanticGuard();
  readonly sourceLock = new SourceLock();
  readonly approvals = new ApprovalGate();
  readonly aep = new AEP();

  private astBefore: ASTSnapshot | null = null;
  private integrityBefore: FileFingerprint | null = null;
  private contentBefore: string = "";
  private requirePatch = false;

  /**
   * 初始化任务范围，重置预算和违规。
   */
  initTask(config: ScopeConfig, aepInstance?: AEP): void {
    this.scope.setScope(config);
    this.scope.reset();
    this.budget.reset();
    this.requirePatch = config.requirePatch ?? false;
    if (aepInstance) {
      Object.assign(this.aep, aepInstance);
    }
  }

  /**
   * 提交执行计划（AEP TASK → PLAN → APPROVE）。
   */
  submitPlan(plan: Plan): { approved: boolean; errors: string[] } {
    const review = this.aep.submitPlan(plan);
    if (review.status !== "approved") {
      return { approved: false, errors: review.errors };
    }
    return { approved: true, errors: [] };
  }

  /**
   * 检查文件写入权限（全链路）。
   */
  checkWrite(filePath: string, content?: string): PipelineResult {
    // Stage 0: AEP plan 检查
    if (this.requirePatch && !this.aep.hasActivePlan()) {
      return this._fail("aep", "no active plan: all writes require an approved plan (AEP violation)");
    }
    if (this.requirePatch && this.aep.hasActivePlan() && !this.aep.isFileInPlan(filePath)) {
      return this._fail("aep", `file not in active plan: ${filePath} (AEP violation)`);
    }

    // Stage 1: 违规上限
    if (this.scope.isExceeded()) {
      return this._fail("violation-limit", "violation limit exceeded");
    }

    // Stage 2: 受保护路径检查
    if (!this._isPathWritable(filePath)) {
      return this._fail("path-protected", `protected path: ${filePath}`);
    }

    // Stage 3: 人工审批门
    const approval = this.approvals.request("write", filePath);
    if (approval.status === "PENDING") {
      return this._fail("approval", `requires human approval: ${filePath} (${approval.reason})`);
    }

    // Stage 4: 文件范围检查
    if (!this.scope.checkFile(filePath)) {
      return this._fail("scope", `file not in scope: ${filePath}`);
    }

    // Stage 5: 路径冻结
    const freezeReason = this.pathFreeze.checkPath(filePath);
    if (freezeReason) {
      this.scope.addViolation(freezeReason, 30);
      return this._fail("path-freeze", freezeReason);
    }

    // Stage 6: 禁止新文件
    const exists = existsSync(filePath);
    const newPathErr = this.pathFreeze.checkNewPath(filePath, exists, this.scope.getScope()?.allowedNewPaths);
    if (newPathErr) {
      this.scope.addViolation(newPathErr, 30);
      return this._fail("new-path", newPathErr);
    }

    // Stage 7: 写入预算
    if (content && exists) {
      const existingLines = readFileSync(filePath, "utf-8").split("\n").length;
      const additions = content.split("\n").length;
      const deletions = Math.max(0, existingLines - additions);
      const budgetErrors = this.budget.recordWrite(!exists, deletions, additions);
      if (budgetErrors.length > 0) {
        for (const e of budgetErrors) this.scope.addViolation(e, 15);
        return this._fail("budget", budgetErrors.join("; "));
      }
    } else if (content) {
      const additions = content.split("\n").length;
      const budgetErrors = this.budget.recordWrite(true, 0, additions);
      if (budgetErrors.length > 0) {
        return this._fail("budget", budgetErrors.join("; "));
      }
    }

    return { passed: true, stage: "all", errors: [], violationTotal: this.scope.getViolations().total };
  }

  /**
   * 检查文件完整性（写入后调用 — AEP VERIFY）。
   */
  checkIntegrity(filePath: string): PipelineResult {
    if (!existsSync(filePath)) {
      return this._fail("integrity", "file missing after write");
    }

    const afterContent = readFileSync(filePath, "utf-8");
    const afterLines = afterContent.split("\n").length;
    const beforeLines = this.contentBefore ? this.contentBefore.split("\n").length : 0;
    const actualChanged = Math.abs(afterLines - beforeLines);

    // AEP VERIFY: 行数超出 plan 预估 2x
    if (this.requirePatch && this.aep.hasActivePlan()) {
      if (!this.aep.isPatchInBudget(actualChanged)) {
        const plan = this.aep.getCurrentPlan();
        const estimate = plan?.patchLinesEstimate ?? 0;
        this.scope.addViolation(
          `aep: patch lines ${actualChanged} exceeds plan estimate ${estimate} (2x=${estimate * 2})`,
          30,
        );
        return this._fail("aep-verify", `patch exceeds plan estimate: ${actualChanged} > ${estimate * 2} lines`);
      }
    }

    // Stage 1: 文件完整性
    if (this.integrityBefore) {
      const afterSnap = this.integrity.snapshot(filePath);
      if (!afterSnap) {
        return this._fail("integrity", "cannot snapshot after write");
      }
      const errors = this.integrity.verify(this.integrityBefore, afterSnap);
      if (errors.length > 0) {
        for (const e of errors) this.scope.addViolation(e, 20);
        return this._fail("integrity", errors.join("; "));
      }
    }

    // Stage 2: AST 级校验
    const astAfter = this.ast.snapshot(afterContent);
    if (this.astBefore) {
      const astDiff = this.ast.diff(this.astBefore, astAfter);
      const astErrors = this._astDiffToErrors(astDiff);
      if (astErrors.length > 0) {
        for (const e of astErrors) this.scope.addViolation(e, 25);
        return this._fail("ast", astErrors.join("; "));
      }
    }

    // Stage 3: Source Lock 校验
    const sourceCheck = this.sourceLock.verify(filePath);
    if (!sourceCheck.ok && sourceCheck.errors[0] !== "no source lock") {
      for (const e of sourceCheck.errors) this.scope.addViolation(e, 30);
      return this._fail("source-lock", sourceCheck.errors.join("; "));
    }

    // Stage 4: 语义降级检测
    const semanticResult = this.semantic.check(afterContent);
    if (!semanticResult.passed) {
      for (const issue of semanticResult.issues) {
        this.scope.addViolation(`${issue.type}:${issue.line} ${issue.pattern}`, 35);
      }
      return this._fail("semantic", `${semanticResult.issues.length} degradation(s) found`);
    }

    // Stage 5: Post-apply 复验
    const rehash = createHash("sha256").update(afterContent).digest("hex");
    const afterSnap = this.integrity.snapshot(filePath);
    if (afterSnap && afterSnap.hash !== rehash) {
      return this._fail("post-apply", "file changed during verification cycle");
    }

    return { passed: true, stage: "all", errors: [], violationTotal: this.scope.getViolations().total };
  }

  /**
   * 提交当前计划（AEP COMMIT）。
   */
  commit(): { committed: boolean; planId: string | null } {
    const plan = this.aep.getCurrentPlan();
    if (!plan) {
      return { committed: false, planId: null };
    }
    this.aep.completePlan("completed");
    return { committed: true, planId: plan.planId };
  }

  /**
   * 放弃当前计划（AEP ABORT）。
   */
  abortPlan(): void {
    this.aep.completePlan("failed");
  }

  /**
   * 锁定原始文件状态（写前调用）。
   */
  lockSource(filePath: string): void {
    if (!existsSync(filePath)) return;
    const content = readFileSync(filePath, "utf-8");
    this.contentBefore = content;
    this.integrityBefore = this.integrity.snapshot(filePath);
    this.sourceLock.lock(filePath, content);
    this.astBefore = this.ast.snapshot(content);
  }

  // ── private ──

  private _isPathWritable(filePath: string): boolean {
    const blockedPatterns = [
      /\.claude\/settings\.json$/,
      /\.claude\/runtime\/TASK_SCOPE\.json$/,
      /\.claude\/runtime\/VIOLATIONS\.json$/,
    ];
    for (const p of blockedPatterns) {
      if (p.test(filePath)) return false;
    }
    return true;
  }

  private _astDiffToErrors(diff: ASTDiff): string[] {
    const errors: string[] = [];
    const mappings: Array<[string[], string]> = [
      [diff.removedExports, "export removed"],
      [diff.removedImports, "import removed"],
      [diff.removedClasses, "class removed"],
      [diff.removedInterfaces, "interface removed"],
      [diff.removedTypes, "type removed"],
      [diff.removedFunctions, "function removed"],
      [diff.hollowedExports, "hollowed export"],
    ];
    for (const [items, label] of mappings) {
      for (const item of items) {
        errors.push(`${label}: ${item}`);
      }
    }
    return errors;
  }

  private _fail(stage: string, msg: string): PipelineResult {
    const total = this.scope.getViolations().total;
    appendViolation(msg, 0, total);
    return { passed: false, stage, errors: [msg], violationTotal: total };
  }
}
