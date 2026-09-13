/**
 * ACS Patch Risk Classifier
 * ==========================
 * 基于 patch 实际内容的风险分类。
 * 不信任 agent 声明的 risk 等级，只信任 patch 分析结果。
 */

export type ChangeType =
  | "comment"
  | "whitespace"
  | "import"
  | "function-body"
  | "function-signature"
  | "export"
  | "export-delete"
  | "class"
  | "interface"
  | "type-def"
  | "dependency"
  | "config"
  | "schema"
  | "auth"
  | "other";

/** 统一 RiskLevel — 与 ApprovalGate 保持一致 */
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ClassifiedChange {
  type: ChangeType;
  risk: RiskLevel;
  detail: string;
  line: number;
}

export interface PatchClassification {
  overallRisk: RiskLevel;
  changes: ClassifiedChange[];
  summary: string;
}

const HIGH_CHANGE_COUNT_THRESHOLD = 20;

const HIGH_RISK_PATHS = [
  /\/package\.json$/,
  /\/tsconfig\.json$/,
  /\/(?:auth|login|register|oauth|session)\.(ts|js|py|go|rs)$/,
  /\/(?:schema|migration|migrate)\.(sql|ts|js)$/,
  /\/(?:payment|billing|charge|stripe|checkout)\.(ts|js|py)$/,
  /\/\.env/,
  /\/(?:firebase|supabase|aws|gcp|azure)\.(ts|js)$/,
  /\/prisma\/schema\.prisma/,
  /\/database\.(ts|js|py|sql)$/,
  /\/Dockerfile$/,
  /\/docker-compose\./,
];

const MEDIUM_RISK_PATHS = [
  /\/(?:middleware|interceptor|guard|filter)\.(ts|js)$/,
  /\/(?:config|setting|env)\.(ts|js|json)$/,
  /\/(?:docker|ci|cd|github|gitlab)\//,
];

const CODE_KEYWORDS = ["return", "await", "try", "catch", "if", "for", "while"];

export class PatchClassifier {
  /**
   * 基于 patch 内容分类风险等级。
   * addedLines 和 deletedLines 必须与 patch 中的实际行号对应。
   * caller 负责传入 { line, content } 格式以保留行号信息。
   */
  classify(filePath: string, addedLines: string[], deletedLines: string[]): PatchClassification {
    const changes: ClassifiedChange[] = [];

    // Process with line tracking
    for (let i = 0; i < addedLines.length; i++) {
      const change = this._classifyLineWithIndex("add", addedLines[i], i + 1, filePath);
      if (change) changes.push(change);
    }

    for (let i = 0; i < deletedLines.length; i++) {
      const change = this._classifyLineWithIndex("del", deletedLines[i], i + 1, filePath);
      if (change) changes.push(change);
    }

    const overallRisk = this._computeOverallRisk(changes);

    return {
      overallRisk,
      changes,
      summary: `${changes.length} changes, overall risk: ${overallRisk}`,
    };
  }

  // ── private ──

