/**
 * ACS Human Approval Gate
 * ========================
 * 高风险操作必须人工批准。
 * agent 不能自主：删除文件、改关键配置、动 schema/auth/payment 代码。
 */

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ApprovalRequest {
  id: string;
  action: string;
  filePath: string;
  riskLevel: RiskLevel;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: number;
  resolvedAt?: number;
}

// 高危路径前缀匹配
const HIGH_RISK_PATHS = [
  /\/package\.json$/,
  /\/tsconfig\.json$/,
  /\/docker-compose\./,
  /\/Dockerfile$/,
  /\/(?:auth|login|register|oauth)\.(ts|js|py|go|rs)$/,
  /\/(?:schema|migration|migrate)\.(sql|ts|js)$/,
  /\/(?:payment|billing|charge|stripe)\.(ts|js|py)$/,
  /\/\.env/,
  /\/\.env\./,
  /\/database\.(ts|js|py|sql)$/,
  /\/knexfile\./,
  /\/prisma\/schema\.prisma/,
  /\/(?:secret|credential|key)\./,
  /\/(?:firebase|supabase|aws|gcp)\.(ts|js)$/,
];

const MEDIUM_RISK_PATHS = [
  /\/(?:docker|ci|cd|github|gitlab)\//,
  /\/(?:test|spec|e2e)\.(ts|js|tsx|jsx)$/,
  /\/(?:middleware|interceptor|guard|filter)\.(ts|js)$/,
  /\/(?:config|setting|env)\.(ts|js|json)$/,
];

export class ApprovalGate {
  private pending: ApprovalRequest[] = [];
  private resolved: ApprovalRequest[] = [];

  /**
   * 评估文件操作的风险等级。
   */
  assessRisk(action: string, filePath: string): { level: RiskLevel; reason: string } {
    if (action === "delete" || action === "remove") {
      return { level: "HIGH", reason: "file deletion requires approval" };
    }

    if (action === "rename") {
      return { level: "MEDIUM", reason: "file rename requires approval" };
    }

    if (action === "create") {
      for (const pattern of HIGH_RISK_PATHS) {
        if (pattern.test(filePath)) {
          return { level: "HIGH", reason: `creating high-risk file: ${filePath}` };
        }
      }
    }

    for (const pattern of HIGH_RISK_PATHS) {
      if (pattern.test(filePath)) {
        return { level: "HIGH", reason: `high-risk file modified: ${filePath}` };
      }
    }

    for (const pattern of MEDIUM_RISK_PATHS) {
      if (pattern.test(filePath)) {
        return { level: "MEDIUM", reason: `medium-risk file modified: ${filePath}` };
      }
    }

    return { level: "LOW", reason: "" };
  }

  /**
   * 发起审批请求。高风险自动 PENDING，低风险自动通过。
   */
  request(action: string, filePath: string): ApprovalRequest {
    const { level, reason } = this.assessRisk(action, filePath);

    const request: ApprovalRequest = {
      id: `appr-${Date.now().toString(36)}`,
      action,
      filePath,
      riskLevel: level,
      reason,
      status: level === "LOW" ? "APPROVED" : "PENDING",
      createdAt: Date.now(),
    };

    if (level === "LOW") {
      request.resolvedAt = Date.now();
      this.resolved = [...this.resolved, request];
    } else {
      this.pending.push(request);
    }

    return request;
  }

  /**
   * 人工批准。
   */
  approve(id: string): boolean {
    const idx = this.pending.findIndex((r) => r.id === id);
    if (idx === -1) return false;

    const [req] = this.pending.splice(idx, 1);
    req.status = "APPROVED";
    req.resolvedAt = Date.now();
    this.resolved = [...this.resolved, req];
    return true;
  }

  /**
   * 人工拒绝。
   */
  reject(id: string): boolean {
    const idx = this.pending.findIndex((r) => r.id === id);
    if (idx === -1) return false;

    const [req] = this.pending.splice(idx, 1);
    req.status = "REJECTED";
    req.resolvedAt = Date.now();
    this.resolved = [...this.resolved, req];
    return true;
  }

  /**
   * 检查是否有待审批的高风险请求。
   */
  hasPending(): boolean {
    return this.pending.length > 0;
  }

  getPending(): ApprovalRequest[] {
    return [...this.pending];
  }

  /**
   * 获取已解决的审批历史记录。
   */
  getResolved(): ApprovalRequest[] {
    return [...this.resolved];
  }
}
