// AIOS Core — ACS Client.
// Reads ACS runtime state from JSON files (no subprocess calls).
//
// Per Charter §9 Stage 1: read-only. This client reads:
//   - ACTIVE_TASK.json  → scope dirs (key: allowed_dirs)
//   - VIOLATIONS.json   → violation events + window score (key: window_score)
//   - LOCKED            → lock status
//
// Field names mirror the REAL ACS runtime file shapes (v5.x):
//   ACTIVE_TASK.json: task_id / task, allowed_dirs, allowed_files,
//                     blocked_commands, shadow_mode, proposal_required
//   VIOLATIONS.json:  events, window_score
//
// No subprocess calls. No writes to ACS state.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const RUNTIME_DIR = process.env.ACS_RUNTIME_DIR ?? `${process.env.HOME}/.claude/runtime`;

// ── Types ──────────────────────────────────────────────────────────────────

export interface AcsStatus {
  task: string;
  dirs: string[];
  shadow: boolean;
  proposal: boolean;
  violations: { window: number; windowMax: number; total: number; totalMax: number };
  locked: boolean;
  acsAvailable: boolean;
}

export interface AcsViolationEvent {
  timestamp: string;
  score: number;
  reason: string;
  category: string;
}

// ── Client ─────────────────────────────────────────────────────────────────

export class AcsClient {
  private readonly runtimeDir: string;

  constructor(runtimeDir?: string) {
    this.runtimeDir = runtimeDir ?? RUNTIME_DIR;
  }

  /** Get current ACS status by reading runtime files. */
  status(): AcsStatus {
    const locked = existsSync(path.join(this.runtimeDir, "LOCKED"));
    const task = this.readActiveTask();
    const violations = this.readViolations();
    return {
      task: task.taskId ?? "unknown",
      dirs: task.dirs ?? [],
      shadow: task.shadow ?? false,
      proposal: task.proposal ?? false,
      violations: {
        window: violations.window_score ?? 0,
        windowMax: 80,
        total: violations.total_score ?? 0,
        totalMax: 150,
      },
      locked,
      acsAvailable: existsSync(this.runtimeDir),
    };
  }

  /** Check if ACS is currently locked. */
  isLocked(): boolean {
    return existsSync(path.join(this.runtimeDir, "LOCKED"));
  }

  /** Get current ACS scope (allowed directories). */
  getScope(): string[] {
    const task = this.readActiveTask();
    return task.dirs ?? [];
  }

  /** Check if a path is within ACS scope. */
  isPathInScope(filePath: string): boolean {
    const dirs = this.getScope();
    if (dirs.length === 0) return false;
    return dirs.some((dir) => filePath.startsWith(dir));
  }

  /** Get violation events. */
  getViolations(): AcsViolationEvent[] {
    const data = this.readViolations();
    return Array.isArray(data.events) ? data.events : [];
  }

  /** Check if ACS runtime directory exists (i.e., ACS is installed). */
  isAvailable(): boolean {
    return existsSync(this.runtimeDir);
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private readActiveTask(): { taskId?: string; dirs?: string[]; shadow?: boolean; proposal?: boolean } {
    try {
      const raw = readFileSync(path.join(this.runtimeDir, "ACTIVE_TASK.json"), "utf-8");
      const data = JSON.parse(raw);
      // Real ACS v5.x shape uses allowed_dirs / shadow_mode / proposal_required
      // (task_id also exists); keep the old keys as fallbacks for legacy files.
      return {
        taskId: data.task_id ?? data.task,
        dirs: data.allowed_dirs ?? data.dirs ?? [],
        shadow: data.shadow_mode ?? false,
        proposal: data.proposal_required ?? false,
      };
    } catch {
      return {};
    }
  }

  private readViolations(): { events?: AcsViolationEvent[]; window_score?: number; total_score?: number } {
    try {
      const raw = readFileSync(path.join(this.runtimeDir, "VIOLATIONS.json"), "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
}