  /**
   * 带行号的分类，内部使用。
   * line 参数是 1-based 行号。
   */
  private _classifyLineWithIndex(direction: "add" | "del", line: string, lineNum: number, filePath: string): ClassifiedChange | null {
    const trimmed = line.trim();

    if (this._isCommentOrWhitespace(trimmed)) {
      return { type: "comment", risk: "LOW", detail: `${direction}: ${trimmed.slice(0, 40)}`, line: lineNum };
    }

    if (direction === "del" && this._isExportDecl(trimmed)) {
      return { type: "export-delete", risk: "CRITICAL", detail: `export deleted: ${trimmed}`, line: lineNum };
    }

    if (this._isExportDecl(trimmed)) {
      return { type: "export", risk: "HIGH", detail: `export: ${trimmed}`, line: lineNum };
    }

    const fnResult = this._matchFunctionSignature(trimmed, lineNum);
    if (fnResult) return fnResult;

    const classResult = this._matchClass(trimmed, lineNum);
    if (classResult) return classResult;

    const ifaceResult = this._matchInterface(trimmed, lineNum);
    if (ifaceResult) return ifaceResult;

    const typeResult = this._matchType(trimmed, lineNum);
    if (typeResult) return typeResult;

    if (this._isImport(trimmed)) {
      return { type: "import", risk: "MEDIUM", detail: `import: ${trimmed.slice(0, 50)}`, line: lineNum };
    }

    const pathRisk = this._matchHighRiskPath(filePath, lineNum);
    if (pathRisk) return pathRisk;

    const mediumRisk = this._matchMediumRiskPath(filePath, lineNum);
    if (mediumRisk) return mediumRisk;

    if (this._hasCodeKeyword(trimmed)) {
      return { type: "function-body", risk: "MEDIUM", detail: `code: ${trimmed.slice(0, 50)}`, line: lineNum };
    }

    return null;
  }

  private _isCommentOrWhitespace(trimmed: string): boolean {
    return !trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
  }

  private _isExportDecl(trimmed: string): boolean {
    return /^export\s+(interface|type|class|function|const|enum)\s+\w+/.test(trimmed);
  }

  private _matchFunctionSignature(trimmed: string, lineNum: number): ClassifiedChange | null {
    if (/^(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/.test(trimmed)) {
      return { type: "function-signature", risk: "HIGH", detail: `function sig: ${trimmed.slice(0, 50)}`, line: lineNum };
    }
    return null;
  }

  private _matchClass(trimmed: string, lineNum: number): ClassifiedChange | null {
    if (/^(?:export\s+)?(?:abstract\s+)?class\s+\w+/.test(trimmed)) {
      return { type: "class", risk: "HIGH", detail: `class: ${trimmed}`, line: lineNum };
    }
    return null;
  }

  private _matchInterface(trimmed: string, lineNum: number): ClassifiedChange | null {
    if (/^(?:export\s+)?interface\s+\w+/.test(trimmed)) {
      return { type: "interface", risk: "HIGH", detail: `interface: ${trimmed}`, line: lineNum };
    }
    return null;
  }

  private _matchType(trimmed: string, lineNum: number): ClassifiedChange | null {
    if (/^(?:export\s+)?type\s+\w+/.test(trimmed)) {
      return { type: "type-def", risk: "MEDIUM", detail: `type: ${trimmed}`, line: lineNum };
    }
    return null;
  }

  private _isImport(trimmed: string): boolean {
    return /^import\s/.test(trimmed);
  }

  private _matchHighRiskPath(filePath: string, lineNum: number): ClassifiedChange | null {
    for (const pattern of HIGH_RISK_PATHS) {
      if (pattern.test(filePath)) {
        return { type: "auth", risk: "CRITICAL", detail: `change in high-risk file: ${filePath}`, line: lineNum };
      }
    }
    return null;
  }

  private _matchMediumRiskPath(filePath: string, lineNum: number): ClassifiedChange | null {
    for (const pattern of MEDIUM_RISK_PATHS) {
      if (pattern.test(filePath)) {
        return { type: "config", risk: "HIGH", detail: `change in config file: ${filePath}`, line: lineNum };
      }
    }
    return null;
  }

  private _hasCodeKeyword(trimmed: string): boolean {
    return CODE_KEYWORDS.some((kw) => trimmed.includes(kw));
  }

  private _computeOverallRisk(changes: ClassifiedChange[]): RiskLevel {
    for (const c of changes) {
      if (c.risk === "CRITICAL") return "CRITICAL";
    }
    for (const c of changes) {
      if (c.risk === "HIGH") return "HIGH";
    }
    if (changes.length > HIGH_CHANGE_COUNT_THRESHOLD) return "MEDIUM";
    if (changes.some((c) => c.risk === "MEDIUM")) return "MEDIUM";
    return "LOW";
  }
}
