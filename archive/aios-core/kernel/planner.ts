// AIOS Core — Planner (stateless).
//
// Industrial redesign: planner is a pure function.
// Reads TaskRequest + project state, returns Plan.
// No internal state. No IO beyond what the adapter provides.

import type { Plan, TaskRequest, ProjectState, Risk, Approval, PlanStep } from "./schema/index.js";

// ── Planner function signature ───────────────────────────────────────────────

export interface PlannerFn {
  (req: TaskRequest): Promise<Plan>;
}

// ── Adapter: IO operations the planner needs ────────────────────────────────

export interface PlannerAdapter {
  readProjectState: (project: string) => Promise<ProjectState>;
  modelCall: (prompt: string) => Promise<string>;
  now: () => string;
}

// ── Factory: create a stateless planner function ────────────────────────────

export function createPlanner(adapter: PlannerAdapter): PlannerFn {
  return async (req: TaskRequest): Promise<Plan> => {
    const state = await adapter.readProjectState(req.project);
    const prompt = buildPrompt(req, state);
    const raw = await adapter.modelCall(prompt);
    return parsePlan(raw, req, adapter.now());
  };
}

// ── Pure helpers ────────────────────────────────────────────────────────────

function buildPrompt(req: TaskRequest, state: ProjectState): string {
  return [
    `Goal: ${req.goal}`,
    `Project: ${state.project ?? req.project} (phase: ${state.phase})`,
    `Active task: ${state.active_task ?? "(none)"}`,
    `Last change: ${state.last_change}`,
    `Context: ${req.context ?? ""}`,
    "",
    "Produce a YAML plan with: task, scope, risk (low|medium|high),",
    "files, steps[], tests[], rollback, approval (AUTO|MANUAL).",
    "Do not include code.",
  ].join("\n");
}

function parsePlan(raw: string, req: TaskRequest, now: string): Plan {
  const risk = extractRisk(raw);
  const approval = inferApproval(risk, raw);
  const files = extractList(raw, "files");
  const steps = extractSteps(raw);
  const scope = extractList(raw, "scope");
  const tests = extractList(raw, "tests");
  const rollback = extractScalar(raw, "rollback") ?? "git revert";
  return {
    task: extractScalar(raw, "task") ?? req.goal,
    scope,
    risk,
    files,
    steps,
    tests,
    rollback,
    approval,
    createdAt: now,
    frozen: true,
    ...(req.contract ? { contract: req.contract } : {}),
  };
}

function extractRisk(raw: string): Risk {
  const m = raw.match(/risk:\s*(low|medium|high)/i);
  if (m && (m[1] === "low" || m[1] === "medium" || m[1] === "high")) return m[1];
  return "medium";
}

function inferApproval(risk: Risk, raw: string): Approval {
  const explicit = raw.match(/approval:\s*(AUTO|MANUAL)/i);
  if (explicit) return explicit[1]!.toUpperCase() as Approval;
  if (risk === "high" || risk === "medium") return "MANUAL";
  return "AUTO";
}

function extractList(raw: string, key: string): string[] {
  const inlineRe = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`);
  const inlineM = raw.match(inlineRe);
  if (inlineM && inlineM[1]) {
    return inlineM[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  const blockRe = new RegExp(`^${key}:\\s*$\\n((?:\\s+- .+\\n?)*)`, "m");
  const blockM = raw.match(blockRe);
  if (blockM && blockM[1]) {
    return blockM[1]
      .split("\n")
      .map((l) => l.replace(/^\s*-\s*/, "").trim())
      .filter((l) => l.length > 0);
  }
  const singleM = raw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (singleM && singleM[1] && !singleM[1].includes("\n")) {
    return [singleM[1].trim()];
  }
  return [];
}

function extractSteps(raw: string): PlanStep[] {
  const steps: PlanStep[] = [];
  const stepRe = /(?:^|\n)\s*(?:\d+\.\s*|-)\s*(.+?)(?:\s+on\s+(.+?))?(?:\n|$)/g;
  let match;
  let order = 1;
  while ((match = stepRe.exec(raw)) !== null) {
    const action = match[1]?.trim();
    if (!action) continue;
    if (/^(task|scope|risk|files|tests|rollback|approval):/i.test(action)) continue;
    steps.push({ order: order++, action, target: match[2]?.trim() ?? "" });
  }
  if (steps.length === 0) {
    steps.push({ order: 1, action: "apply changes", target: "(from plan)" });
  }
  return steps;
}

function extractScalar(raw: string, key: string): string | undefined {
  const m = raw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m?.[1]?.trim();
}
