/**
 * ACS Change Budget
 * =================
 * 基于风险等级的变更预算。
 * 不同风险等级的变更有不同的文件数/行数上限。
 * 超出预算 → 直接阻断或要求审批。
 */

import type { RiskLevel } from "../patch/classifier.js";

interface BudgetLimit {
  maxFiles: number;
  maxLines: number;
  requiresApproval: boolean;
}

const BUDGET_TABLE: Record<RiskLevel, BudgetLimit> = {
  LOW: { maxFiles: 1, maxLines: 30, requiresApproval: false },
  MEDIUM: { maxFiles: 3, maxLines: 120, requiresApproval: false },
  HIGH: { maxFiles: 0, maxLines: 0, requiresApproval: true },
  CRITICAL: { maxFiles: 0, maxLines: 0, requiresApproval: true },
};

export interface ChangeBudgetState {
  currentFiles: number;
  currentLines: number;
  riskLevel: RiskLevel;
}

export class ChangeBudget {
  private state: ChangeBudgetState = { currentFiles: 0, currentLines: 0, riskLevel: "LOW" };

  /**
   * 检查变更是否在预算内。
   */
  check(riskLevel: RiskLevel, fileCount: number, lineCount: number): { ok: boolean; errors: string[] } {
    const limit = BUDGET_TABLE[riskLevel] || BUDGET_TABLE.LOW;
    const errors: string[] = [];

    if (fileCount > limit.maxFiles) {
      errors.push(`file count ${fileCount} exceeds budget ${limit.maxFiles} for risk=${riskLevel}`);
    }

    if (lineCount > limit.maxLines) {
      errors.push(`line count ${lineCount} exceeds budget ${limit.maxLines} for risk=${riskLevel}`);
    }

    if (limit.requiresApproval) {
      errors.push(`risk=${riskLevel} requires human approval`);
    }

    return { ok: errors.length === 0, errors };
  }

  /**
   * 获取某风险等级的预算上限。
   */
  getLimit(riskLevel: RiskLevel): BudgetLimit {
    return { ...BUDGET_TABLE[riskLevel] };
  }

  /**
   * 重置状态。
   */
  reset(): void {
    this.state = { currentFiles: 0, currentLines: 0, riskLevel: "LOW" };
  }
}
