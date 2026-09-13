/**
 * ACS Workspace Snapshot
 * ======================
 * 任务开始前对整个 workspace 建立不可变快照。
 * 包括：文件 hash、文件数量、目录树、export surface。
 * 任务结束后 diff 对比，精确定位哪一步破坏了系统。
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { SNAPSHOT_DIR } from "./constants.js";

export interface FileEntry {
  path: string;
  hash: string;
  lines: number;
  size: number;
  exports: string[];
}

export interface WorkspaceState {
  id: string;
  takenAt: number;
  fileCount: number;
  totalLines: number;
  totalSize: number;
  files: FileEntry[];
  tree: string[];
}

export interface WorkspaceDiff {
  modified: FileEntry[];
  deleted: FileEntry[];
  newFiles: FileEntry[];
  totalChanges: number;
}

const EXPORT_RE = /^export\s+(interface|type|class|function|const|enum|let|var|default\s+function)\s+(\w+)/gm;

export class WorkspaceSnapshot {
  /**
   * 对 workspace 建立快照。
   */
  snapshot(rootDir: string, label = "pre-task"): WorkspaceState {
    if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });

    const files: FileEntry[] = [];
    const tree: string[] = [];

    this._walk(rootDir, rootDir, files, tree);

    const id = `snap-${Date.now().toString(36)}`;

    const computedTotalLines = files.reduce((s, f) => s + f.lines, 0);
    const computedTotalSize = files.reduce((s, f) => s + f.size, 0);

    const state: WorkspaceState = {
      id,
      takenAt: Date.now(),
      fileCount: files.length,
      totalLines: computedTotalLines,
      totalSize: computedTotalSize,
      files,
      tree: tree.sort(),
    };

    this._save(label, state);
    return state;
  }

  /**
   * 对比两个快照，找出变化。
   */
  diff(label: string, before: WorkspaceState, after?: WorkspaceState): WorkspaceDiff {
    const afterSnap = after || this._load(label);
    if (!afterSnap) return { modified: [], deleted: [], newFiles: [], totalChanges: 0 };

    const beforeMap = new Map(before.files.map((f) => [f.path, f]));
    const afterMap = new Map(afterSnap.files.map((f) => [f.path, f]));

    const modified: FileEntry[] = [];
    const deleted: FileEntry[] = [];
    const newFiles: FileEntry[] = [];

    for (const [path, entry] of afterMap) {
      const before = beforeMap.get(path);
      if (!before) {
        newFiles.push(entry);
      } else if (before.hash !== entry.hash) {
        modified.push(entry);
      }
    }

    for (const [path, entry] of beforeMap) {
      if (!afterMap.has(path)) {
        deleted.push(entry);
      }
    }

    return { modified, deleted, newFiles, totalChanges: modified.length + deleted.length + newFiles.length };
  }

  /**
   * 加载已保存的快照。
   */
  load(label: string): WorkspaceState | null {
    return this._load(label);
  }

  private _walk(dir: string, rootDir: string, files: FileEntry[], tree: string[]): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry);
      const rel = relative(rootDir, full);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (entry.startsWith(".") || entry === "node_modules" || entry === "dist" || entry === ".git") continue;
        tree.push(rel + "/");
        this._walk(full, rootDir, files, tree);
      } else if (entry.endsWith(".ts") || entry.endsWith(".tsx") || entry.endsWith(".js") || entry.endsWith(".jsx") || entry.endsWith(".json") || entry.endsWith(".py") || entry.endsWith(".go") || entry.endsWith(".rs") || entry.endsWith(".sql")) {
        let content: string;
        try {
          content = readFileSync(full, "utf-8");
        } catch {
          continue;
        }
        const hash = createHash("sha256").update(content).digest("hex");
        const lines = content.split("\n").length;
        const exports: string[] = [];
        for (const m of content.matchAll(EXPORT_RE)) {
          exports.push(m[2]);
        }
        files.push({ path: rel, hash, lines, size: content.length, exports });
        tree.push(rel);
      }
    }
  }

  private _save(label: string, state: WorkspaceState): void {
    const safe = label.replace(/[^a-zA-Z0-9_-]/g, "_");
    writeFileSync(join(SNAPSHOT_DIR, `${safe}.json`), JSON.stringify(state, null, 2));
  }

  private _load(label: string): WorkspaceState | null {
    const safe = label.replace(/[^a-zA-Z0-9_-]/g, "_");
    const path = join(SNAPSHOT_DIR, `${safe}.json`);
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return null;
    }
  }
}
