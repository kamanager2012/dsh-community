// governor-core — Scope: path allow/deny + command allow/deny.
//
// Hardened relative to AIOS 9.0:
//   - validateCommand splits a command line into subcommands (; && || | &, and
//     $()/backtick bodies) so multi-word deny patterns actually match and
//     command-chain bypasses (`git; rm -rf /`) are caught.
//   - Quoted string literals are stripped before matching so a literal argument
//     (`echo "rm -rf /"`) is not misread as executing rm, while live command
//     substitution (`echo $(rm -rf /)`) is still extracted and validated.
//   - Simple variable assignments are expanded before matching so indirection
//     bypasses (`X=rm; $X -rf /`) resolve to the real command and get caught.
//   - Leading assignment prefixes (`FOO=bar cmd`) are stripped so the true
//     command head is allow-listed, and a bare assignment (`X=rm`) is benign.
//   - isMassDelete flags bulk-deletion semantics (rm -rf with wildcard/home/root,
//     find -delete / -exec rm, shred) that the allow-list alone would miss.
//   - validatePath normalizes and rejects absolute paths and ../ traversal.
//   - glob matching is case-insensitive so deny patterns catch case variants.

import type { Plan } from "./types.js";
import { posix as pathPosix } from "node:path";

export interface ScopePolicy {
  allowedPaths: string[];
  deniedPaths: string[];
  allowedCommands: string[];
  deniedCommands: string[];
  /** Allow-listed but general-purpose executors (interpreters, build tools) whose
   *  presence in a command means "arbitrary code can run." These are scope-valid
   *  but escalated to `ask` by the engine, because allowing `node`/`make`/`npm`
   *  outright is equivalent to allowing arbitrary execution. Optional; empty or
   *  absent means no escalation. */
  elevatedCommands?: string[];
}

export const DEFAULT_POLICY: ScopePolicy = {
  allowedPaths: ["**/*"],
  deniedPaths: [".aigov/**", "**/.env", "**/secrets/**"],
  allowedCommands: ["echo", "git", "node", "pnpm", "vitest", "tsc"],
  deniedCommands: [
    "rm -rf /",
    "rm",
    "sudo",
    "shutdown",
    "reboot",
    "mkfs",
    "dd if=",
    "curl",
    "wget",
    "eval",
    "exec",
    "source",
    "chmod 777",
    "git push --force",
    "git reset --hard",
    "history -c",
    "unset HISTFILE",
    "truncate -s 0",
    "node -e",
    "node --eval",
    "node -p",
    "node --print",
    "python -c",
    "python3 -c",
    "perl -e",
    "ruby -e",
    "php -r",
    ":(){:|:&};:",
  ],
  elevatedCommands: [],
};

// Bulk-deletion patterns matched against the (quote-stripped) command. These
// catch destructive semantics that survive the allow-list — e.g. `find` is an
// allowed command, but `find . -delete` still wipes a tree.
const MASS_DELETE_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*[rf][a-z]*\b/i, // any recursive/force rm
  /\brm\b[^|;&]*(\*|~\/|\s\/(?:\s|$))/i, // rm with wildcard / home / root
  /\bfind\b[^|;&]*-delete\b/i,
  /\bfind\b[^|;&]*-exec\s+rm\b/i,
  /\bshred\b/i,
  /\btruncate\s+-s\s*0\b/i,
];

export class ScopeValidator {
  constructor(public readonly policy: ScopePolicy = DEFAULT_POLICY) {}

  validatePlan(plan: Plan): boolean {
    return plan.files.every((f) => this.validatePath(f));
  }

  validatePath(path: string): boolean {
    const norm = pathPosix.normalize(path.replace(/\\/g, "/"));
    // Reject absolute paths and anything escaping the project root. Scope only
    // permits relative paths that stay inside the tree — this kills ../ traversal,
    // absolute targets like /etc/passwd, and symlink-style escapes at the name level.
    if (pathPosix.isAbsolute(norm) || norm === ".." || norm.startsWith("../")) return false;
    if (this.matchesAny(norm, this.policy.deniedPaths)) return false;
    if (this.policy.allowedPaths.length === 0) return false;
    return this.matchesAny(norm, this.policy.allowedPaths);
  }

  /** True if the command has bulk-deletion semantics, regardless of allow-list. */
  isMassDelete(cmd: string): boolean {
    const cleaned = stripQuoted(expandAssignments(cmd));
    return MASS_DELETE_PATTERNS.some((re) => re.test(cleaned));
  }

