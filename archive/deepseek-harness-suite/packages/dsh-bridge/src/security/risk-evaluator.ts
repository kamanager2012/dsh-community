import type { RiskLevel } from '../types/index.js';
import { DshIgnoreMatcher } from './dsh-ignore.js';

export type ToolCapability =
  | 'fs:read'
  | 'fs:write'
  | 'fs:delete'
  | 'process:exec'
  | 'process:kill'
  | 'net:read'
  | 'net:write'
  | 'credential:read'
  | 'git:write'
  | 'system:mutate';

export interface ToolDescriptor {
  name: string;
  description?: string;
  capabilities?: ToolCapability[];
  scope?: 'workspace' | 'system' | 'network';
  sideEffect?: 'read_only' | 'reversible' | 'irreversible';
}

export interface ToolRiskEvaluation {
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  capabilities: ToolCapability[];
  reason: string;
}

const CRITICAL_COMMAND_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive\s+--force|--force\s+--recursive)\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(shutdown|reboot|poweroff|init\s+0)\b/i,
  /\bchmod\s+(-R\s+)?777\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-zA-Z]*f/i,
  /\bgit\s+push\s+.*(--force|-f)\b/i,
  /\b(drop\s+database|drop\s+table)\b/i,
  /:\(\)\{\s*:\s*\|\s*:\s*&\s*\};\s*:/, // Fork bomb
  /\bcurl\s+.*\|\s*(sh|bash)\b/i,       // Remote script execution pipe
  /\bwget\s+.*\|\s*(sh|bash)\b/i,
];

const KNOWN_SAFE_READ_TOOLS: Record<string, ToolCapability[]> = {
  'read_file': ['fs:read'],
  'view_file': ['fs:read'],
  'list_dir': ['fs:read'],
  'grep_search': ['fs:read'],
  'search_web': ['net:read'],
  'read_url_content': ['net:read'],
  'get_health': ['fs:read'],
  'list_sessions': ['fs:read'],
  'contract_checker': ['process:exec'],
};

