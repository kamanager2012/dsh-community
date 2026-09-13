/**
 * ACS Violation Log
 * ==================
 * Append-only 违规记录。
 * 每次 violation 记一条，累积清零只在 init_scope 时发生。
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ViolationEntry {
  ts: number;
  reason: string;
  score: number;
  total: number;
}

const LOG_DIR = join(import.meta.dirname, "../../.claude/runtime");
const LOG_FILE = join(LOG_DIR, "VIOLATION_LOG.jsonl");

export function appendViolation(reason: string, score: number, total: number): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const entry: ViolationEntry = { ts: Date.now(), reason, score, total };
  writeFileSync(LOG_FILE, JSON.stringify(entry) + "\n", { flag: "a" });
}

export function readViolations(): ViolationEntry[] {
  try {
    const data = readFileSync(LOG_FILE, "utf-8").trim();
    if (!data) return [];
    return data.split("\n").map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function violationSummary(): string {
  const entries = readViolations();
  const total = entries.reduce((s, e) => s + e.score, 0);
  const byReason: Record<string, number> = {};
  for (const e of entries) {
    byReason[e.reason] = (byReason[e.reason] || 0) + e.score;
  }
  const lines = [`violations: ${total}/100`];
  for (const [r, s] of Object.entries(byReason)) {
    lines.push(`  +${s}  ${r}`);
  }
  return lines.join("\n");
}