  /** True if a shell command writes to a path the path-policy forbids: absolute
   *  targets (/etc/passwd), home-relative targets (~/.ssh/...), ../ traversal, or
   *  anything under deniedPaths. In-tree relative targets stay allowed, so file
   *  redirection is only blocked when it would escape the governed tree — the same
   *  guarantee file-mutating tools already get via validatePath. */
  commandTargetsDeniedPath(cmd: string): boolean {
    return extractWriteTargets(expandAssignments(cmd)).some(
      (t) => t.startsWith("~") || !this.validatePath(t),
    );
  }

  validateCommand(cmd: string): boolean {
    const subs = this.splitSubcommands(expandAssignments(cmd));
    if (subs.length === 0) return false;
    if (this.policy.allowedCommands.length === 0) return false;
    for (const sub of subs) {
      const s = stripAssignments(sub.trim());
      // A subcommand that is nothing but variable assignments executes nothing.
      if (!s) continue;
      // Deny wins, matched against the whole subcommand so multi-word patterns
      // ("rm -rf /", "dd if=") and phrases actually match.
      if (this.matchesDenyCommand(s)) return false;
      const head = s.split(/\s+/)[0] ?? "";
      if (!this.matchesAny(head, this.policy.allowedCommands)) return false;
    }
    return true;
  }

  /** True if any subcommand invokes a general-purpose executor listed in
   *  elevatedCommands. Uses the same de-obfuscation as validateCommand so that
   *  indirection (`X=node; $X evil.js`) is also caught. The engine escalates a
   *  match to `ask` — allowing an interpreter/build tool is arbitrary execution. */
  usesElevatedCommand(cmd: string): boolean {
    const elevated = this.policy.elevatedCommands ?? [];
    if (elevated.length === 0) return false;
    for (const sub of this.splitSubcommands(expandAssignments(cmd))) {
      const s = stripAssignments(sub.trim());
      if (!s) continue;
      const head = s.split(/\s+/)[0] ?? "";
      if (elevated.some((p) => head === p || this.matchGlob(head, p))) return true;
    }
    return false;
  }

  /** Break a command line into individual commands: pull out command-substitution
   *  bodies (which execute regardless of surrounding quotes), strip quoted string
   *  literals (which do not execute), then split on shell operators. Not a full
   *  shell parser — a conservative safety splitter. */
  private splitSubcommands(cmd: string): string[] {
    const out: string[] = [];
    // 1. Extract $(...) and `...` bodies, recursing one level. These run even
    //    inside double quotes, so pull them before stripping quotes.
    const subst = /\$\(([^()]*)\)|`([^`]*)`/g;
    let m: RegExpExecArray | null;
    while ((m = subst.exec(cmd)) !== null) {
      const body = m[1] ?? m[2] ?? "";
      if (body.trim()) out.push(...this.splitSubcommands(body));
    }
    // 2. Replace substitutions with a space, then remove quoted literals so a
    //    literal like echo "rm -rf /" is not treated as a command.
    const rest = stripQuoted(cmd.replace(subst, " "));
    // 3. Split the remainder on shell operators.
    for (const part of rest.split(/\s*(?:&&|\|\||[;|&\n])\s*/)) {
      if (part.trim()) out.push(part);
    }
    return out;
  }

  /** True if a subcommand hits the deny list. Multi-word deny patterns are matched
   *  as whitespace-normalized substrings; single tokens match the head or any word. */
  private matchesDenyCommand(sub: string): boolean {
    const normSub = sub.replace(/\s+/g, " ").trim();
    const words = normSub.split(" ");
    return this.policy.deniedCommands.some((p) => {
      const normP = p.replace(/\s+/g, " ").trim();
      if (normP.includes(" ") || /[^\w-]/.test(normP)) return normSub.includes(normP);
      return words.includes(normP) || this.matchGlob(words[0] ?? "", normP);
    });
  }

  private matchesAny(value: string, patterns: string[]): boolean {
    return patterns.some((p) => globMatch(value, p));
  }

  private matchGlob(value: string, pattern: string): boolean {
    return globMatch(value, pattern);
  }
}

/** Remove single- and double-quoted string bodies, leaving the surrounding
 *  structure (operators, unquoted words) intact. Unbalanced quotes: the trailing
 *  open quote and everything after it is dropped, which is the safe choice. */
export function stripQuoted(s: string): string {
  return s
    .replace(/'[^']*'/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/'[^']*$/g, " ")
    .replace(/"[^"]*$/g, " ");
}

/** Expand simple unquoted variable assignments so indirection can't hide a
 *  denied command. `X=rm; $X -rf /` becomes `X=rm; rm -rf /`. Only plain
 *  token values are expanded; bounded passes resolve short chains. Not a shell
 *  — a conservative de-obfuscation pass. */
export function expandAssignments(cmd: string): string {
  let expanded = cmd;
  for (let pass = 0; pass < 3; pass++) {
    const map = new Map<string, string>();
    const assign = /(?:^|[\s;|&(])([A-Za-z_][A-Za-z0-9_]*)=([^\s;|&"'`)]+)/g;
    let m: RegExpExecArray | null;
    while ((m = assign.exec(expanded)) !== null) map.set(m[1]!, m[2]!);
    if (map.size === 0) break;
    let next = expanded;
    for (const [k, v] of map) {
      next = next.replace(new RegExp("\\$\\{" + k + "\\}", "g"), () => v);
      next = next.replace(new RegExp("\\$" + k + "(?![A-Za-z0-9_])", "g"), () => v);
    }
    if (next === expanded) break;
    expanded = next;
  }
  return expanded;
}

