import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalize, toHookOutput, buildEngine } from "../src/adapters/claude-code/hook.js";
import type { Verdict } from "../src/types.js";

describe("hook.normalize — PreToolUse payload mapping", () => {
  it("maps Bash command", () => {
    const call = normalize({ tool_name: "Bash", tool_input: { command: "rm -rf /" } });
    expect(call.tool).toBe("Bash");
    expect(call.command).toBe("rm -rf /");
  });

  it("maps Write/Edit file_path", () => {
    const call = normalize({ tool_name: "Write", tool_input: { file_path: ".env", content: "x" } });
    expect(call.tool).toBe("Write");
    expect(call.file).toBe(".env");
  });

  it("maps NotebookEdit notebook_path", () => {
    const call = normalize({ tool_name: "NotebookEdit", tool_input: { notebook_path: "nb.ipynb" } });
    expect(call.file).toBe("nb.ipynb");
  });
});

describe("hook.toHookOutput — verdict to hook protocol", () => {
  it("emits permissionDecision for allow/deny", () => {
    const allow = toHookOutput({ decision: "allow", reason: "ok" }) as any;
    expect(allow.hookSpecificOutput.permissionDecision).toBe("allow");
    const deny = toHookOutput({ decision: "deny", reason: "nope" }) as any;
    expect(deny.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("includes approval instructions for ask", () => {
    const v: Verdict = { decision: "ask", reason: "needs approval", pendingId: "abc123" };
    const out = toHookOutput(v) as any;
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("aigov approve abc123");
  });
});

describe("hook end-to-end — engine wired through the adapter", () => {
  async function run(evt: unknown): Promise<Verdict> {
    const dir = await mkdtemp(join(tmpdir(), "aigov-hook-"));
    process.env.AIGOV_AUDIT = join(dir, "audit.jsonl");
    process.env.AIGOV_APPROVALS = join(dir, "approvals");
    const engine = await buildEngine();
    return engine.evaluate(normalize(evt as any));
  }

  it("denies rm -rf via the hook path", async () => {
    const v = await run({ tool_name: "Bash", tool_input: { command: "rm -rf /" } });
    expect(v.decision).toBe("deny");
  });

  it("denies writing .env via the hook path", async () => {
    const v = await run({ tool_name: "Write", tool_input: { file_path: ".env" } });
    expect(v.decision).toBe("deny");
  });

  it("allows git status via the hook path", async () => {
    const v = await run({ tool_name: "Bash", tool_input: { command: "git status" } });
    expect(v.decision).toBe("allow");
  });
});
