/**
 * ACS Patch Constraint
 * =====================
 * Agent 只能输出结构化 patch（diff），不能直接覆写文件。
 * Runtime 验证 patch 合法性后再 apply。
 */

export interface PatchLine {
  type: "add" | "del" | "ctx";  // added, deleted, context
  content: string;
}

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: PatchLine[];
}

export interface Patch {
  filePath: string;
  hunks: PatchHunk[];
}

export interface PatchValidation {
  valid: boolean;
  errors: string[];
  addedLines: number;
  deletedLines: number;
}

export class PatchConstraint {
  /**
   * 解析 unified diff 文本为结构化 Patch。
   * 支持标准 @@ -a,b +c,d @@ 格式。
   */
  parse(raw: string): Patch | null {
    const lines = raw.split("\n");
    let filePath = "";
    const hunks: PatchHunk[] = [];
    let currentHunk: PatchHunk | null = null;

    for (const line of lines) {
      const headerMatch = line.match(/^\+\+\+ b\/(.+)$/);
      if (headerMatch) {
        filePath = headerMatch[1];
        continue;
      }

      const hunkMatch = line.match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
      if (hunkMatch) {
        if (currentHunk) hunks.push(currentHunk);
        currentHunk = {
          oldStart: parseInt(hunkMatch[1]),
          oldLines: parseInt(hunkMatch[2] || "1"),
          newStart: parseInt(hunkMatch[3]),
          newLines: parseInt(hunkMatch[4] || "1"),
          lines: [],
        };
        continue;
      }

      if (currentHunk) {
        if (line.startsWith("+")) {
          currentHunk.lines.push({ type: "add", content: line.slice(1) });
        } else if (line.startsWith("-")) {
          currentHunk.lines.push({ type: "del", content: line.slice(1) });
        } else {
          currentHunk.lines.push({ type: "ctx", content: line.startsWith(" ") ? line.slice(1) : line });
        }
      }
    }

    if (currentHunk) hunks.push(currentHunk);
    if (!filePath) return null;
    return { filePath, hunks };
  }

  /**
   * 验证 patch 是否在约束范围内。
   */
  validate(patch: Patch, allowedFiles: string[]): PatchValidation {
    const errors: string[] = [];
    let added = 0;
    let deleted = 0;

    // 1. 检查文件路径是否允许（支持完整路径、目录通配、basename 后缀匹配）
    const allowed = allowedFiles.some((p) => {
      if (p.endsWith("/**")) return patch.filePath.startsWith(p.slice(0, -3));
      if (p.endsWith("/" + patch.filePath)) return true;
      return patch.filePath === p;
    });
    if (!allowed) errors.push(`file not allowed: ${patch.filePath}`);

    // 2. 统计 +/- 行数
    for (const hunk of patch.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "add") added++;
        if (line.type === "del") deleted++;
      }
    }

    // 3. 防止全量重写（过多的删除+新增）
    if (deleted > 200) errors.push(`too many deletions: ${deleted} > 200`);
    if (added > 200) errors.push(`too many additions: ${added} > 200`);
    if (deleted === 0 && added === 0) errors.push("empty patch");

    return { valid: errors.length === 0, errors, addedLines: added, deletedLines: deleted };
  }
}
