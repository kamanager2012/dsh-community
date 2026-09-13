/**
 * ACS Path Freeze
 * ===============
 * 禁止 agent 创建新路径和"污染性"文件名。
 * 只允许修改已存在文件，除非用户显式授权 create。
 */

const POLLUTED_PATTERNS = [
  /_new\b/i,
  /_newer\b/i,
  /_newest\b/i,
  /_fixed\b/i,
  /_final\b/i,
  /_ultimate\b/i,
  /_v\d+\b/i,
  /_copy\b/i,
  /_backup\b/i,
  /_bak\b/i,
  /_tmp\b/i,
  /_test\d*\b/i,
  /backup\//i,
  /tmp\//i,
  /test\//i,
  /temp\//i,
  /draft\//i,
];

const BLOCKED_BASENAMES = [
  "new", "fixed", "final", "ultimate", "backup",
  "test", "tmp", "temp", "copy", "draft",
];

export class PathFreeze {
  /**
   * 检查文件名是否被污染。
   * 返回违规描述，null = 通过。
   */
  checkPath(filePath: string): string | null {
    const basename = filePath.split("/").pop() || "";
    const name = basename.replace(/\.[^.]+$/, ""); // 去掉扩展名

    // 检查污染文件名模式
    if (BLOCKED_BASENAMES.includes(name)) {
      return `blocked filename pattern: ${basename}`;
    }

    for (const pattern of POLLUTED_PATTERNS) {
      if (pattern.test(name)) {
        return `blocked filename pattern: ${basename} (matches ${pattern})`;
      }
    }

    return null;
  }

  /**
   * 检查文件是否存在（禁止创建新文件）。
   * 除非 allowed_new_paths 中明确列出。
   */
  checkNewPath(filePath: string, exists: boolean, allowedNewPaths: string[] = []): string | null {
    if (exists) return null;
    if (allowedNewPaths.includes(filePath)) return null;
    return `new path not allowed: ${filePath}`;
  }
}
