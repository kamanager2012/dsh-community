// guard.ts — OACS core guard logic
// Shared patterns for Bash interception, Git protection, and path auditing.

import { join } from "node:path";
import { homedir } from "node:os";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";

const HOME = homedir();
const RUNTIME_DIR = join(HOME, ".opencode", "oacs_runtime");
const AUDIT_LOG = join(RUNTIME_DIR, "tool-audit.jsonl");

// ── Dangerous Bash patterns ─────────────────────────────────────────────────

export const DANGEROUS_BASH: [RegExp, string][] = [
  [/rm\s+(?:-[a-z]*f[a-z]*\s+)+(?:\/(?:\s|$)|\/\*\s|~(?:\s|$)|\*(?:\s|$))/i, "rm -rf targeting root/home/wildcard"],
  [/kill\s+-9\b/i, "kill -9 (force kill)"],
  [/mkfs\./i, "mkfs (disk format)"],
  [/dd\s+if=\/dev\//i, "dd writing to block device"],
  [/\bsed\b\s+-i\b/, "sed -i (WSL in-place edit, rename race risk)"],
  [/\bsed\b\s+--in-place\b/, "sed --in-place (WSL truncation risk)"],
];

// ── Git destructive patterns ────────────────────────────────────────────────

export const GIT_DESTRUCTIVE: [RegExp, string][] = [
  [/git\s+restore\s+.*--\s+\.$/, "git restore -- . (uncontrolled overwrite)"],
  [/git\s+reset\s+--hard/, "git reset --hard (destroys uncommitted work)"],
  [/git\s+clean\s+-[fdx]+/, "git clean -f/d/x (deletes untracked files)"],
  [/git\s+push\s+--force/, "git push --force (overwrites remote history)"],
  [/git\s+push\s+-f\b/, "git push -f (overwrites remote history)"],
  [/git\s+branch\s+-[dD]\s+(?:main|master)\b/, "git branch -d/D main/master (protected)"],
  [/git\s+branch\s+-[mM]\s+(?:main|master)\b/, "git branch -m/M main/master (protected)"],
];

// ── Forbidden system roots ──────────────────────────────────────────────────

export const FORBIDDEN_ROOTS = new Set([
  "/", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64",
  "/proc", "/root", "/run", "/sbin", "/sys", "/tmp", "/usr", "/var",
]);

export function isForbiddenPath(fp: string): boolean {
  for (const root of FORBIDDEN_ROOTS) {
    if (fp === root || fp.startsWith(root + "/")) return true;
  }
  return false;
}

// ── Audit logging ───────────────────────────────────────────────────────────

export function audit(event: string, tool: string, sessionID: string, outcome: string, detail = "") {
  if (!existsSync(RUNTIME_DIR)) return;
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    appendFileSync(AUDIT_LOG, JSON.stringify({
      ts: Date.now() / 1000,
      event,
      tool,
      sessionID,
      outcome,
      detail,
    }) + "\n");
  } catch {
    // audit must never block
  }
}

// ── Command cleaning ────────────────────────────────────────────────────────

export function cleanCommand(cmd: string): string {
  return cmd
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
    .replace(/<<\s*["']?(\w+)["']?\s*\n.*?\n\s*\1/gs, "<<HEREDOC>>");
}
