/**
 * ACS Semantic Degradation Guard
 * ==============================
 * 检测 agent 最常见"伪修复"模式：
 * - 空函数体 / 仅 return true/false
 * - TODO 替代完整实现
 * - empty catch 块
 * - silent fallback
 * - no-op rewrite（逻辑等价但无实质改动）
 * - constant return 替代真实逻辑
 */

export interface DegradationReport {
  passed: boolean;
  issues: DegradationIssue[];
}

export interface DegradationIssue {
  type: DegradationType;
  line: number;
  pattern: string;
  snippet: string;
}

export type DegradationType =
  | "empty-catch"
  | "todo-implementation"
  | "constant-return"
  | "empty-function"
  | "mock-implementation"
  | "silent-fallback"
  | "noop-rewrite"
  | "stub-function";

const DETECTORS: Array<{ type: DegradationType; pattern: RegExp; description: string }> = [
  // empty catch: catch { } or catch(e) {}
  { type: "empty-catch", pattern: /catch\s*(\([^)]*\))?\s*\{\s*\}/g, description: "empty catch block" },

  // TODO implementation: function body only has TODO / FIXME comment
  { type: "todo-implementation", pattern: /function\s+\w+[\s\S]*?\{\s*(?:\/\/\s*TODO|\/\*\s*TODO)[\s\S]*?\}/g, description: "TODO-only implementation" },

  // constant return: function returns only true/false/null/0
  { type: "constant-return", pattern: /function\s+\w+[\s\S]*?\{\s*(?:return\s+(?:true|false|null|0|undefined);?\s*)\}/g, description: "constant return only" },

  // empty function: function body is empty or only has a comment
  { type: "empty-function", pattern: /(?:async\s+)?function\s+\w+\s*\([^)]*\)\s*:\s*\w+\s*\{\s*(?:\/\/[^\n]*)?\s*\}/g, description: "empty function body" },

  // mock implementation: function that just returns the input or calls done()
  { type: "mock-implementation", pattern: /function\s+\w+[\s\S]*?\{\s*(?:return\s+\w+;?\s*|done\(\);?\s*)\}/g, description: "mock/stub function body" },

  // stub: interface implementation that just throws "not implemented"
  { type: "stub-function", pattern: /throw\s+new\s+Error\s*\(\s*(?:"|')(?:not\s+implemented|unimplemented|TODO)(?:"|')\s*\)/gi, description: "stub throws not implemented" },
];

const SNIPPET_MAX_LENGTH = 80;

export class SemanticGuard {
  /**
   * 检查文件内容中的语义降级模式。
   */
  check(content: string): DegradationReport {
    const issues: DegradationIssue[] = [];

    for (const detector of DETECTORS) {
      for (const match of content.matchAll(detector.pattern)) {
        const matchIndex = match.index || 0;
        const lineNo = content.slice(0, matchIndex).split("\n").length;
        const snippet = match[0]
          .slice(0, SNIPPET_MAX_LENGTH)
          .replace(/\n/g, "\\n");
        issues.push({
          type: detector.type,
          line: lineNo,
          pattern: detector.description,
          snippet,
        });
      }
    }

    return { passed: issues.length === 0, issues };
  }

  /**
   * 检查函数体是否被掏空。
   * 通过比较行数缩水判断：如果函数实现大幅缩短则标记。
   */
  checkFunctionShrink(beforeLines: number, afterLines: number, threshold = 0.5): DegradationIssue | null {
    if (afterLines < beforeLines * threshold) {
      const reductionPct = Math.round((1 - afterLines / beforeLines) * 100);
      return {
        type: "noop-rewrite",
        line: 0,
        pattern: `function body shrank ${beforeLines}→${afterLines} lines`,
        snippet: `implementation reduced by ${reductionPct}%`,
      };
    }
    return null;
  }
}