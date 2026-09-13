// AIOS Core — Codex exec observation adapter.
//
// This module ingests Codex CLI/SDK JSONL events and normalizes them into
// reliability evidence. It deliberately does not launch Codex or execute any
// command. Execution remains an external/vendor responsibility.

export type CodexRunStatus = "completed" | "failed" | "incomplete";
export type CodexStreamIntegrity = "complete" | "partial";
export type CodexCommandStatus = "in_progress" | "completed" | "failed" | "unknown";
export type CodexFileChangeStatus = "completed" | "failed" | "unknown";
export type CodexToolCallStatus = "in_progress" | "completed" | "failed" | "unknown";

export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexCommandObservation {
  id: string;
  command: string;
  status: CodexCommandStatus;
  outputChars: number;
  exitCode?: number;
  aggregatedOutput?: string;
}

export interface CodexFileChangeObservation {
  id: string;
  status: CodexFileChangeStatus;
  changes: Array<{
    path: string;
    kind: "add" | "delete" | "update" | "unknown";
  }>;
}

export interface CodexMcpToolObservation {
  id: string;
  server: string;
  tool: string;
  status: CodexToolCallStatus;
  resultPresent: boolean;
  error?: string;
  arguments?: unknown;
  result?: unknown;
}

export interface CodexWebSearchObservation {
  id: string;
  query: string;
}

export interface CodexAgentMessageObservation {
  id: string;
  text: string;
}

export interface CodexItemErrorObservation {
  id: string;
  message: string;
}

export interface CodexParseOptions {
  /** Command output can contain secrets. It is omitted unless explicitly requested. */
  includeCommandOutput?: boolean;
  /** MCP arguments/results can contain secrets. They are omitted unless explicitly requested. */
  includeMcpPayloads?: boolean;
}

