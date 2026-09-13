/**
 * ACS File Integrity Manifest
 * ===========================
 * 写入前快照文件状态：hash、行数、导出符号、函数数。
 * 写入后校验，防止 agent 丢代码、删 export、截断文件。
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

export interface FileFingerprint {
  path: string;
  lines: number;
  size: number;
  hash: string;
  exports: string[];
  functions: string[];
  classes: string[];
  interfaces: string[];
}

// 简单正则提取 export/function/class/interface 名
const EXPORT_RE = /^export\s+(interface|type|class|function|const|enum|let|var)\s+(\w+)/gm;
const FUNC_RE = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|(\w+)\s*[=(]\s*(?:async\s*)?\(/gm;
const CLASS_RE = /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm;
const IFACE_RE = /^(?:export\s+)?interface\s+(\w+)/gm;

export class FileIntegrity {
  /**
   * 对文件生成指纹快照。
   */
  snapshot(filePath: string): FileFingerprint | null {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    const exports: string[] = [];
    for (const m of content.matchAll(EXPORT_RE)) {
      exports.push(m[2]);
    }

    const functions: string[] = [];
    for (const m of content.matchAll(FUNC_RE)) {
      functions.push(m[1] || m[2]);
    }

    const classes: string[] = [];
    for (const m of content.matchAll(CLASS_RE)) {
      classes.push(m[1]);
    }

    const interfaces: string[] = [];
    for (const m of content.matchAll(IFACE_RE)) {
      interfaces.push(m[1]);
    }

    return {
      path: filePath,
      lines: lines.length,
      size: content.length,
      hash: createHash("sha256").update(content).digest("hex"),
      exports: [...new Set(exports)],
      functions: [...new Set(functions)],
      classes: [...new Set(classes)],
      interfaces: [...new Set(interfaces)],
    };
  }

  /**
   * 校验写入后的文件是否合规。
   * 返回违规列表（空数组 = 通过）。
   */
  verify(before: FileFingerprint, after: FileFingerprint): string[] {
    const errors: string[] = [];

    // 1. 行数缩减 > 40% → 高危
    if (after.lines < before.lines * 0.6) {
      errors.push(`line count dropped ${before.lines}→${after.lines} (${Math.round((1 - after.lines / before.lines) * 100)}%)`);
    }

    // 2. export 消失
    const lostExports = before.exports.filter((e) => !after.exports.includes(e));
    for (const e of lostExports) {
      errors.push(`export removed: ${e}`);
    }

    // 3. class 消失
    const lostClasses = before.classes.filter((c) => !after.classes.includes(c));
    for (const c of lostClasses) {
      errors.push(`class removed: ${c}`);
    }

    // 4. interface 消失
    const lostInterfaces = before.interfaces.filter((i) => !after.interfaces.includes(i));
    for (const i of lostInterfaces) {
      errors.push(`interface removed: ${i}`);
    }

    // 5. 文件大小缩减 > 50%
    if (after.size < before.size * 0.5) {
      errors.push(`file shrunk ${before.size}→${after.size}b (${Math.round((1 - after.size / before.size) * 100)}%)`);
    }

    // 6. 文件变空
    if (after.lines === 0 || after.size === 0) {
      errors.push("file is empty");
    }

    return errors;
  }

  /**
   * 简化的单步校验：给文件路径，返回校验结果。
   */
  verifyPath(filePath: string, beforeSnapshot: FileFingerprint): { ok: boolean; errors: string[]; after: FileFingerprint | null } {
    const after = this.snapshot(filePath);
    if (!after) return { ok: false, errors: ["file missing after write"], after: null };
    const errors = this.verify(beforeSnapshot, after);
    return { ok: errors.length === 0, errors, after };
  }
}
