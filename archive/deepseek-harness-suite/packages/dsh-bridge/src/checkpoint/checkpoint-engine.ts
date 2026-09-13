import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export class SecurityBoundaryViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityBoundaryViolationError';
  }
}

export interface FileSnapshot {
  filePath: string;
  relativePath: string;
  existed: boolean;
  content?: string;
  isOversized?: boolean;
}

export interface CheckpointRecord {
  id: string;
  seq: number;
  timestamp: number;
  description: string;
  snapshots: FileSnapshot[];
}

// Regex to catch NUL and ASCII/Unicode control characters (\x00-\x1f, \x7f)
const CONTROL_CHAR_REGEX = /[\x00-\x1F\x7F]/;

// Maximum file size to buffer in memory for instant rollback (5MB)
const MAX_SNAPSHOT_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Checkpoint & Safe File Undo Engine with Strict Workspace Boundary Jail
 * 
 * Enforces strict workspace containment:
 * - Rejects NUL and control characters in file paths.
 * - Resolves nearest existing ancestor to prevent symlink traversal escapes on non-existent targets.
 * - Restricts snapshot and /undo rollback operations strictly within workspaceRoot.
 * - Caps single-file in-memory snapshot size at 5MB to avoid memory degradation.
 * - Truncates trailing checkpoints on sequential rollback to prevent invalid state chains.
 */
export class DshCheckpointEngine {
  private checkpoints: CheckpointRecord[] = [];
  private workspaceRoot: string;
  private baseDir: string;
  private maxCheckpoints: number;
  /** Monotonically increasing sequence counter; never derived from array length (survives window eviction). */
  private nextSeq: number = 1;

  constructor(workspaceRoot?: string, customBaseDir?: string, maxCheckpoints = 50) {
    this.workspaceRoot = path.resolve(workspaceRoot || process.cwd());
    this.baseDir = customBaseDir || path.join(os.homedir(), '.dsh', 'checkpoints');
    this.maxCheckpoints = maxCheckpoints;

    if (!fs.existsSync(this.baseDir)) {
      try {
        fs.mkdirSync(this.baseDir, { recursive: true });
      } catch {
        // In restricted environments, fallback to in-memory only
      }
    }
  }

  /**
   * Resolve canonical workspace root
   */
  private getCanonicalWorkspaceRoot(): string {
    if (fs.existsSync(this.workspaceRoot)) {
      try {
        return fs.realpathSync.native ? fs.realpathSync.native(this.workspaceRoot) : fs.realpathSync(this.workspaceRoot);
      } catch {
        return path.resolve(this.workspaceRoot);
      }
    }
    return path.resolve(this.workspaceRoot);
  }

