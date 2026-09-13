// AIOS Core — Context generator.
//
// Per Charter §4: this is the ONLY way to build agent context.
//   Task + Current + last 3 tasks + last 5 decisions + architecture
//   = Agent Context
//
// No full history injection. No unbounded context growth.
// This is the most important anti-context-explosion mechanism.

import type { MemoryStore, MemoryTaskRecord, MemoryDecisionRecord } from "./index.js";
import type { ProjectState } from "../kernel/schema/index.js";

export interface AgentContext {
  /** Current project state (hot). */
  current: ProjectState;
  /** Recent completed tasks (warm→cold). */
  recentTasks: MemoryTaskRecord[];
  /** Recent decisions with reasoning (warm). */
  recentDecisions: MemoryDecisionRecord[];
  /** Project architecture understanding (cold). */
  architecture: Record<string, unknown>;
  /** The active task being worked on. */
  activeTask: string | null;
}

export interface ContextConfig {
  /** How many recent tasks to include. Default: 3. */
  recentTasksCount: number;
  /** How many recent decisions to include. Default: 5. */
  recentDecisionsCount: number;
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  recentTasksCount: 3,
  recentDecisionsCount: 5,
};

export async function buildContext(
  memory: MemoryStore,
  taskId: string | null,
  config: ContextConfig = DEFAULT_CONTEXT_CONFIG,
): Promise<AgentContext> {
  // 1. Current state (hot)
  let current: ProjectState = {
    goal: "", active_task: null, branch: "main", phase: "IDLE", last_change: "",
  };
  try {
    const raw = await memory.readCurrent("project_state.json");
    if (raw) current = JSON.parse(raw) as ProjectState;
  } catch {}

  // 2. Recent tasks (warm→cold)
  const recentTasks = memory.recentTasks(config.recentTasksCount);

  // 3. Recent decisions (warm)
  const recentDecisions = memory.recentDecisions(config.recentDecisionsCount);

  // 4. Architecture (cold)
  let architecture: Record<string, unknown> = {};
  try {
    const raw = await memory.readCurrent("architecture.json");
    if (raw) architecture = JSON.parse(raw);
  } catch {}

  return {
    current,
    recentTasks,
    recentDecisions,
    architecture,
    activeTask: taskId ?? current.active_task,
  };
}
