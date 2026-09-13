import { describe, expect, it } from "vitest";
import {
  observeCodexExecEvents,
  parseCodexExecJsonl,
} from "../../cli/codex.js";

function toJsonl(events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

const usage = {
  input_tokens: 100,
  cached_input_tokens: 20,
  cache_write_input_tokens: 5,
  output_tokens: 30,
  reasoning_output_tokens: 7,
};

describe("Codex exec observation adapter", () => {
  it("normalizes a completed Codex run and keeps the latest item state", () => {
    const observation = parseCodexExecJsonl(toJsonl([
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
      {
        type: "item.started",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "",
          status: "in_progress",
        },
      },
      {
        type: "item.updated",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "running",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "ok",
          exit_code: 0,
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "files-1",
          type: "file_change",
          changes: [{ path: "src/example.ts", kind: "update" }],
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "mcp-1",
          type: "mcp_tool_call",
          server: "github",
          tool: "search",
          arguments: { q: "agent reliability" },
          result: { structured_content: { ok: true } },
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: { id: "web-1", type: "web_search", query: "Codex docs" },
      },
      {
        type: "item.completed",
        item: { id: "reason-1", type: "reasoning", text: "private detail is not persisted" },
      },
      {
        type: "item.updated",
        item: { id: "todo-1", type: "todo_list", items: [{ text: "test", completed: true }] },
      },
      {
        type: "item.completed",
        item: { id: "msg-1", type: "agent_message", text: "Implemented and verified." },
      },
      { type: "turn.completed", usage },
    ]));

    expect(observation.vendor).toBe("codex");
    expect(observation.schemaVersion).toBe(1);
    expect(observation.threadId).toBe("thread-1");
    expect(observation.status).toBe("completed");
    expect(observation.streamIntegrity).toBe("complete");
    expect(observation.turnsStarted).toBe(1);
    expect(observation.turnsCompleted).toBe(1);
    expect(observation.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 5,
      outputTokens: 30,
      reasoningOutputTokens: 7,
    });

    expect(observation.commands).toHaveLength(1);
    expect(observation.commands[0]).toEqual({
      id: "cmd-1",
      command: "npm test",
      status: "completed",
      outputChars: 2,
      exitCode: 0,
    });
    expect(observation.fileChanges[0]).toEqual({
      id: "files-1",
      status: "completed",
      changes: [{ path: "src/example.ts", kind: "update" }],
    });
    expect(observation.mcpToolCalls[0]).toEqual({
      id: "mcp-1",
      server: "github",
      tool: "search",
      status: "completed",
      resultPresent: true,
    });
    expect(observation.webSearches[0]?.query).toBe("Codex docs");
    expect(observation.agentMessages[0]?.text).toBe("Implemented and verified.");
    expect(observation.reasoningItemCount).toBe(1);
    expect(observation.todoItemCount).toBe(1);
  });

  it("includes sensitive command/MCP payloads only when explicitly requested", () => {
    const observation = observeCodexExecEvents([
      {
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "test output",
          exit_code: 0,
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "mcp-1",
          type: "mcp_tool_call",
          server: "example",
          tool: "lookup",
          arguments: { key: "value" },
          result: { structured_content: { found: true } },
          status: "completed",
        },
      },
      { type: "turn.completed", usage },
    ], {
      includeCommandOutput: true,
      includeMcpPayloads: true,
    });

    expect(observation.commands[0]?.aggregatedOutput).toBe("test output");
    expect(observation.mcpToolCalls[0]?.arguments).toEqual({ key: "value" });
    expect(observation.mcpToolCalls[0]?.result).toEqual({ structured_content: { found: true } });
  });

  it("does not treat non-fatal item errors as whole-run failure", () => {
    const observation = observeCodexExecEvents([
      {
        type: "item.completed",
        item: { id: "err-1", type: "error", message: "recoverable stream lag" },
      },
      { type: "turn.completed", usage },
    ]);

    expect(observation.status).toBe("completed");
    expect(observation.itemErrors).toEqual([{ id: "err-1", message: "recoverable stream lag" }]);
    expect(observation.fatalErrors).toEqual([]);
  });

  it("marks turn.failed as fatal even when earlier work produced observations", () => {
    const observation = observeCodexExecEvents([
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "failed",
          exit_code: 1,
          status: "failed",
        },
      },
      { type: "turn.failed", error: { message: "agent run failed" } },
    ]);

    expect(observation.status).toBe("failed");
    expect(observation.fatalErrors).toEqual(["agent run failed"]);
    expect(observation.commands[0]?.status).toBe("failed");
  });

  it("marks a top-level stream error as fatal", () => {
    const observation = observeCodexExecEvents([
      { type: "error", message: "transport lost" },
    ]);

    expect(observation.status).toBe("failed");
    expect(observation.fatalErrors).toEqual(["transport lost"]);
  });

  it("keeps a run incomplete when no terminal turn event is observed", () => {
    const observation = observeCodexExecEvents([
      { type: "thread.started", thread_id: "thread-incomplete" },
      { type: "turn.started" },
      {
        type: "item.started",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "running",
          status: "in_progress",
        },
      },
    ]);

    expect(observation.status).toBe("incomplete");
    expect(observation.commands[0]?.status).toBe("in_progress");
  });

  it("reports malformed JSONL without discarding valid events", () => {
    const jsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      "{not-json}",
      JSON.stringify({ type: "turn.completed", usage }),
    ].join("\n");

    const observation = parseCodexExecJsonl(jsonl);
    expect(observation.status).toBe("completed");
    expect(observation.streamIntegrity).toBe("partial");
    expect(observation.malformedLines).toEqual([2]);
    expect(observation.eventCount).toBe(2);
  });

  it("treats unknown event/item types as forward-compatible schema evolution", () => {
    const observation = observeCodexExecEvents([
      { type: "future.event", payload: { version: 2 } },
      {
        type: "item.completed",
        item: { id: "future-1", type: "future_item", data: true },
      },
      { type: "turn.completed", usage },
    ]);

    expect(observation.status).toBe("completed");
    expect(observation.streamIntegrity).toBe("complete");
    expect(observation.unknownEventTypes).toEqual(["future.event"]);
    expect(observation.unknownItemTypes).toEqual(["future_item"]);
  });

  it("aggregates usage across multiple completed turns without duplicating item IDs", () => {
    const observation = observeCodexExecEvents([
      { type: "turn.started" },
      { type: "turn.completed", usage },
      { type: "turn.started" },
      {
        type: "item.started",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "done",
          exit_code: 0,
          status: "completed",
        },
      },
      { type: "turn.completed", usage },
    ]);

    expect(observation.turnsStarted).toBe(2);
    expect(observation.turnsCompleted).toBe(2);
    expect(observation.usage.inputTokens).toBe(200);
    expect(observation.usage.outputTokens).toBe(60);
    expect(observation.commands).toHaveLength(1);
    expect(observation.commands[0]?.outputChars).toBe(4);
  });
});
