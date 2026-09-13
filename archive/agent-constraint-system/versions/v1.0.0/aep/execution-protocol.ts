/**
 * AEP — Agent Execution Protocol
 * ================================
 * 强约束执行协议：agent 必须先计划，再执行。
 * 任何不经过 plan 的写操作视为 AEP 违规。
 */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";
export type PlanStatus = "pending" | "approved" | "rejected" | "executing" | "completed" | "failed";
export type PatchFormat = "unified-diff" | "none";

export interface Plan {
  planId: string;
  summary: string;
  filesToModify: string[];
  reason: string;
  risk: RiskLevel;
  newFiles: string[];
  deletions: boolean;
  patchLinesEstimate: number;
  confidence: ConfidenceLevel;
  format: PatchFormat;
}

export interface PlanReview {
  planId: string;
  status: PlanStatus;
  errors: string[];
  warnings: string[];
  approvedAt?: number;
}

export interface ExecutionStep {
  action: "patch" | "plan" | "verify" | "commit";
  filePath?: string;
  patch?: string;
  status: "pending" | "running" | "passed" | "failed";
  result?: string;
}

export class AEP {
  private currentPlan: Plan | null = null;
  private history: Plan[] = [];

  /**
   * Agent 提交计划。
   */
  submitPlan(plan: Plan): PlanReview {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 验证计划完整性
    if (!plan.planId) errors.push("plan_id is required");
    if (!plan.summary || plan.summary.length < 5) errors.push("summary is required (min 5 chars)");
    if (!plan.filesToModify || plan.filesToModify.length === 0) errors.push("files_to_modify is required");
    if (!plan.reason || plan.reason.length < 5) errors.push("reason is required");
    if (!plan.risk) errors.push("risk level is required");
    if (plan.format !== "unified-diff") errors.push("only unified-diff patches are allowed");

    // 风险验证
    if (plan.deletions && plan.risk === "LOW") {
      errors.push("plan declares deletions but risk is LOW — must be MEDIUM or higher");
    }

    if (plan.newFiles.length > 0 && plan.risk === "LOW") {
      warnings.push("plan creates new files but risk is LOW — verify");
    }

    if (plan.confidence === "LOW") {
      errors.push("plan confidence is LOW — requires human review before approval");
    }

    // 行数合理性检查
    if (plan.patchLinesEstimate < 1) {
      errors.push("patch_lines_estimate must be > 0");
    }

    if (plan.patchLinesEstimate > 200) {
      errors.push(`patch_lines_estimate ${plan.patchLinesEstimate} exceeds max 200`);
    }

    const isApproved = errors.length === 0;
    const review: PlanReview = {
      planId: plan.planId,
      status: isApproved ? "approved" : "rejected",
      errors,
      warnings,
      approvedAt: isApproved ? Date.now() : undefined,
    };

    if (isApproved) {
      this.currentPlan = plan;
      this.history.push(plan);
    }

    return review;
  }

  /**
   * 检查当前是否有已批准的 plan。
   */
  hasActivePlan(): boolean {
    return this.currentPlan !== null;
  }

  /**
   * 检查文件路径是否在当前 plan 中。
   */
  isFileInPlan(filePath: string): boolean {
    if (!this.currentPlan) return false;
    return this.currentPlan.filesToModify.some((f) => filePath.includes(f) || f.includes(filePath));
  }

  /**
   * 检查 patch 行数是否在 plan 预估范围内。
   */
  isPatchInBudget(actualLines: number, multiplier = 2): boolean {
    if (!this.currentPlan) return false;
    return actualLines <= this.currentPlan.patchLinesEstimate * multiplier;
  }

  /**
   * 完成当前计划。
   */
  completePlan(status: "completed" | "failed", reason?: string): void {
    if (this.currentPlan) {
      this.currentPlan = null;
    }
  }

  /**
   * 获取执行计划历史。
   */
  getHistory(): Plan[] {
    return [...this.history];
  }

  /**
   * 获取当前计划。
   */
  getCurrentPlan(): Plan | null {
    return this.currentPlan;
  }

  /**
   * 验证 agent 输出格式是否为 unified diff。
   */
  validatePatchFormat(patch: string): boolean {
    return patch.includes("--- ") && patch.includes("+++ ") && patch.includes("@@ ");
  }
}
