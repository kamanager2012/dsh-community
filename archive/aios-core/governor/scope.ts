// AIOS Core — Canonical scope validator.
//
// Scope is a deterministic policy semantic layer, not a security boundary.
// It validates paths/commands and exposes signals that vendor adapters may
// compile into native approval/sandbox policy. OS/vendor isolation remains the
// actual execution boundary.

import { posix as pathPosix } from "node:path";
import type { Plan } from "../kernel/schema/index.js";
import { normalizePolicy, type CanonicalPolicy } from "./policy.js";

export type ScopePolicy = CanonicalPolicy;

export const DEFAULT_POLICY: ScopePolicy = {
  // Hardened after the canonical-v1 105-case qualification. This profile only
  // closes measured false-allows; project-relative host/path semantics remain
  // unchanged so the historical false-deny set is not "fixed" for the score.
  allowedPaths: ["**/*"],
  deniedPaths: [".aios/**", "**/.env", "**/secrets/**", "/etc/**", "/usr/**", "/var/**"],
  allowedCommands: [
    "echo", "git", "node", "pnpm", "npm", "vitest", "tsc",
    "cat", "ls", "pwd", "head", "tail", "wc", "find", "grep",
    "sed", "awk", "mkdir", "cp", "mv", "diff", "patch",
    "python3", "cargo", "go", "make",
  ],
  deniedCommands: [
    "rm -rf /",
    "sudo",
    "shutdown",
    "reboot",
    "mkfs",
    "dd if=",
    "python3 -c",
    "git reset --hard",
    "git clean -fdx",
    "git clean -fd",
    "git clean -f",
    "git push --force",
    "git push -f",
    "git checkout -- .",
    "git restore -- .",
  ],
  deniedFileTypes: [".pem", ".key", ".p12", ".keystore", ".jks"],
  elevatedCommands: [],
};

// Backward-compatible legacy ACS protection. These paths are only applied when
// a legacy ACS scope source is explicitly supplied; canonical AIOS no longer
// makes Claude/ACS-specific paths part of vendor-neutral default policy.
export const ACS_DENIED_PATHS = [
  ".claude/audit/",
  ".claude/hooks/",
  ".claude/settings.json",
  ".claude/settings.local.json",
];

/** Minimal compatibility surface for older callers. Scope no longer imports or
 * instantiates the concrete AcsClient; any legacy bridge must opt in explicitly. */
export interface LegacyAcsScopeSource {
  isLocked(): boolean;
  getScope(): string[];
}

export interface ScopeValidatorDeps {
  /** @deprecated Canonical CLI no longer supplies ACS. Kept temporarily for API compatibility. */
  acs?: LegacyAcsScopeSource;
  policy?: ScopePolicy;
}

// Bulk deletion is a semantic signal separate from the ordinary allow-list.
// A vendor adapter can deny/escalate it even when a broad tool like `find` is
// otherwise allowed.
const MASS_DELETE_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*[rf][a-z]*\b/i,
  /\brm\b[^|;&]*(\*|~\/|\s\/(?:\s|$))/i,
  /\bfind\b[^|;&]*-delete\b/i,
  /\bfind\b[^|;&]*-exec\s+rm\b/i,
  /\bshred\b/i,
  /\btruncate\s+-s\s*0\b/i,
];

export class ScopeValidator {
  public readonly policy: ScopePolicy;
  private readonly acs: LegacyAcsScopeSource | null;

  constructor(deps?: ScopeValidatorDeps) {
    this.policy = normalizePolicy(deps?.policy ?? DEFAULT_POLICY);
    this.acs = deps?.acs ?? null;
  }

  // ── Legacy ACS compatibility (not canonical default) ──────────────────

  isAcsLocked(): boolean {
    return this.acs?.isLocked() ?? false;
  }

  getAcsScope(): string[] {
    return this.acs?.getScope() ?? this.policy.allowedPaths;
  }

  validatePlanWithAcs(plan: Plan): { ok: boolean; reason?: string } {
    if (this.isAcsLocked()) return { ok: false, reason: "ACS is locked — all writes denied" };
    if (!this.validatePlan(plan)) return { ok: false, reason: "plan violates local scope policy" };
    if (!this.acs) return { ok: true };

    const acsScope = this.getAcsScope();
    for (const file of plan.files) {
      if (!acsScope.some((dir) => file.startsWith(dir))) {
        return { ok: false, reason: `ACS scope violation: ${file} not in ACS allowed directories` };
      }
      if (ACS_DENIED_PATHS.some((protectedPath) => file.includes(protectedPath))) {
        return { ok: false, reason: `ACS protected path: ${file}` };
      }
    }
    return { ok: true };
  }

