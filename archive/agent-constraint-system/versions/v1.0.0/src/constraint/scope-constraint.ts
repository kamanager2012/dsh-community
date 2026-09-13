/**
 * ACS Scope Constraint
 * =====================
 * 任务范围内文件访问控制。
 * Agent 只能读写 allowed_files 中指定的路径。
 */

import { resolve, normalize } from "node:path";

export interface ScopeConfig {
  taskId: string;
  allowedFiles: string[];
  allowedNewPaths: string[];
  blockedCommands: string[];
  maxFiles: number;
  requirePatch: boolean;
}

export interface Violation {
  reason: string;
  score: number;
  ts: number;
}

export interface ViolationState {
  total: number;
  events: Violation[];
}

const VIOLATION_LIMIT = 100;
const NEW_FILE_VIOLATION_SCORE = 30;
const OUT_OF_SCOPE_VIOLATION_SCORE = 20;
const BLOCKED_COMMAND_VIOLATION_SCORE = 50;

export const DEFAULT_SCOPE: ScopeConfig = {
  taskId: "",
  allowedFiles: [],
  allowedNewPaths: [],
  blockedCommands: ["sed -i", "rm -rf", "mv ", "chmod", "kill -9"],
  maxFiles: 3,
  requirePatch: true,
};

export class ScopeEnforcer {
  private scope: ScopeConfig | null = null;
  private violations: ViolationState = { total: 0, events: [] };

  setScope(config: ScopeConfig): void {
    this.scope = config;
    this.violations = { total: 0, events: [] };
  }

  getScope(): ScopeConfig | null {
    return this.scope;
  }

  /**
   * 检查文件路径是否在范围内。
   * 路径经 resolve/normalize 处理，防止 ../ 遍历绕过。
   * 空 allowedFiles = 阻止所有（显式授权原则）。
   */
  checkFile(filePath: string, createOk = false): boolean {
    if (!this.scope) return true;
    const allowed = this.scope.allowedFiles;
    // 空列表 = 阻止所有写入（与 Python hook 行为一致）
    if (allowed.length === 0) {
      this.addViolation(`out-of-scope file (empty scope): ${filePath}`, OUT_OF_SCOPE_VIOLATION_SCORE);
      return false;
    }

    // 路径规范化，防止 ../ 遍历
    const normalized = normalize(resolve("/", filePath));

    for (const pattern of allowed) {
      const normalizedPattern = normalize(resolve("/", pattern));
      if (normalizedPattern.endsWith("/**") || normalizedPattern.endsWith("/*")) {
        const prefix = normalizedPattern.slice(0, normalizedPattern.lastIndexOf("/") + 1);
        if (normalized.startsWith(prefix)) return true;
      } else if (normalized === normalizedPattern || normalized.startsWith(normalizedPattern + "/")) {
        return true;
      }
    }

    this.addViolation(`out-of-scope file: ${filePath}`, OUT_OF_SCOPE_VIOLATION_SCORE);
    return false;
  }

  /**
   * 检查文件是否已存在（禁止创建新路径）。
   */
  checkFileExists(filePath: string, exists: boolean): boolean {
    if (!exists) {
      this.addViolation(`new path not allowed: ${filePath}`, NEW_FILE_VIOLATION_SCORE);
      return false;
    }
    return true;
  }

  checkCommand(command: string): boolean {
    if (!this.scope) return true;
    for (const pattern of this.scope.blockedCommands) {
      if (command.includes(pattern)) {
        this.addViolation(`blocked command: ${pattern}`, BLOCKED_COMMAND_VIOLATION_SCORE);
        return false;
      }
    }
    return true;
  }

  /**
   * 添加违规记录（不可变模式 — 创建新数组）。
   */
  addViolation(reason: string, score: number): void {
    this.violations = {
      total: this.violations.total + score,
      events: [...this.violations.events, { reason, score, ts: Date.now() }],
    };
  }

  isExceeded(): boolean {
    return this.violations.total >= VIOLATION_LIMIT;
  }

  /**
   * 返回违规状态的深拷贝（不可变语义）。
   */
  getViolations(): ViolationState {
    return {
      total: this.violations.total,
      events: [...this.violations.events],
    };
  }

  reset(): void {
    this.scope = null;
    this.violations = { total: 0, events: [] };
  }
}