#!/usr/bin/env node
// governor-core — Claude Code PreToolUse hook adapter.
//
// Reads a PreToolUse event as JSON on stdin, normalizes it into a ToolCall,
// asks the GovernanceEngine, and emits the hook's JSON decision on stdout.
//
// Install (in ~/.claude/settings.json):
//   {
//     "hooks": {
//       "PreToolUse": [
//         {
//           "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit",
//           "hooks": [
//             { "type": "command",
//               "command": "node /ABS/PATH/aigov/dist/adapters/claude-code/hook.js" }
//           ]
//         }
//       ]
//     }
//   }
//
// KNOWN BLIND SPOTS (MVP demos use Bash/Write/Edit to avoid these):
//   - PreToolUse exit code 2 does not propagate for the `Task` sub-agent tool
//     (anthropics/claude-code #26923). Sub-agent spawned tools aren't gated.
//   - permissionDecision:"allow" has had a bug where it was not always honored
//     (#52822). We rely on "deny"/"ask" for enforcement; "allow" is best-effort.

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolCall, Verdict } from "../../types.js";
import { GovernanceEngine } from "../../engine.js";
import { ScopeValidator } from "../../scope.js";
import { loadPolicy, mergeWithDefault } from "../../policy.js";
import { AuditLog, FileAuditSink } from "../../audit.js";
import { ApprovalStore } from "../../approval.js";

interface PreToolUseEvent {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/** Map a Claude Code PreToolUse event into the agent-agnostic ToolCall. */
export function normalize(evt: PreToolUseEvent): ToolCall {
  const tool = evt.tool_name ?? "";
  const input = evt.tool_input ?? {};
  const call: ToolCall = { tool, raw: evt };
  if (typeof input.command === "string") call.command = input.command;
  // Write/Edit/MultiEdit/NotebookEdit all carry the target as file_path.
  if (typeof input.file_path === "string") call.file = input.file_path;
  else if (typeof input.notebook_path === "string") call.file = input.notebook_path;
  return call;
}

/** Map an engine Verdict to the Claude Code PreToolUse hook JSON output. */
export function toHookOutput(v: Verdict): unknown {
  const permissionDecision = v.decision; // "allow" | "deny" | "ask"
  let reason = v.reason;
  if (v.decision === "ask" && v.pendingId) {
    reason += `\n\nTo approve this once, run:\n  aigov approve ${v.pendingId}\nthen retry the operation.`;
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reason,
    },
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function auditPath(): string {
  return process.env.AIGOV_AUDIT ?? join(homedir(), ".aigov", "audit.jsonl");
}
function approvalsDir(): string {
  return process.env.AIGOV_APPROVALS ?? join(homedir(), ".aigov", "approvals");
}
function policyPath(): string | undefined {
  return process.env.AIGOV_POLICY;
}

export async function buildEngine(): Promise<GovernanceEngine> {
  const now = () => new Date().toISOString();
  let scope = new ScopeValidator();
  const pp = policyPath();
  if (pp) {
    const res = await loadPolicy(pp, now);
    if (res.ok) scope = new ScopeValidator(mergeWithDefault(res.policy));
  }
  const auditFile = auditPath();
  const approvalsBase = approvalsDir();
  const audit = new AuditLog(new FileAuditSink(auditFile), now, "claude-code");
  const approvals = new ApprovalStore(approvalsBase);
  return new GovernanceEngine({
    scope,
    audit,
    approvals,
    askPaths: ["**/.env", "**/*.pem", "**/id_rsa"],
    askCommands: ["git push"],
    protectedPaths: selfProtectedPaths(auditFile, approvalsBase, pp),
    now,
  });
}

/** Fragments identifying governor-core's own state and code. Any mutation that
 *  references one is denied (self-protection). Kept to precise, absolute paths
 *  (install root, configured audit/approvals/policy, ~/.aigov) so it protects the
 *  governor without over-blocking a user project that happens to have like-named
 *  files. */
function selfProtectedPaths(auditFile: string, approvalsBase: string, policyFile?: string): string[] {
  const pkgRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))); // dist|src -> pkg
  const frags = [
    auditFile,
    approvalsBase,
    join(homedir(), ".aigov"),
    pkgRoot,
    "governor-core",
  ];
  if (policyFile) frags.push(policyFile);
  return [...new Set(frags.filter(Boolean))];
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let evt: PreToolUseEvent;
  try {
    evt = JSON.parse(raw) as PreToolUseEvent;
  } catch {
    // Malformed event: fail closed with a deny.
    process.stdout.write(
      JSON.stringify(
        toHookOutput({ decision: "deny", reason: "hook received malformed event JSON" }),
      ),
    );
    process.exit(0);
  }
  const engine = await buildEngine();
  const verdict = await engine.evaluate(normalize(evt));
  process.stdout.write(JSON.stringify(toHookOutput(verdict)));
  process.exit(0);
}

// Only run when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith("hook.js");
if (invokedDirectly) {
  main().catch((err) => {
    process.stdout.write(
      JSON.stringify(
        toHookOutput({ decision: "deny", reason: `hook error, failing closed: ${err}` }),
      ),
    );
    process.exit(0);
  });
}