  // ── Canonical path semantics ───────────────────────────────────────────

  validatePlan(plan: Plan): boolean {
    return plan.files.every((file) => this.validatePath(file) && this.validateFileType(file));
  }

  validatePath(path: string): boolean {
    // Canonical paths are project-relative across every supported host. Reject
    // host-specific absolute/drive/home forms before POSIX normalization so a
    // Windows path cannot be misread as a relative POSIX path on Linux/WSL.
    const raw = path.trim().replace(/\\/g, "/");
    if (!raw || raw.includes("\0")) return false;
    if (raw === "." || raw === "~" || raw.startsWith("~/")) return false;
    if (/^[A-Za-z]:/.test(raw)) return false; // Windows drive absolute/relative forms.
    if (raw.startsWith("//")) return false;   // UNC/network/device paths.

    const normalized = pathPosix.normalize(raw);
    if (
      normalized === "." ||
      pathPosix.isAbsolute(normalized) ||
      normalized === ".." ||
      normalized.startsWith("../")
    ) {
      return false;
    }
    if (this.matchesAny(normalized, this.policy.deniedPaths)) return false;
    if (this.policy.allowedPaths.length === 0) return false;
    return this.matchesAny(normalized, this.policy.allowedPaths);
  }

  validateFileType(path: string): boolean {
    const lower = path.toLowerCase();
    return !this.policy.deniedFileTypes.some((ext) => lower.endsWith(ext.toLowerCase()));
  }

  // ── Canonical command semantics ────────────────────────────────────────

  validateCommand(command: string): boolean {
    const subcommands = this.splitSubcommands(expandAssignments(command));
    if (subcommands.length === 0 || this.policy.allowedCommands.length === 0) return false;

    for (const raw of subcommands) {
      const subcommand = stripAssignments(raw.trim());
      // Bare environment assignments execute no command.
      if (!subcommand) continue;
      if (this.matchesDenyCommand(subcommand)) return false;
      const head = subcommand.split(/\s+/)[0] ?? "";
      if (!this.matchesAny(head, this.policy.allowedCommands)) return false;
    }
    return true;
  }

  isMassDelete(command: string): boolean {
    const cleaned = stripQuoted(expandAssignments(command));
    return MASS_DELETE_PATTERNS.some((pattern) => pattern.test(cleaned));
  }

  /** True when an otherwise-valid command uses an interpreter/build tool that
   * a vendor adapter may want to translate into an approval requirement. */
  usesElevatedCommand(command: string): boolean {
    const elevated = this.policy.elevatedCommands ?? [];
    if (elevated.length === 0) return false;
    for (const raw of this.splitSubcommands(expandAssignments(command))) {
      const subcommand = stripAssignments(raw.trim());
      if (!subcommand) continue;
      const head = subcommand.split(/\s+/)[0] ?? "";
      if (elevated.some((pattern) => head === pattern || globMatch(head, pattern))) return true;
    }
    return false;
  }

  /** Apply the same project-relative path policy to paths targeted by shell
   * writes. This is evidence/adapter semantics, not a shell sandbox. */
  commandTargetsDeniedPath(command: string): boolean {
    return extractWriteTargets(expandAssignments(command)).some(
      (target) => target.startsWith("~") || !this.validatePath(target),
    );
  }

