import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_IGNORED_PATTERNS = [
  '.git',
  '.git/**',
  'node_modules',
  'node_modules/**',
  'dist',
  'dist/**',
  'build',
  'build/**',
  '.dsh',
  '.dsh/**',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.pfx',
  'id_rsa',
  'id_ed25519',
  '.DS_Store',
  'Thumbs.db',
];

/**
 * DSH Ignore & Sensitive Path Defense Engine
 *
 * Prevents AI tools from inadvertently reading, modifying, or deleting
 * private credentials (.env, keys) or scanning giant trees (node_modules, .git).
 *
 * Custom `.dshignore` / `.gitignore` entries are matched literally (exact
 * name/path equality). Glob wildcards, trailing-slash directory rules, and
 * `!` negations from ignore files are NOT interpreted; each such line warns
 * once on stderr so mismatches are never silent. Built-in sensitive rules
 * (.env variants, *.pem, *.key, id_rsa, id_ed25519) compare case-insensitively.
 */
export class DshIgnoreMatcher {
  private patterns: Set<string>;
  private workspacePath: string;

  constructor(workspacePath: string = process.cwd()) {
    this.workspacePath = workspacePath;
    this.patterns = new Set(DEFAULT_IGNORED_PATTERNS);
    this.loadCustomIgnoreFiles();
  }

  /**
   * Pattern shapes the literal matcher cannot honor (glob wildcard, negation,
   * directory-suffix semantics). Deduplicated per process so frequent matcher
   * construction does not spam stderr.
   */
  private static warnedPatterns = new Set<string>();

  private warnUnsupportedPatternSyntax(line: string, file: string): void {
    const unsupported =
      line.includes('*') || line.startsWith('!') || line.endsWith('/');
    if (!unsupported) return;

    const signature = `${file}:${line}`;
    if (DshIgnoreMatcher.warnedPatterns.has(signature)) return;
    DshIgnoreMatcher.warnedPatterns.add(signature);

    process.stderr.write(
      `[dsh-ignore] pattern "${line}" in ${file} uses unsupported syntax ` +
      `(wildcard/negation/directory suffix); it is matched literally and may not behave like git.\n`
    );
  }

  private loadCustomIgnoreFiles(): void {
    const ignoreFiles = ['.dshignore', '.gitignore'];
    for (const file of ignoreFiles) {
      const fullPath = path.join(this.workspacePath, file);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#'));
          for (const line of lines) {
            this.patterns.add(line);
            this.warnUnsupportedPatternSyntax(line, file);
          }
        } catch {
          // Ignore read errors
        }
      }
    }
  }

  /**
   * Check if a path refers to a well-known credential/secret file by basename
   * (.env variants, private keys, certificates such as id_rsa / *.pem / *.key).
   * Comparisons are case-insensitive so `.ENV`, `SERVER.PEM` or `ID_RSA`
   * cannot bypass the guard on case-preserving filesystems (macOS/Windows).
   *
   * Used both by isIgnored() and by the risk evaluator to scan raw shell command
   * arguments (which are not covered by structured args.path checks).
   */
  public isSensitiveCredential(targetPath: string): boolean {
    const baseName = path.basename(targetPath.replace(/\\/g, '/')).toLowerCase();

    return (
      baseName === '.env' ||
      baseName.startsWith('.env.') ||
      baseName.endsWith('.pem') ||
      baseName.endsWith('.key') ||
      baseName === 'id_rsa' ||
      baseName === 'id_ed25519'
    );
  }

  /**
   * Check if a relative or absolute file path is protected/ignored
   */
  public isIgnored(targetPath: string): boolean {
    const normalized = targetPath.replace(/\\/g, '/');
    const baseName = path.basename(normalized);

    // Check sensitive credential file exact names
    if (this.isSensitiveCredential(normalized)) {
      return true;
    }

    // Check directory containment
    const parts = normalized.split('/');
    if (parts.includes('node_modules') || parts.includes('.git') || parts.includes('.dsh')) {
      return true;
    }

    for (const pattern of this.patterns) {
      const cleanPattern = pattern.replace(/^\//, '').replace(/\/$/, '');
      if (normalized === cleanPattern || baseName === cleanPattern) {
        return true;
      }
      if (cleanPattern.endsWith('/**') && normalized.startsWith(cleanPattern.slice(0, -3))) {
        return true;
      }
    }

    return false;
  }

  public getPatterns(): string[] {
    return Array.from(this.patterns);
  }
}
