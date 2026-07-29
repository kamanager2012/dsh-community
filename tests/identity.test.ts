import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GovernanceEngine } from "../src/engine.js";
import { ScopeValidator } from "../src/scope.js";
import { AuditLog, InMemoryAuditSink, FileAuditSink, readChain, verifyChain } from "../src/audit.js";
import { signatureId } from "../src/approval.js";
import { normalize, resolveIdentity } from "../src/adapters/claude-code/hook.js";
import type { ToolCall, ExecutionIdentity } from "../src/types.js";

const NOW = () => "2026-07-29T00:00:00.000Z";

function makeEngine(sink = new InMemoryAuditSink()) {
  const engine = new GovernanceEngine({
    scope: new ScopeValidator(),
    audit: new AuditLog(sink, NOW, "test"),
    now: NOW,
  });
  return { engine, sink };
}

const ID: ExecutionIdentity = {
  agentId: "review-agent",
  runId: "run_abc",
  attemptId: "2",
  parentRunId: "run_root",
  lineageId: "L1",
  executionEpoch: 7,
};

describe("identity — optional, no regression when absent", () => {
  it("evaluate works and audits with no identity field", async () => {
    const { engine, sink } = makeEngine();
    const v = await engine.evaluate({ tool: "Bash", command: "git status" });
    expect(v.decision).toBe("allow");
    const records = sink.read();
    expect(records.length).toBe(1);
    expect(records[0]!.event.identity).toBeUndefined();
    expect(verifyChain([...records]).ok).toBe(true);
  });

  it("identity never changes the verdict", async () => {
    const { engine } = makeEngine();
    const call: ToolCall = { tool: "Bash", command: "rm -rf /", identity: ID };
    expect((await engine.evaluate(call)).decision).toBe("deny");
    const allow: ToolCall = { tool: "Write", file: "src/x.ts", identity: ID };
    expect((await engine.evaluate(allow)).decision).toBe("allow");
  });
});

describe("identity — snapshot lands in the hash chain", () => {
  it("records the identity on the audit event and chain verifies", async () => {
    const { engine, sink } = makeEngine();
    await engine.evaluate({ tool: "Bash", command: "git status", identity: ID });
    const records = sink.read();
    expect(records[0]!.event.identity).toEqual(ID);
    expect(verifyChain([...records]).ok).toBe(true);
  });

  it("tampering with the recorded identity breaks the chain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aigov-id-"));
    const path = join(dir, "audit.jsonl");
    const engine = new GovernanceEngine({
      scope: new ScopeValidator(),
      audit: new AuditLog(new FileAuditSink(path), NOW, "test"),
      now: NOW,
    });
    await engine.evaluate({ tool: "Bash", command: "git status", identity: ID });

    const raw = await readFile(path, "utf8");
    const tampered = raw.replace('"agentId":"review-agent"', '"agentId":"attacker"');
    expect(tampered).not.toBe(raw); // guard: the replacement actually happened
    await writeFile(path, tampered, "utf8");

    const res = verifyChain(await readChain(path));
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(1);
  });

  it("replay via readChain returns the identity intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aigov-id-"));
    const path = join(dir, "audit.jsonl");
    const engine = new GovernanceEngine({
      scope: new ScopeValidator(),
      audit: new AuditLog(new FileAuditSink(path), NOW, "test"),
      now: NOW,
    });
    await engine.evaluate({ tool: "Bash", command: "git status", identity: ID });
    const chain = await readChain(path);
    expect(chain[0]!.event.identity).toEqual(ID);
  });
});

describe("identity — approval binding unchanged in v0.1", () => {
  it("signatureId ignores identity (same op, different identity => same id)", () => {
    const base: ToolCall = { tool: "Bash", command: "git push origin main" };
    const withId: ToolCall = { ...base, identity: ID };
    const otherId: ToolCall = { ...base, identity: { agentId: "someone-else", runId: "run_z" } };
    expect(signatureId(withId)).toBe(signatureId(base));
    expect(signatureId(otherId)).toBe(signatureId(base));
  });
});

describe("claude-code adapter — identity defaults and env overlay", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["AIGOV_AGENT_ID", "AIGOV_RUN_ID", "AIGOV_ATTEMPT_ID", "AIGOV_PARENT_RUN_ID", "AIGOV_LINEAGE_ID"]) {
      delete process.env[k];
    }
    Object.assign(process.env, saved);
  });

  it("normalize defaults agentId to claude-code", () => {
    const call = normalize({ tool_name: "Bash", tool_input: { command: "git status" } });
    expect(call.identity).toEqual({ agentId: "claude-code" });
  });

  it("resolveIdentity keeps the base default when no env is set", () => {
    delete process.env.AIGOV_AGENT_ID;
    delete process.env.AIGOV_RUN_ID;
    const id = resolveIdentity({ agentId: "claude-code" });
    expect(id).toEqual({ agentId: "claude-code" });
  });

  it("resolveIdentity overlays run/agent/attempt from the environment", () => {
    process.env.AIGOV_AGENT_ID = "my-agent";
    process.env.AIGOV_RUN_ID = "run_env";
    process.env.AIGOV_ATTEMPT_ID = "3";
    const id = resolveIdentity({ agentId: "claude-code" });
    expect(id.agentId).toBe("my-agent");
    expect(id.runId).toBe("run_env");
    expect(id.attemptId).toBe("3");
    expect(id.parentRunId).toBeUndefined();
  });
});
