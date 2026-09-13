/**
 * ACS Write Budget
 * ================
 * 限制单次任务的写操作总量：文件数、删除行数、新增行数。
 * 超出预算直接阻断。
 */

export interface BudgetConfig {
  maxModifiedFiles: number;
  maxDeletedLines: number;
  maxAddedLines: number;
  maxNewFiles: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  maxModifiedFiles: 3,
  maxDeletedLines: 80,
  maxAddedLines: 200,
  maxNewFiles: 0,
};

export interface BudgetState {
  modifiedFiles: number;
  deletedLines: number;
  addedLines: number;
  newFiles: number;
}

export class WriteBudget {
  private config: BudgetConfig;
  private state: BudgetState = { modifiedFiles: 0, deletedLines: 0, addedLines: 0, newFiles: 0 };

  constructor(config: Partial<BudgetConfig> = {}) {
    this.config = { ...DEFAULT_BUDGET, ...config };
  }

  setConfig(config: Partial<BudgetConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): BudgetConfig {
    return { ...this.config };
  }

  getState(): BudgetState {
    return { ...this.state };
  }

  reset(): void {
    this.state = { modifiedFiles: 0, deletedLines: 0, addedLines: 0, newFiles: 0 };
  }

  recordWrite(isNewFile: boolean, deletedLines: number, addedLines: number): string[] {
    const errors: string[] = [];

    if (isNewFile) {
      this.state.newFiles++;
      if (this.state.newFiles > this.config.maxNewFiles) {
        errors.push(`new files budget exceeded: ${this.state.newFiles}/${this.config.maxNewFiles}`);
      }
    }

    this.state.modifiedFiles++;
    if (this.state.modifiedFiles > this.config.maxModifiedFiles) {
      errors.push(`files budget exceeded: ${this.state.modifiedFiles}/${this.config.maxModifiedFiles}`);
    }

    this.state.deletedLines += deletedLines;
    if (this.state.deletedLines > this.config.maxDeletedLines) {
      errors.push(`deleted lines budget exceeded: ${this.state.deletedLines}/${this.config.maxDeletedLines}`);
    }

    this.state.addedLines += addedLines;
    if (this.state.addedLines > this.config.maxAddedLines) {
      errors.push(`added lines budget exceeded: ${this.state.addedLines}/${this.config.maxAddedLines}`);
    }

    return errors;
  }
}