  private splitSubcommands(command: string): string[] {
    const out: string[] = [];
    // Pull executable command substitutions out before stripping quoted literals.
    const substitution = /\$\(([^()]*)\)|`([^`]*)`/g;
    let match: RegExpExecArray | null;
    while ((match = substitution.exec(command)) !== null) {
      const body = match[1] ?? match[2] ?? "";
      if (body.trim()) out.push(...this.splitSubcommands(body));
    }

    const rest = stripQuoted(command.replace(substitution, " "));
    for (const part of rest.split(/\s*(?:&&|\|\||[;|&\n])\s*/)) {
      if (part.trim()) out.push(part);
    }
    return out;
  }

  private matchesDenyCommand(subcommand: string): boolean {
    const normalizedSubcommand = subcommand.replace(/\s+/g, " ").trim();
    const words = normalizedSubcommand.split(" ");
    return this.policy.deniedCommands.some((pattern) => {
      const normalizedPattern = pattern.replace(/\s+/g, " ").trim();
      if (normalizedPattern.includes(" ")) {
        return commandPhraseMatches(normalizedSubcommand, normalizedPattern);
      }
      if (/[^\w-]/.test(normalizedPattern)) {
        return normalizedSubcommand.includes(normalizedPattern);
      }
      return words.includes(normalizedPattern) || globMatch(words[0] ?? "", normalizedPattern);
    });
  }

  private matchesAny(value: string, patterns: string[]): boolean {
    return patterns.some((pattern) => globMatch(value, pattern));
  }
}

/** Match a multi-token deny phrase on command-token boundaries. The old raw
 * substring rule made `git push --force` also match `--force-with-lease`.
 * Prefix-style assignment patterns such as `dd if=` intentionally keep their
 * substring semantics because the value follows the `=` in the same token. */
export function commandPhraseMatches(command: string, phrase: string): boolean {
  if (phrase.endsWith("=")) return command.includes(phrase);

  let from = 0;
  while (from <= command.length - phrase.length) {
    const index = command.indexOf(phrase, from);
    if (index < 0) return false;
    const end = index + phrase.length;
    const beforeOk = index === 0 || /\s/.test(command[index - 1]!);
    const afterOk = end === command.length || /\s/.test(command[end]!);
    if (beforeOk && afterOk) return true;
    from = index + 1;
  }
  return false;
}

/** Remove quoted literal bodies. Live command substitutions are extracted before
 * this helper is applied, so quoted text does not create false positives. */
export function stripQuoted(value: string): string {
  return value
    .replace(/'[^']*'/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/'[^']*$/g, " ")
    .replace(/"[^"]*$/g, " ");
}

/** Conservative de-obfuscation of simple shell variable assignments. */
export function expandAssignments(command: string): string {
  let expanded = command;
  for (let pass = 0; pass < 3; pass++) {
    const variables = new Map<string, string>();
    const assignment = /(?:^|[\s;|&(])([A-Za-z_][A-Za-z0-9_]*)=([^\s;|&"'`)]+)/g;
    let match: RegExpExecArray | null;
    while ((match = assignment.exec(expanded)) !== null) {
      variables.set(match[1]!, match[2]!);
    }
    if (variables.size === 0) break;

    let next = expanded;
    for (const [name, value] of variables) {
      next = next.replace(new RegExp("\\$\\{" + name + "\\}", "g"), () => value);
      next = next.replace(new RegExp("\\$" + name + "(?![A-Za-z0-9_])", "g"), () => value);
    }
    if (next === expanded) break;
    expanded = next;
  }
  return expanded;
}

export function stripAssignments(subcommand: string): string {
  return subcommand
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*(?:\s+|$))+/, "")
    .trim();
}

/** Extract conservative shell write targets for policy evaluation. */
export function extractWriteTargets(command: string): string[] {
  const targets: string[] = [];
  const unquote = (value: string): string => value.replace(/^['"]|['"]$/g, "");

  const redirection = /(?:&>|[0-9]*&?>>?)\s*(['"]?[^\s;|&<>]+['"]?)/g;
  let match: RegExpExecArray | null;
  while ((match = redirection.exec(command)) !== null) targets.push(unquote(match[1]!));

  const ddOutput = /\bof=(['"]?[^\s;|&]+['"]?)/g;
  while ((match = ddOutput.exec(command)) !== null) targets.push(unquote(match[1]!));

  for (const rawSubcommand of command.split(/\s*(?:&&|\|\||[;|&\n])\s*/)) {
    const subcommand = stripAssignments(rawSubcommand.trim());
    if (!subcommand) continue;
    const cleaned = subcommand.replace(/(?:&>|[0-9]*&?>>?)\s*[^\s;|&<>]+/g, " ");
    const args = cleaned.trim().split(/\s+/).map(unquote).filter(Boolean);
    if (args.length === 0) continue;

    const head = args[0]!;
    const rest = args.slice(1);
    const nonOptions = rest.filter((arg) => !arg.startsWith("-"));
    if (head === "tee") {
      targets.push(...nonOptions);
    } else if (head === "sed") {
      if (rest.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place")) {
        targets.push(...nonOptions.slice(1));
      }
    } else if (head === "cp" || head === "mv" || head === "ln" || head === "install") {
      if (nonOptions.length >= 1) targets.push(nonOptions[nonOptions.length - 1]!);
    } else if (head === "truncate") {
      targets.push(...nonOptions.filter((arg) => !/^\d/.test(arg)));
    }
  }
  return targets;
}

/** Case-insensitive glob matcher: `**` crosses path separators; `*` does not. */
export function globMatch(value: string, pattern: string): boolean {
  if (pattern === "**" || pattern === "**/*") return true;
  let regex = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        regex += "(?:.*\\/)?";
        index += 3;
      } else {
        regex += ".*";
        index += 2;
      }
    } else if (char === "*") {
      regex += "[^\\/]*";
      index += 1;
    } else if (".+^${}()|[]\\".includes(char)) {
      regex += "\\" + char;
      index += 1;
    } else {
      regex += char;
      index += 1;
    }
  }
  return new RegExp("^" + regex + "$", "i").test(value);
}
