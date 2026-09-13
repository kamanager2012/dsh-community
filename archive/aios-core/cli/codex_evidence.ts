// AIOS Core — Codex observation -> reliability evidence bridge.
//
// This module is deliberately conservative: vendor self-reported command
// execution is not promoted into build/test/lint/e2e evidence. Those evidence
// kinds must still come from independent AIOS verification.

import type {
  EvidenceItem,
  EvidenceStatus,
  TaskContract,
} from "../kernel/schema/index.js";
import {
  evaluateReliability,
  type ReliabilityRun,
} from "../kernel/reliability.js";
import type { CodexRunObservation } from "./codex.js";

export interface CodexReliabilityInput {
  taskId: string;
  project: string;
  model: string;
  version: string;
  contract: TaskContract;
  observation: CodexRunObservation;
  /** Independent verifier/policy/invariant evidence produced outside Codex. */
  additionalEvidence?: EvidenceItem[];
  fingerprint?: string;
  interventionCount?: number;
}

export interface CodexReliabilityAssessment {
  evidence: EvidenceItem[];
  run: ReliabilityRun;
}

function runReceiptStatus(observation: CodexRunObservation): EvidenceStatus {
  if (observation.status === "failed") return "fail";
  if (observation.status === "incomplete" || observation.streamIntegrity === "partial") {
    return "missing";
  }
  return "pass";
}

function fileChangeReceiptStatus(observation: CodexRunObservation): EvidenceStatus {
  if (observation.streamIntegrity === "partial") return "missing";
  if (observation.fileChanges.length === 0) return "missing";
  if (observation.fileChanges.some((item) => item.status === "failed")) return "fail";
  if (observation.fileChanges.some((item) => item.status !== "completed")) return "missing";
  return "pass";
}

function runSummary(observation: CodexRunObservation): string {
  const failedCommands = observation.commands.filter((item) => item.status === "failed").length;
  const failedTools = observation.mcpToolCalls.filter((item) => item.status === "failed").length;
  const changedPaths = observation.fileChanges.reduce((sum, item) => sum + item.changes.length, 0);
  return [
    `Codex run ${observation.status}`,
    `stream=${observation.streamIntegrity}`,
    `turns=${observation.turnsCompleted}/${observation.turnsStarted}`,
    `commands=${observation.commands.length} (${failedCommands} failed)`,
    `filePaths=${changedPaths}`,
    `mcpCalls=${observation.mcpToolCalls.length} (${failedTools} failed)`,
    `itemErrors=${observation.itemErrors.length}`,
  ].join("; ");
}

function fileChangeSummary(observation: CodexRunObservation): string {
  const pathCount = observation.fileChanges.reduce((sum, item) => sum + item.changes.length, 0);
  const completed = observation.fileChanges.filter((item) => item.status === "completed").length;
  const failed = observation.fileChanges.filter((item) => item.status === "failed").length;
  const unknown = observation.fileChanges.length - completed - failed;
  return [
    `Codex file-change receipt: items=${observation.fileChanges.length}`,
    `paths=${pathCount}`,
    `completed=${completed}`,
    `failed=${failed}`,
    `unknown=${unknown}`,
    `stream=${observation.streamIntegrity}`,
  ].join("; ");
}

/**
 * Convert a normalized Codex run into evidence the existing TaskContract gate
 * can consume.
 *
 * Only two vendor facts are asserted:
 * - artifact/codex.run: whether the Codex run reached a trustworthy terminal state
 * - diff/codex.file_changes: whether Codex reported trustworthy file-change receipts
 *
 * Command strings are intentionally never reclassified as build/test/lint/e2e.
 */
export function codexObservationToEvidence(
  observation: CodexRunObservation,
): EvidenceItem[] {
  const source = observation.threadId ? `codex-exec:${observation.threadId}` : "codex-exec";

  return [
    {
      kind: "artifact",
      id: "codex.run",
      status: runReceiptStatus(observation),
      summary: runSummary(observation),
      source,
    },
    {
      kind: "diff",
      id: "codex.file_changes",
      status: fileChangeReceiptStatus(observation),
      summary: fileChangeSummary(observation),
      source,
    },
  ];
}

/**
 * Evaluate one Codex run through the existing vendor-neutral reliability gate.
 * Independent evidence is accepted explicitly rather than inferred from Codex
 * self-reported commands.
 */
export function assessCodexReliability(
  input: CodexReliabilityInput,
): CodexReliabilityAssessment {
  const vendorEvidence = codexObservationToEvidence(input.observation);
  const evidence = [...vendorEvidence, ...(input.additionalEvidence ?? [])];
  const verdict = evaluateReliability(input.contract, evidence);

  const run: ReliabilityRun = {
    taskId: input.taskId,
    project: input.project,
    agent: "codex",
    model: input.model,
    version: input.version,
    verdict,
  };
  if (input.fingerprint !== undefined) run.fingerprint = input.fingerprint;
  if (input.interventionCount !== undefined) run.interventionCount = input.interventionCount;

  return { evidence, run };
}
