// index.ts — OpenCode Plugin (ACS)
// Agent Constraint System for OpenCode CLI

import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import {
  DANGEROUS_BASH,
  GIT_DESTRUCTIVE,
  FORBIDDEN_ROOTS,
  isForbiddenPath,
  audit,
  cleanCommand,
} from "./guard";

export default async function oacs(
  _input: PluginInput,
  _options?: PluginOptions,
): Promise<Hooks> {
  return {
    "tool.execute.before": async (input, output) => {
      const { tool, sessionID } = input;
      const args = output.args || {};

      // ── Bash guard ──
      if (tool === "bash" || tool === "shell") {
        const cmd: string = args.command || args.cmd || "";
        if (cmd) {
          const cleaned = cleanCommand(cmd);

          // Check dangerous Bash
          for (const [pattern, desc] of DANGEROUS_BASH) {
            if (pattern.test(cleaned)) {
              audit("tool.execute.before", tool, sessionID, "deny",
                `bash_dangerous: ${desc}`);
              throw new Error(`[OACS] Blocked dangerous command: ${desc}`);
            }
          }

          // Check git destructive
          for (const [pattern, desc] of GIT_DESTRUCTIVE) {
            if (pattern.test(cmd)) {
              audit("tool.execute.before", tool, sessionID, "deny",
                `git_destructive: ${desc}`);
              throw new Error(`[OACS] Blocked destructive git: ${desc}`);
            }
          }
        }
      }

      // ── File write guard ──
      if (tool === "write" || tool === "edit" || tool === "apply_patch") {
        const fp: string = args.file_path || args.filePath || args.path || "";
        if (fp) {
          const { resolve } = await import("node:path");
          const resolved = resolve(fp);

          if (isForbiddenPath(resolved)) {
            audit("tool.execute.before", tool, sessionID, "deny",
              `forbidden_path: ${resolved}`);
            throw new Error(`[OACS] Write to ${resolved} is forbidden`);
          }

          // Self-protection
          if (resolved.includes("oacs") || resolved.includes(".opencode/hooks")) {
            audit("tool.execute.before", tool, sessionID, "deny",
              "self_protect: oacs");
            throw new Error("[OACS] Cannot modify OACS system files");
          }
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      audit("tool.execute.after", input.tool, input.sessionID, "allow",
        `response_size: ${String(output.output || "").length}`);
    },

    "permission.ask": async (input, output) => {
      const { tool, pattern } = input as any;
      // Block permission requests for dangerous patterns
      if (pattern && (
        pattern.includes("rm -rf") ||
        pattern.includes("git restore") ||
        pattern.includes("git reset --hard") ||
        pattern.includes("git clean") ||
        pattern.includes("git push --force")
      )) {
        output.status = "deny";
      }
    },
  };
}