  /**
   * Find the nearest existing ancestor path for targetPath and resolve its realpath
   */
  private resolveNearestRealpath(targetPath: string): string {
    let current = path.resolve(targetPath);
    const trail: string[] = [];

    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached filesystem root without finding an existing directory
        break;
      }
      trail.unshift(path.basename(current));
      current = parent;
    }

    let realAncestor = current;
    if (fs.existsSync(current)) {
      try {
        realAncestor = fs.realpathSync.native ? fs.realpathSync.native(current) : fs.realpathSync(current);
      } catch {
        realAncestor = current;
      }
    }

    return trail.length > 0 ? path.join(realAncestor, ...trail) : realAncestor;
  }

  /**
   * Verify and sanitize that a target path resides strictly inside the workspace boundary.
   * Throws SecurityBoundaryViolationError if path escapes workspace.
   */
  public sanitizeWorkspacePath(rawPath: string): { fullPath: string; relativePath: string } {
    if (!rawPath || typeof rawPath !== 'string') {
      throw new SecurityBoundaryViolationError('Invalid file path: path must be a non-empty string.');
    }

    // Check for NUL or control characters
    if (CONTROL_CHAR_REGEX.test(rawPath)) {
      throw new SecurityBoundaryViolationError(
        `Security Boundary Violation: Control character or NUL byte detected in path "${rawPath}"`
      );
    }

    const resolved = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.workspaceRoot, rawPath);

    const canonicalRoot = this.getCanonicalWorkspaceRoot();
    const canonicalTarget = this.resolveNearestRealpath(resolved);

    // Compute relative path from canonical root
    const rel = path.relative(canonicalRoot, canonicalTarget);

    // If relative path starts with '..' or is absolute, it is outside workspace
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new SecurityBoundaryViolationError(
        `Security Boundary Violation: Path "${rawPath}" resolves outside workspace root (${canonicalRoot}). Target resolved to: ${canonicalTarget}`
      );
    }

    return { fullPath: canonicalTarget, relativePath: rel };
  }

  /**
   * Snapshot one or more files before a tool mutates them
   */
  public snapshot(filePaths: string[], description: string): CheckpointRecord {
    const seq = this.nextSeq++;
    const id = `cp_${Date.now()}_${seq}`;
    const snapshots: FileSnapshot[] = [];

    for (const rawPath of filePaths) {
      const { fullPath, relativePath } = this.sanitizeWorkspacePath(rawPath);

      if (fs.existsSync(fullPath)) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > MAX_SNAPSHOT_FILE_SIZE_BYTES) {
            // Protect against buffering huge files into memory
            snapshots.push({ filePath: fullPath, relativePath, existed: true, isOversized: true });
          } else {
            const content = fs.readFileSync(fullPath, 'utf-8');
            snapshots.push({ filePath: fullPath, relativePath, existed: true, content });
          }
        } catch {
          // Inaccessible or binary file
          snapshots.push({ filePath: fullPath, relativePath, existed: true });
        }
      } else {
        snapshots.push({ filePath: fullPath, relativePath, existed: false });
      }
    }

    const record: CheckpointRecord = {
      id,
      seq,
      timestamp: Date.now(),
      description,
      snapshots,
    };

    // Maintain sliding window ceiling
    if (this.checkpoints.length >= this.maxCheckpoints) {
      this.checkpoints.shift();
    }

    this.checkpoints.push(record);
    return record;
  }

  /**
   * Revert files to the state before the latest (or specified) checkpoint
   */
  public undo(seq?: number): { success: boolean; revertedFiles: string[]; error?: string } {
    if (this.checkpoints.length === 0) {
      return { success: false, revertedFiles: [], error: 'No checkpoints available to undo.' };
    }

    const targetIndex = seq !== undefined
      ? this.checkpoints.findIndex((c) => c.seq === seq)
      : this.checkpoints.length - 1;

    if (targetIndex === -1) {
      return { success: false, revertedFiles: [], error: `Checkpoint seq #${seq} not found.` };
    }

    const checkpoint = this.checkpoints[targetIndex];
    const revertedFiles: string[] = [];

    for (const snap of checkpoint.snapshots) {
      try {
        // Double-check workspace containment before executing file writes
        const { fullPath } = this.sanitizeWorkspacePath(snap.filePath);

        if (snap.existed && snap.content !== undefined) {
          const dir = path.dirname(fullPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(fullPath, snap.content, 'utf-8');
          revertedFiles.push(snap.relativePath || path.basename(fullPath));
        } else if (!snap.existed && fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
          revertedFiles.push(`${snap.relativePath || path.basename(fullPath)} (removed newly created file)`);
        }
      } catch (err: any) {
        return { success: false, revertedFiles, error: `Failed to restore ${snap.filePath}: ${err.message}` };
      }
    }

    // Truncate all checkpoints from targetIndex to end of sequence
    this.checkpoints.splice(targetIndex);

    return { success: true, revertedFiles };
  }

  public getCheckpoints(): readonly CheckpointRecord[] {
    return this.checkpoints;
  }

  public getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }
}
