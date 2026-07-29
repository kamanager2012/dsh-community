// governor-core — GovernanceEngine: deterministic, fail-closed decision core.
//
// evaluate(call) -> Verdict, orchestrating scope + approval + audit:
//   0. Self-protection: any attempt to mutate governor-core's own files
//      (engine/policy/audit/approvals) is denied outright — even a valid
//      approval token cannot authorize tampering with the governor itself.
//   1. If a human already granted a one-time token for this exact operation,
//      consume it and allow.
//   2. Route by tool: shell tools -> scope.validateCommand + mass-delete check;
//      file-mutating tools -> scope.validatePath. Scope deny => deny.
//   3. Scope-allowed but matching an ask-rule (sensitive path/command) => ask,
//      recording a pending request the human can approve.
//   4. Read-only tools are allowed (auditing, not blocking, so the agent still
//      functions); anything unrecognized and mutating is denied (fail-closed).
//   5. EVERY verdict writes one hash-chained AuditEvent. If the audit write
//      fails, the call is denied — a governance tool must never act unlogged.

import type { ToolCall, Verdict } from "./types.js";
import { ScopeValidator } from "./scope.js";
import { globMatch } from "./scope.js";
import { AuditLog } from "./audit.js";
import { ApprovalStore } from "./approval.js";

/** Tools that can mutate the filesystem and must be path-validated. */
export const DEFAULT_MUTATING_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
/** Tools that only read; allowed-and-audited so the agent isn't broken. */
export const DEFAULT_READONLY_TOOLS = ["Read", "Grep", "Glob", "LS"];
/** Tools whose payload is a shell command line. */
export const DEFAULT_SHELL_TOOLS = ["Bash"];

/** Shell verbs/operators that mutate a file the command references. */
const MUTATION_VERB_RE =
  /(^|[\s;|&])(tee|dd|cp|mv|chmod|chown|rm|truncate|ln|install)\b|>>?|\bsed\s+-i\b/i;

export interface EngineConfig {
  scope: ScopeValidator;
  audit: AuditLog;
  approvals?: ApprovalStore;
  /** Glob patterns for paths that require human approval even if scope-allowed. */
  askPaths?: string[];
  /** Command heads (e.g. "git push") that require human approval. */
  askCommands?: string[];
  /** Substrings identifying governor-core's own files. Any write/mutation that
   *  references one is denied outright (self-protection, non-overridable). */
  protectedPaths?: string[];
  shellTools?: string[];
  mutatingTools?: string[];
  readonlyTools?: string[];
  now?: () => string;
}

export class GovernanceEngine {
  private scope: ScopeValidator;
  private audit: AuditLog;
  private approvals?: ApprovalStore;
  private askPaths: string[];
  private askCommands: string[];
  private protectedPaths: string[];
  private shellTools: string[];
  private mutatingTools: string[];
  private readonlyTools: string[];
  private now: () => string;

  constructor(cfg: EngineConfig) {
    this.scope = cfg.scope;
    this.audit = cfg.audit;
    this.approvals = cfg.approvals;
    this.askPaths = cfg.askPaths ?? [];
    this.askCommands = cfg.askCommands ?? [];
    this.protectedPaths = cfg.protectedPaths ?? [];
    this.shellTools = cfg.shellTools ?? DEFAULT_SHELL_TOOLS;
    this.mutatingTools = cfg.mutatingTools ?? DEFAULT_MUTATING_TOOLS;
    this.readonlyTools = cfg.readonlyTools ?? DEFAULT_READONLY_TOOLS;
    this.now = cfg.now ?? (() => new Date().toISOString());
  }

  async evaluate(call: ToolCall): Promise<Verdict> {
    const verdict = await this.decide(call);
    // Audit is mandatory. If it fails, fail closed regardless of the decision.
    try {
      await this.audit.record("INTERCEPT", `${call.tool} -> ${verdict.decision}`, {
        reason: verdict.reason,
        ...(call.identity !== undefined ? { identity: call.identity } : {}),
      });
    } catch (err) {
      return {
        decision: "deny",
        reason: `audit write failed, failing closed: ${err instanceof Error ? err.message : String(err)}`,
        ruleId: "audit-fail-closed",
      };
    }
    return verdict;
  }

