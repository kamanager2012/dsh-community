/**
 * ACS Rollback Engine
 * ===================
 * 违规或校验失败时自动回滚被修改的文件到原始状态。
 * 基于 workspace snapshot 实现原子恢复。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WorkspaceSnapshot, WorkspaceState, FileEntry } from "./workspace-snapshot.js";
import { BACKUP_DIR } from "./constants.js";

export interface RollbackResult {
  ok: boolean;
  restored: string[];
  failed: string[];
  errors: string[];
}

export class RollbackEngine {
  private snapshot: WorkspaceSnapshot;

  constructor(snapshot: WorkspaceSnapshot) {
    this.snapshot = snapshot;
  }

  /**
   * 回滚单个文件到快照状态。
   */
  rollbackFile(entry: FileEntry): boolean {
    const backupPath = this._backupPath(entry.path, entry.hash);
    if (!existsSync(backupPath)) return false;
    try {
      const content = readFileSync(backupPath, "utf-8");
      writeFileSync(entry.path, content, "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 回滚整个 workspace 到某次快照。
   */
  rollbackAll(snapshotLabel: string): RollbackResult {
    const state = this.snapshot.load(snapshotLabel);
    if (!state) {
      return { ok: false, restored: [], failed: [], errors: [`snapshot not found: ${snapshotLabel}`] };
    }

    const restored: string[] = [];
    const failed: string[] = [];
    const errors: string[] = [];

    for (const entry of state.files) {
      const ok = this.rollbackFile(entry);
      if (ok) restored.push(entry.path);
      else failed.push(entry.path);
    }

    return { ok: failed.length === 0, restored, failed, errors };
  }

  /**
   * 在写入前备份文件（由 PreToolUse hook 调用）。
   */
  backupBeforeWrite(filePath: string): boolean {
    if (!existsSync(filePath)) return true;
    if (!existsSync(BACKUP_DIR)) {
      mkdirSync(BACKUP_DIR, { recursive: true });
    }
    try {
      const content = readFileSync(filePath, "utf-8");
      const hash = createHash("sha256").update(content).digest("hex");
      writeFileSync(this._backupPath(filePath, hash), content, "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  private _backupPath(filePath: string, hash: string): string {
    const safe = filePath.replace(/\//g, "_").replace(/\\/g, "_");
    return join(BACKUP_DIR, `${safe}_${hash}.bak`);
  }
}
