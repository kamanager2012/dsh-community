/**
 * ACS Patch Transaction
 * ======================
 * 原子化 patch 事务：BEFORE → PATCH → VALIDATE → APPLY → COMMIT / ROLLBACK。
 * 确保 patch 要么完全应用，要么完全回滚。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { PatchConstraint, Patch, PatchValidation, PatchHunk } from "./patch.js";
import { PatchClassifier, PatchClassification } from "./classifier.js";

export type TransactionStatus = "pending" | "approved" | "rejected" | "applied" | "rolled-back" | "failed";

export interface PatchTransaction {
  id: string;
  filePath: string;
  rawPatch: string;
  parsed: Patch | null;
  classification: PatchClassification | null;
  beforeHash: string;
  beforeContent: string;
  afterHash: string | null;
  status: TransactionStatus;
  errors: string[];
  createdAt: number;
  appliedAt?: number;
}

export class PatchTransactionSystem {
  private readonly patchValidator = new PatchConstraint();
  private readonly classifier = new PatchClassifier();
  private transactions: PatchTransaction[] = [];

  /**
   * 开始事务：读取原始文件，记录 before hash + 原始内容（用于回滚）。
   */
  begin(filePath: string, rawPatch: string): PatchTransaction {
    const beforeContent = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
    const beforeHash = createHash("sha256").update(beforeContent).digest("hex");
    const parsed = this.patchValidator.parse(rawPatch);

    const tx: PatchTransaction = {
      id: `tx-${Date.now().toString(36)}`,
      filePath,
      rawPatch,
      parsed,
      classification: null,
      beforeHash,
      beforeContent,
      afterHash: null,
      status: "pending",
      errors: [],
      createdAt: Date.now(),
    };

    this.transactions.push(tx);
    return tx;
  }

  /**
   * 验证事务：patch 合法性 + 风险分类。
   */
  validate(txId: string, extraAllowedFiles: string[] = []): PatchTransaction {
    const tx = this.transactions.find((t) => t.id === txId);
    if (!tx) throw new Error(`transaction not found: ${txId}`);

    if (!tx.parsed) {
      tx.status = "failed";
      tx.errors.push("patch parse failed");
      return tx;
    }

    const validation = this.patchValidator.validate(tx.parsed, [tx.filePath, ...extraAllowedFiles]);
    if (!validation.valid) {
      tx.status = "rejected";
      tx.errors.push(...validation.errors);
      return tx;
    }

    const addedLines = tx.parsed.hunks.flatMap((h) => h.lines.filter((l) => l.type === "add")).map((l) => l.content);
    const deletedLines = tx.parsed.hunks.flatMap((h) => h.lines.filter((l) => l.type === "del")).map((l) => l.content);
    tx.classification = this.classifier.classify(tx.filePath, addedLines, deletedLines);

    if (tx.classification.overallRisk === "CRITICAL" || tx.classification.overallRisk === "HIGH") {
      tx.status = "pending";
      tx.errors.push(`requires approval: risk=${tx.classification.overallRisk}`);
      return tx;
    }

    tx.status = "approved";
    return tx;
  }

  /**
   * 应用 patch。
   */
  apply(txId: string): PatchTransaction {
    const tx = this.transactions.find((t) => t.id === txId);
    if (!tx) throw new Error(`transaction not found: ${txId}`);
    if (tx.status !== "approved") {
      tx.errors.push("cannot apply: transaction not approved");
      return tx;
    }

    try {
      const content = readFileSync(tx.filePath, "utf-8");
      const result = this._applyPatch(content, tx.parsed!);
      writeFileSync(tx.filePath, result, "utf-8");
      tx.afterHash = createHash("sha256").update(result).digest("hex");
      tx.status = "applied";
      tx.appliedAt = Date.now();
    } catch (e: unknown) {
      tx.status = "failed";
      tx.errors.push(`apply failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    return tx;
  }

  /**
   * 回滚：恢复到事务开始前的原始内容。
   */
  rollback(txId: string): PatchTransaction {
    const tx = this.transactions.find((t) => t.id === txId);
    if (!tx) throw new Error(`transaction not found: ${txId}`);

    try {
      if (tx.status === "applied") {
        writeFileSync(tx.filePath, tx.beforeContent, "utf-8");
      }
      tx.status = "rolled-back";
    } catch (e: unknown) {
      tx.status = "failed";
      tx.errors.push(`rollback failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    return tx;
  }

  /**
   * DRY RUN：模拟 apply 但不写入文件。
   */
  simulate(txId: string): { wouldSucceed: boolean; virtualResult: string | null; errors: string[] } {
    const tx = this.transactions.find((t) => t.id === txId);
    if (!tx) throw new Error(`transaction not found: ${txId}`);
    if (!tx.parsed) return { wouldSucceed: false, virtualResult: null, errors: ["patch parse failed"] };

    const beforeContent = existsSync(tx.filePath) ? readFileSync(tx.filePath, "utf-8") : "";
    const errors: string[] = [];

    try {
      const result = this._applyPatch(beforeContent, tx.parsed);
      return { wouldSucceed: true, virtualResult: result, errors: [] };
    } catch (e: unknown) {
      errors.push(`simulate failed: ${e instanceof Error ? e.message : String(e)}`);
      return { wouldSucceed: false, virtualResult: null, errors };
    }
  }

  getHistory(): PatchTransaction[] {
    return [...this.transactions];
  }

  // ── private ──

  /**
   * Unified diff apply（边界条件修复）。
   *
   * 支持：
   * - 文件末尾无换行符（ trailing newline 处理）
   * - 多 hunk（反向应用避免行号偏移）
   * - 空行和纯空格行
   *
   * 限制：
   * - 假设 patch 与原文件基本匹配（标准 unified diff 保证）
   * - 不支持 fuzz matching（需上层 retry 逻辑）
   */
  private _applyPatch(original: string, patch: Patch): string {
    const hasTrailingNewline = original.endsWith("\n");
    const lines = original.split("\n");

    // 从文件末尾反向应用 hunk，避免行号偏移影响后续 hunk
    const sorted = [...patch.hunks].sort((a, b) => b.oldStart - a.oldStart);

    for (const hunk of sorted) {
      const result = this._applyHunk(lines, hunk, hasTrailingNewline);
      if (!result.ok) {
        throw new Error(`hunk at line ${hunk.oldStart} failed: ${result.error}`);
      }
    }

    // 还原末尾换行符语义
    return lines.join("\n");
  }

  /**
   * 应用单个 hunk 到行数组。
   * 返回 { ok, error }。
   */
  private _applyHunk(lines: string[], hunk: PatchHunk, hasTrailingNewline: boolean): { ok: boolean; error?: string } {
    // hunk.oldStart 是 1-based 行号
    const startIdx = hunk.oldStart - 1;

    // 验证起始 context line 是否匹配
    if (hunk.lines.length > 0 && hunk.lines[0].type === "ctx") {
      const expected = hunk.lines[0].content;
      if (startIdx < lines.length && lines[startIdx] !== expected) {
        return { ok: false, error: `context mismatch at line ${hunk.oldStart}: expected "${expected}", got "${lines[startIdx]}"` };
      }
    }

    // 构建 hunk 结果
    const hunkLines: string[] = [];
    let srcIdx = startIdx;
    let hunkIdx = 0;

    while (hunkIdx < hunk.lines.length) {
      const hl = hunk.lines[hunkIdx];

      if (hl.type === "ctx") {
        // context line：使用原文件行（跳过已删除的）
        if (srcIdx < lines.length) {
          hunkLines.push(lines[srcIdx]);
        }
        srcIdx++;
        hunkIdx++;
      } else if (hl.type === "del") {
        // deletion：跳过原文件行（不加入 hunk）
        srcIdx++;
        hunkIdx++;
      } else if (hl.type === "add") {
        // addition：直接添加新行
        hunkLines.push(hl.content);
        hunkIdx++;
      }
    }

    // 计算原 hunk 覆盖的行数（oldLines 可能不精确，用实际处理行数）
    const consumedLines = srcIdx - startIdx;
    const deleteCount = Math.min(consumedLines, lines.length - startIdx);

    // splice：删除 oldLines 行（在 startIdx），插入 hunkLines
    const deleteActual = Math.min(deleteCount, lines.length - startIdx);
    if (deleteActual > 0) {
      lines.splice(startIdx, deleteActual, ...hunkLines);
    } else {
      // 插入模式（append to file or at specific position）
      if (startIdx >= lines.length) {
        lines.push(...hunkLines);
      } else {
        lines.splice(startIdx, 0, ...hunkLines);
      }
    }

    return { ok: true };
  }
}