  private async decide(call: ToolCall): Promise<Verdict> {
    // 0. Self-protection — inviolable, checked before any approval token.
    if (this.isSelfTamper(call)) {
      return {
        decision: "deny",
        reason: "operation targets governor-core's own files (self-protection)",
        ruleId: "self-protect",
      };
    }

    // 1. Pre-approved one-time token for this exact operation.
    if (this.approvals && (await this.approvals.consume(call, this.now))) {
      return { decision: "allow", reason: "one-time approval token consumed", ruleId: "token" };
    }

    // 2. Shell command tools.
    if (this.shellTools.includes(call.tool)) {
      const cmd = call.command ?? "";
      if (!cmd.trim()) {
        return { decision: "deny", reason: "shell tool with empty command", ruleId: "empty-command" };
      }
      if (!this.scope.validateCommand(cmd)) {
        return { decision: "deny", reason: `command out of scope: ${cmd}`, ruleId: "scope-command" };
      }
      if (this.scope.isMassDelete(cmd)) {
        return { decision: "deny", reason: `mass-deletion command blocked: ${cmd}`, ruleId: "mass-delete" };
      }
      if (this.scope.commandTargetsDeniedPath(cmd)) {
        return { decision: "deny", reason: `command writes to a path out of scope: ${cmd}`, ruleId: "path-in-command" };
      }
      if (this.scope.usesElevatedCommand(cmd)) {
        return this.ask(
          call,
          `command invokes a general-purpose executor that can run arbitrary code: ${cmd}`,
          "ask-elevated",
        );
      }
      const askHit = this.askCommands.find((p) => globMatch(cmd, p) || cmd.includes(p));
      if (askHit) {
        return this.ask(call, `command requires approval (matched "${askHit}")`, "ask-command");
      }
      return { decision: "allow", reason: "command in scope", ruleId: "scope-command" };
    }

    // 3. File-mutating tools.
    if (this.mutatingTools.includes(call.tool)) {
      const file = call.file ?? "";
      if (!file.trim()) {
        return { decision: "deny", reason: "file tool with empty path", ruleId: "empty-path" };
      }
      if (!this.scope.validatePath(file)) {
        return { decision: "deny", reason: `path out of scope: ${file}`, ruleId: "scope-path" };
      }
      const askHit = this.askPaths.find((p) => globMatch(file, p));
      if (askHit) {
        return this.ask(call, `path requires approval (matched "${askHit}")`, "ask-path");
      }
      return { decision: "allow", reason: "path in scope", ruleId: "scope-path" };
    }

    // 4. Read-only tools: allowed but audited.
    if (this.readonlyTools.includes(call.tool)) {
      return { decision: "allow", reason: "read-only tool", ruleId: "readonly" };
    }

    // 5. Unknown / unclassifiable tool: fail closed.
    return { decision: "deny", reason: `unknown tool "${call.tool}", failing closed`, ruleId: "fail-closed" };
  }

  /** True if the call would create/modify/delete one of governor-core's own
   *  files. Applies to file tools (any write to a protected path) and shell
   *  tools (a mutation verb/redirect referencing a protected path). */
  private isSelfTamper(call: ToolCall): boolean {
    if (this.protectedPaths.length === 0) return false;
    const hay = `${call.file ?? ""} ${call.command ?? ""}`;
    const touches = this.protectedPaths.some((frag) => frag && hay.includes(frag));
    if (!touches) return false;
    if (this.mutatingTools.includes(call.tool)) return true;
    if (this.shellTools.includes(call.tool)) return MUTATION_VERB_RE.test(call.command ?? "");
    return false;
  }

  private async ask(call: ToolCall, reason: string, ruleId: string): Promise<Verdict> {
    let pendingId: string | undefined;
    if (this.approvals) {
      const req = await this.approvals.recordPending(call, reason, this.now);
      pendingId = req.id;
    }
    return { decision: "ask", reason, ruleId, ...(pendingId ? { pendingId } : {}) };
  }
}