/** Strip leading `NAME=VALUE` assignment prefixes from a subcommand so the real
 *  command head is what gets allow-listed. A subcommand that is only
 *  assignments (`X=rm`) reduces to "" and is treated as executing nothing. */
export function stripAssignments(sub: string): string {
  return sub
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*(?:\s+|$))+/, "")
    .trim();
}

/** Extract the file paths a shell command would write to. Covers redirections
 *  (`>`, `>>`, `&>`, `2>`), `dd of=`, `tee` args, `sed -i` file args, and the
 *  destination of `cp`/`mv`/`ln`/`install`/`truncate`. Not a full shell parser —
 *  a conservative extractor whose false positives only ever tighten the policy. */
export function extractWriteTargets(cmd: string): string[] {
  const targets: string[] = [];
  const unquote = (t: string): string => t.replace(/^['"]|['"]$/g, "");

  // Redirection targets: optional fd/&, one or two >, then the destination token.
  // `2>&1` yields no target because the destination (`&1`) is excluded below.
  const redir = /(?:&>|[0-9]*&?>>?)\s*(['"]?[^\s;|&<>]+['"]?)/g;
  let m: RegExpExecArray | null;
  while ((m = redir.exec(cmd)) !== null) targets.push(unquote(m[1]!));

  // dd of=FILE
  const dd = /\bof=(['"]?[^\s;|&]+['"]?)/g;
  while ((m = dd.exec(cmd)) !== null) targets.push(unquote(m[1]!));

  // Command-specific destination args, per subcommand.
  for (const rawSub of cmd.split(/\s*(?:&&|\|\||[;|&\n])\s*/)) {
    const sub = stripAssignments(rawSub.trim());
    if (!sub) continue;
    // Drop redirections (already handled) so their targets aren't re-read as args.
    const cleaned = sub.replace(/(?:&>|[0-9]*&?>>?)\s*[^\s;|&<>]+/g, " ");
    const args = cleaned.trim().split(/\s+/).map(unquote).filter(Boolean);
    if (args.length === 0) continue;
    const head = args[0]!;
    const rest = args.slice(1);
    const nonOpt = rest.filter((a) => !a.startsWith("-"));
    if (head === "tee") {
      targets.push(...nonOpt);
    } else if (head === "sed") {
      // Only in-place edits write; the first non-option arg is the script, the
      // remainder are files.
      if (rest.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place")) {
        targets.push(...nonOpt.slice(1));
      }
    } else if (head === "cp" || head === "mv" || head === "ln" || head === "install") {
      if (nonOpt.length >= 1) targets.push(nonOpt[nonOpt.length - 1]!);
    } else if (head === "truncate") {
      targets.push(...nonOpt.filter((a) => !/^\d/.test(a)));
    }
  }
  return targets;
}

// Glob: ** = any path segments (including none), * = any non-slash chars.
// Converts to regex internally; not for untrusted input.
// Case-insensitive so deny patterns (**/.env) also catch case variants (.ENV)
// on case-insensitive filesystems.
export function globMatch(value: string, pattern: string): boolean {
  if (pattern === "**" || pattern === "**/*") return true;
  let regexStr = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        regexStr += "(?:.*\\/)?";
        i += 3;
      } else {
        regexStr += ".*";
        i += 2;
      }
    } else if (c === "*") {
      regexStr += "[^\\/]*";
      i += 1;
    } else if (".+^${}()|[]\\".includes(c)) {
      regexStr += "\\" + c;
      i += 1;
    } else {
      regexStr += c;
      i += 1;
    }
  }
  return new RegExp("^" + regexStr + "$", "i").test(value);
}