// Disallowed tokens in any auto-approved single shell command
const SHELL_COMPOUND_METACHARS = /[;&|`$><\n\r()]/;

const SAFE_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'remote',
  'tag',
  'describe',
]);

/**
 * Capability-Driven Tool Risk & Policy Evaluator
 * 
 * Enforces strict capability semantics:
 * - Prefers explicit ToolDescriptor capability declarations over heuristic inference.
 * - **Fail-Closed on Unknown**: Any unrecognized or unclassified tool defaults to high-risk and requires approval.
 * - **Fail-Closed on Shell Commands**: Rejects startsWith matching; strictly disallows compound operators (&&, ;, |, >, <, $())
 *   and limits auto-safe approval strictly to verified single-command read-only binaries.
 * - Enforces credential and sensitive path protection (.dshignore).
 */
export class DshRiskEvaluator {
  /**
   * Determine if a shell command is strictly a single, non-mutating, non-redirected read-only command
   */
  public static isStrictReadOnlyShellCommand(commandStr: string): boolean {
    const trimmed = (commandStr || '').trim();
    if (!trimmed) return false;

    // 1. Fail immediately on any compound operator, pipe, redirection, subshell or substitution
    if (SHELL_COMPOUND_METACHARS.test(trimmed)) {
      return false;
    }

    const tokens = trimmed.split(/\s+/);
    const binary = tokens[0].toLowerCase();

    // 2. Safe single utilities without arguments or with safe arguments
    if (binary === 'pwd' || binary === 'whoami' || binary === 'which') {
      return true;
    }

    if (binary === 'ls') {
      return true;
    }

    if (binary === 'cat' || binary === 'head' || binary === 'tail') {
      // Must not target sensitive files (checked by caller)
      return true;
    }

    if (binary === 'node' && tokens[1] === '-v') return true;
    if (binary === 'npm' && tokens[1] === '-v') return true;
    if (binary === 'pnpm' && tokens[1] === '-v') return true;
    if (binary === 'tsc' && tokens[1] === '--noEmit') return true;
    // NOTE: test runners (vitest/jest/node <file>) are intentionally NOT on this
    // list: executing a test file runs arbitrary code inside it (config and
    // setupFiles can delete files, mutate the workspace, or exfiltrate env),
    // so such commands fall through to the default approval-required path.

    // 3. Git read-only subcommands
    if (binary === 'git' && tokens[1]) {
      const subcommand = tokens[1].toLowerCase();
      if (SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
        // Ensure no mutating flags like -f or --force in git diff/branch
        const hasForce = tokens.some(t => t === '-f' || t === '--force' || t === '-D');
        return !hasForce;
      }
    }

    return false;
  }

  /**
   * Infer capabilities from tool descriptor or heuristic argument inspection
   */
  public static inferCapabilities(
    tool: string | ToolDescriptor,
    args: Record<string, unknown> = {}
  ): ToolCapability[] {
    // 1. If explicit ToolDescriptor is provided with declared capabilities, use it
    if (typeof tool === 'object' && tool.capabilities && tool.capabilities.length > 0) {
      return [...tool.capabilities];
    }

    const name = typeof tool === 'object' ? tool.name : tool;
    const normalized = (name || '').toLowerCase().trim();

    // 2. Check known explicit tool map
    if (KNOWN_SAFE_READ_TOOLS[normalized]) {
      return [...KNOWN_SAFE_READ_TOOLS[normalized]];
    }

    const caps = new Set<ToolCapability>();

    // 3. Destructive keyword check
    if (
      normalized.includes('delete') ||
      normalized.includes('remove') ||
      normalized.includes('unlink') ||
      normalized.includes('destroy') ||
      normalized.includes('drop') ||
      normalized.includes('erase') ||
      normalized.includes('purge')
    ) {
      caps.add('fs:delete');
      caps.add('system:mutate');
    }

    // 4. Credential exposure check
    if (
      normalized.includes('password') ||
      normalized.includes('secret') ||
      normalized.includes('credential') ||
      normalized.includes('token') ||
      normalized.includes('key')
    ) {
      caps.add('credential:read');
    }

    // 5. Process execution check
    if (
      normalized.includes('bash') ||
      normalized.includes('exec') ||
      normalized.includes('shell') ||
      normalized.includes('terminal') ||
      normalized.includes('command') ||
      normalized.includes('spawn') ||
      normalized.includes('run')
    ) {
      caps.add('process:exec');
    }

    // 6. Process termination
    if (normalized.includes('kill') || normalized.includes('terminate') || normalized.includes('abort')) {
      caps.add('process:kill');
    }

    // 7. File writing / replacing
    if (
      normalized.includes('write') ||
      normalized.includes('replace') ||
      normalized.includes('edit') ||
      normalized.includes('modify') ||
      normalized.includes('append')
    ) {
      caps.add('fs:write');
    }

    // 8. Network operations
    if (normalized.includes('fetch') || normalized.includes('http') || normalized.includes('download') || normalized.includes('curl')) {
      caps.add('net:read');
    }

    // FAIL-CLOSED: If no known capabilities matched, mark as system:mutate (do not default to fs:read)
    if (caps.size === 0) {
      caps.add('system:mutate');
    }

    return Array.from(caps);
  }

  /**
   * Scan a raw shell command string token-by-token for protected credential files.
   * Structured args.path checks do not cover shell arguments (e.g. `cat ~/.ssh/id_rsa`),
   * so every whitespace-separated token is matched against the sensitive-credential rules.
   */
  private static findSensitiveCredentialToken(commandStr: string): string | null {
    const matcher = new DshIgnoreMatcher();
    for (const rawToken of commandStr.split(/\s+/)) {
      const token = rawToken.replace(/^['"]|['"]$/g, '');
      if (!token || token.startsWith('-')) continue;
      if (matcher.isSensitiveCredential(token)) {
        return token;
      }
    }
    return null;
  }

  /**
   * Evaluate risk level and approval requirement based on capability semantics
   */
  public static evaluate(
    tool: string | ToolDescriptor,
    args: Record<string, unknown> = {},
    explicitRequiresApproval?: boolean,
    policy: 'auto_safe' | 'strict' | 'unrestricted' = 'auto_safe'
  ): ToolRiskEvaluation {
    const capabilities = this.inferCapabilities(tool, args);
    const toolName = typeof tool === 'object' ? tool.name : tool;

    // 1. Sensitive file and credential protection check — no approval policy may bypass this guard
    const targetFile = String(args.path || args.targetFile || args.filePath || args.file_path || args.TargetFile || '');
    if (targetFile) {
      const matcher = new DshIgnoreMatcher();
      if (matcher.isIgnored(targetFile)) {
        return {
          riskLevel: 'critical',
          requiresApproval: true,
          capabilities: [...capabilities, 'credential:read'],
          reason: `Protected sensitive path detected (.dshignore): "${targetFile}"`,
        };
      }
    }

    // 2. Destructive command pattern & credential-argument inspection — no approval policy may bypass these guards
    const commandStr = String(args.command || args.cmd || args.script || args.CommandLine || '');
    if (commandStr) {
      for (const pattern of CRITICAL_COMMAND_PATTERNS) {
        if (pattern.test(commandStr)) {
          return {
            riskLevel: 'critical',
            requiresApproval: true,
            capabilities: [...capabilities, 'system:mutate'],
            reason: `Destructive command pattern detected: ${pattern.source}`,
          };
        }
      }

      const sensitiveToken = this.findSensitiveCredentialToken(commandStr);
      if (sensitiveToken) {
        return {
          riskLevel: 'critical',
          requiresApproval: true,
          capabilities: [...capabilities, 'credential:read'],
          reason: `Shell command references protected credentials (.dshignore): "${sensitiveToken}"`,
        };
      }
    }

    // 3. Policy overrides — only reachable once the non-bypassable guards above have passed
    if (policy === 'unrestricted') {
      return {
        riskLevel: 'low',
        requiresApproval: false,
        capabilities,
        reason: 'Auto-approved by unrestricted policy (critical & credential guards passed)',
      };
    }

    if (policy === 'strict') {
      return {
        riskLevel: 'high',
        requiresApproval: true,
        capabilities,
        reason: 'Human approval required by strict policy',
      };
    }

    // 4. Process execution & strict shell inspection
    if (commandStr) {

      // Check if command is strictly a safe, non-compound read-only shell command
      const isStrictSafe = this.isStrictReadOnlyShellCommand(commandStr);
      if (isStrictSafe) {
        return {
          riskLevel: 'low',
          requiresApproval: false,
          capabilities: ['fs:read'],
          reason: `Strict read-only inspection command verified: "${commandStr.trim().slice(0, 35)}"`,
        };
      }

      // Any compound command (&&, ;, |, >), unlisted binary, or modifying CLI command requires approval
      return {
        riskLevel: 'high',
        requiresApproval: true,
        capabilities: ['process:exec'],
        reason: `Compound or unverified shell command requires human approval: "${commandStr.trim().slice(0, 35)}"`,
      };
    }

    // 5. Capability-driven risk classification
    if (capabilities.includes('credential:read') || capabilities.includes('system:mutate')) {
      const isUnrecognized = capabilities.length === 1 && capabilities[0] === 'system:mutate';
      return {
        riskLevel: isUnrecognized ? 'high' : 'critical',
        requiresApproval: true,
        capabilities,
        reason: isUnrecognized
          ? `Unrecognized tool "${toolName}" failed closed to protect workspace`
          : `High-privilege capability requested: ${capabilities.join(', ')}`,
      };
    }

    if (capabilities.includes('process:exec') || capabilities.includes('fs:delete') || capabilities.includes('process:kill')) {
      return {
        riskLevel: 'high',
        requiresApproval: true,
        capabilities,
        reason: `Privileged/destructive capability requested: ${capabilities.join(', ')}`,
      };
    }

    if (capabilities.includes('fs:write') || capabilities.includes('git:write')) {
      return {
        riskLevel: 'medium',
        requiresApproval: Boolean(explicitRequiresApproval),
        capabilities,
        reason: `State-modifying write capability: ${capabilities.join(', ')}`,
      };
    }

    // Pure read-only tools
    return {
      riskLevel: 'low',
      requiresApproval: Boolean(explicitRequiresApproval),
      capabilities,
      reason: `Safe inspection capability: ${capabilities.join(', ')}`,
    };
  }
}
