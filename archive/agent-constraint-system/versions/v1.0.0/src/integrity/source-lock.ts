/**
 * ACS Source Lock
 * ===============
 * 保护用户输入的原始代码不被 agent 截断或压缩。
 * 记录原始 SHA256、行数、逐行 token 数，写入后对比。
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface SourceRecord {
  filePath: string;
  originalHash: string;
  originalLines: number;
  originalSize: number;
  lockedAt: number;
  snapshots: SnapshotEntry[];
}

export interface SnapshotEntry {
  hash: string;
  lines: number;
  size: number;
  takenAt: number;
}

export interface SourceVerification {
  ok: boolean;
  errors: string[];
  lineDiff: number;
  sizeDiff: number;
  hashMatch: boolean;
}

const LOCK_DIR = join(import.meta.dirname, "../../.claude/runtime/source-locks");
const LOCK_EXT = ".lock.json";

export class SourceLock {
  /**
   * 锁定文件的原始状态（用户输入代码时调用）。
   */
  lock(filePath: string, content: string): SourceRecord {
    if (!existsSync(LOCK_DIR)) mkdirSync(LOCK_DIR, { recursive: true });
    const hash = createHash("sha256").update(content).digest("hex");
    const lines = content.split("\n");
    const record: SourceRecord = {
      filePath,
      originalHash: hash,
      originalLines: lines.length,
      originalSize: content.length,
      lockedAt: Date.now(),
      snapshots: [{ hash, lines: lines.length, size: content.length, takenAt: Date.now() }],
    };
    this._save(record);
    return record;
  }

  /**
   * 校验文件是否与原始版本一致（或偏差在可接受范围内）。
   */
  verify(filePath: string): SourceVerification {
    const record = this._load(filePath);
    if (!record) return { ok: true, errors: ["no source lock"], lineDiff: 0, sizeDiff: 0, hashMatch: true };

    const content = readFileSync(filePath, "utf-8");
    const currentHash = createHash("sha256").update(content).digest("hex");
    const currentLines = content.split("\n").length;
    const errors: string[] = [];

    // 1. 行数大幅减少 → 截断
    const lineDiff = currentLines - record.originalLines;
    if (currentLines < record.originalLines * 0.6) {
      errors.push(`line count dropped: ${record.originalLines} → ${currentLines} (${Math.round((1 - currentLines / record.originalLines) * 100)}%)`);
    }

    // 2. 大小大幅减少 → 内容丢失
    const sizeDiff = content.length - record.originalSize;
    if (content.length < record.originalSize * 0.5) {
      errors.push(`file shrank: ${record.originalSize} → ${content.length}b (${Math.round((1 - content.length / record.originalSize) * 100)}%)`);
    }

    // 3. 完整 hash 匹配
    const hashMatch = currentHash === record.originalHash;

    // 记录快照（不可变：创建新 record 对象）
    const updatedRecord: SourceRecord = {
      ...record,
      snapshots: [
        ...record.snapshots,
        { hash: currentHash, lines: currentLines, size: content.length, takenAt: Date.now() },
      ],
    };
    this._save(updatedRecord);

    return { ok: errors.length === 0, errors, lineDiff, sizeDiff, hashMatch };
  }

  /**
   * 获取文件的锁定记录。
   */
  getRecord(filePath: string): SourceRecord | null {
    return this._load(filePath);
  }

  private _lockPath(filePath: string): string {
    const safe = filePath.replace(/\//g, "_").replace(/\\/g, "_");
    return join(LOCK_DIR, safe + LOCK_EXT);
  }

  private _save(record: SourceRecord): void {
    writeFileSync(this._lockPath(record.filePath), JSON.stringify(record, null, 2));
  }

  private _load(filePath: string): SourceRecord | null {
    const lp = this._lockPath(filePath);
    try {
      return JSON.parse(readFileSync(lp, "utf-8"));
    } catch {
      return null;
    }
  }
}