export interface CodexRunObservation {
  schemaVersion: 1;
  vendor: "codex";
  threadId?: string;
  status: CodexRunStatus;
  streamIntegrity: CodexStreamIntegrity;
  eventCount: number;
  malformedLines: number[];
  malformedEventCount: number;
  malformedItemCount: number;
  unknownEventTypes: string[];
  unknownItemTypes: string[];
  turnsStarted: number;
  turnsCompleted: number;
  usage: CodexUsage;
  commands: CodexCommandObservation[];
  fileChanges: CodexFileChangeObservation[];
  mcpToolCalls: CodexMcpToolObservation[];
  webSearches: CodexWebSearchObservation[];
  agentMessages: CodexAgentMessageObservation[];
  itemErrors: CodexItemErrorObservation[];
  fatalErrors: string[];
  reasoningItemCount: number;
  todoItemCount: number;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function commandStatus(value: unknown): CodexCommandStatus {
  return value === "in_progress" || value === "completed" || value === "failed"
    ? value
    : "unknown";
}

function fileChangeStatus(value: unknown): CodexFileChangeStatus {
  return value === "completed" || value === "failed" ? value : "unknown";
}

function toolCallStatus(value: unknown): CodexToolCallStatus {
  return value === "in_progress" || value === "completed" || value === "failed"
    ? value
    : "unknown";
}

function fileChangeKind(value: unknown): "add" | "delete" | "update" | "unknown" {
  return value === "add" || value === "delete" || value === "update" ? value : "unknown";
}

function readUsage(value: unknown): CodexUsage {
  const usage = asRecord(value) ?? {};
  return {
    inputTokens: asFiniteNumber(usage.input_tokens) ?? 0,
    cachedInputTokens: asFiniteNumber(usage.cached_input_tokens) ?? 0,
    cacheWriteInputTokens: asFiniteNumber(usage.cache_write_input_tokens) ?? 0,
    outputTokens: asFiniteNumber(usage.output_tokens) ?? 0,
    reasoningOutputTokens: asFiniteNumber(usage.reasoning_output_tokens) ?? 0,
  };
}

function addUsage(target: CodexUsage, next: CodexUsage): void {
  target.inputTokens += next.inputTokens;
  target.cachedInputTokens += next.cachedInputTokens;
  target.cacheWriteInputTokens += next.cacheWriteInputTokens;
  target.outputTokens += next.outputTokens;
  target.reasoningOutputTokens += next.reasoningOutputTokens;
}

function sorted(values: Set<string>): string[] {
  return [...values].sort();
}

interface BuildState {
  threadId?: string;
  eventCount: number;
  malformedEventCount: number;
  malformedItemCount: number;
  unknownEventTypes: Set<string>;
  unknownItemTypes: Set<string>;
  turnsStarted: number;
  turnsCompleted: number;
  usage: CodexUsage;
  commands: Map<string, CodexCommandObservation>;
  fileChanges: Map<string, CodexFileChangeObservation>;
  mcpToolCalls: Map<string, CodexMcpToolObservation>;
  webSearches: Map<string, CodexWebSearchObservation>;
  agentMessages: Map<string, CodexAgentMessageObservation>;
  itemErrors: Map<string, CodexItemErrorObservation>;
  fatalErrors: string[];
  reasoningItemIds: Set<string>;
  todoItemIds: Set<string>;
}

function createState(): BuildState {
  return {
    eventCount: 0,
    malformedEventCount: 0,
    malformedItemCount: 0,
    unknownEventTypes: new Set(),
    unknownItemTypes: new Set(),
    turnsStarted: 0,
    turnsCompleted: 0,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    commands: new Map(),
    fileChanges: new Map(),
    mcpToolCalls: new Map(),
    webSearches: new Map(),
    agentMessages: new Map(),
    itemErrors: new Map(),
    fatalErrors: [],
    reasoningItemIds: new Set(),
    todoItemIds: new Set(),
  };
}

function observeItem(
  state: BuildState,
  rawItem: unknown,
  options: CodexParseOptions,
): void {
  const item = asRecord(rawItem);
  if (!item) {
    state.malformedItemCount++;
    return;
  }

  const id = asString(item.id);
  const type = asString(item.type);
  if (!id || !type) {
    state.malformedItemCount++;
    return;
  }

  switch (type) {
    case "command_execution": {
      const command = asString(item.command);
      if (!command) {
        state.malformedItemCount++;
        return;
      }
      const output = asString(item.aggregated_output) ?? "";
      const observation: CodexCommandObservation = {
        id,
        command,
        status: commandStatus(item.status),
        outputChars: output.length,
      };
      const exitCode = asFiniteNumber(item.exit_code);
      if (exitCode !== undefined) observation.exitCode = exitCode;
      if (options.includeCommandOutput) observation.aggregatedOutput = output;
      state.commands.set(id, observation);
      return;
    }

    case "file_change": {
      const rawChanges = Array.isArray(item.changes) ? item.changes : [];
      const changes: CodexFileChangeObservation["changes"] = [];
      for (const rawChange of rawChanges) {
        const change = asRecord(rawChange);
        const path = change ? asString(change.path) : undefined;
        if (!path) continue;
        changes.push({ path, kind: fileChangeKind(change?.kind) });
      }
      state.fileChanges.set(id, {
        id,
        status: fileChangeStatus(item.status),
        changes,
      });
      return;
    }

    case "mcp_tool_call": {
      const server = asString(item.server);
      const tool = asString(item.tool);
      if (!server || !tool) {
        state.malformedItemCount++;
        return;
      }
      const error = asRecord(item.error);
      const observation: CodexMcpToolObservation = {
        id,
        server,
        tool,
        status: toolCallStatus(item.status),
        resultPresent: item.result !== undefined,
      };
      const errorMessage = error ? asString(error.message) : undefined;
      if (errorMessage) observation.error = errorMessage;
      if (options.includeMcpPayloads) {
        if (item.arguments !== undefined) observation.arguments = item.arguments;
        if (item.result !== undefined) observation.result = item.result;
      }
      state.mcpToolCalls.set(id, observation);
      return;
    }

    case "web_search": {
      const query = asString(item.query);
      if (!query) {
        state.malformedItemCount++;
        return;
      }
      state.webSearches.set(id, { id, query });
      return;
    }

    case "agent_message": {
      const text = asString(item.text);
      if (text === undefined) {
        state.malformedItemCount++;
        return;
      }
      state.agentMessages.set(id, { id, text });
      return;
    }

    case "error": {
      const message = asString(item.message);
      if (!message) {
        state.malformedItemCount++;
        return;
      }
      // SDK marks this item as non-fatal. Do not turn a successfully completed
      // run into a failure merely because Codex surfaced a recoverable item error.
      state.itemErrors.set(id, { id, message });
      return;
    }

    case "reasoning":
      // Reliability does not need model chain-of-thought text. Count the item
      // without persisting its reasoning payload.
      state.reasoningItemIds.add(id);
      return;

    case "todo_list":
      state.todoItemIds.add(id);
      return;

    default:
      state.unknownItemTypes.add(type);
  }
}

function observeEvent(
  state: BuildState,
  rawEvent: unknown,
  options: CodexParseOptions,
): void {
  const event = asRecord(rawEvent);
  if (!event) {
    state.malformedEventCount++;
    return;
  }

  const type = asString(event.type);
  if (!type) {
    state.malformedEventCount++;
    return;
  }
  state.eventCount++;

  switch (type) {
    case "thread.started": {
      const threadId = asString(event.thread_id);
      if (threadId && state.threadId === undefined) state.threadId = threadId;
      else if (!threadId) state.malformedEventCount++;
      return;
    }

    case "turn.started":
      state.turnsStarted++;
      return;

    case "turn.completed":
      state.turnsCompleted++;
      addUsage(state.usage, readUsage(event.usage));
      return;

    case "turn.failed": {
      const error = asRecord(event.error);
      state.fatalErrors.push(error ? asString(error.message) ?? "turn failed" : "turn failed");
      return;
    }

    case "error":
      state.fatalErrors.push(asString(event.message) ?? "fatal stream error");
      return;

    case "item.started":
    case "item.updated":
    case "item.completed":
      observeItem(state, event.item, options);
      return;

    default:
      // Forward-compatible by design. A new Codex event type is evidence of
      // schema evolution, not proof that the stream itself is corrupt.
      state.unknownEventTypes.add(type);
  }
}

function finalize(
  state: BuildState,
  malformedLines: number[],
): CodexRunObservation {
  const status: CodexRunStatus = state.fatalErrors.length > 0
    ? "failed"
    : state.turnsCompleted > 0
      ? "completed"
      : "incomplete";

  return {
    schemaVersion: 1,
    vendor: "codex",
    ...(state.threadId ? { threadId: state.threadId } : {}),
    status,
    streamIntegrity: malformedLines.length > 0 || state.malformedEventCount > 0 || state.malformedItemCount > 0
      ? "partial"
      : "complete",
    eventCount: state.eventCount,
    malformedLines,
    malformedEventCount: state.malformedEventCount,
    malformedItemCount: state.malformedItemCount,
    unknownEventTypes: sorted(state.unknownEventTypes),
    unknownItemTypes: sorted(state.unknownItemTypes),
    turnsStarted: state.turnsStarted,
    turnsCompleted: state.turnsCompleted,
    usage: state.usage,
    commands: [...state.commands.values()],
    fileChanges: [...state.fileChanges.values()],
    mcpToolCalls: [...state.mcpToolCalls.values()],
    webSearches: [...state.webSearches.values()],
    agentMessages: [...state.agentMessages.values()],
    itemErrors: [...state.itemErrors.values()],
    fatalErrors: state.fatalErrors,
    reasoningItemCount: state.reasoningItemIds.size,
    todoItemCount: state.todoItemIds.size,
  };
}

/** Normalize already-decoded Codex exec/SDK events. */
export function observeCodexExecEvents(
  events: readonly unknown[],
  options: CodexParseOptions = {},
): CodexRunObservation {
  const state = createState();
  for (const event of events) observeEvent(state, event, options);
  return finalize(state, []);
}

/** Parse the JSONL stream emitted by `codex exec --json`. */
export function parseCodexExecJsonl(
  jsonl: string,
  options: CodexParseOptions = {},
): CodexRunObservation {
  const state = createState();
  const malformedLines: number[] = [];
  const lines = jsonl.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    try {
      observeEvent(state, JSON.parse(line) as unknown, options);
    } catch {
      malformedLines.push(index + 1);
    }
  }

  return finalize(state, malformedLines);
}
