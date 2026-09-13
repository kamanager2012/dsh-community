import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GovernanceEngine } from "../src/engine.js";
import { ScopeValidator, type ScopePolicy } from "../src/scope.js";
import { AuditLog, InMemoryAuditSink, FileAuditSink, readChain, verifyChain, writeAnchor, readAnchors, verifyAgainstAnchor } from "../src/audit.js";
import { ApprovalStore, signatureId } from "../src/approval.js";
import type { ToolCall } from "../src/types.js";

const realPolicy: ScopePolicy = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../policy.json"), "utf8"),
);

const NOW = () => "2026-07-29T00:00:00.000Z";

function makeEngine(opts: { approvals?: ApprovalStore; sink?: InMemoryAuditSink } = {}) {
  const sink = opts.sink ?? new InMemoryAuditSink();
  const engine = new GovernanceEngine({
    scope: new ScopeValidator(realPolicy),
    audit: new AuditLog(sink, NOW, "test"),
    approvals: opts.approvals,
    askPaths: ["**/.env"],
    askCommands: ["git push"],
    now: NOW,
  });
  return { engine, sink };
}

describe("GovernanceEngine.evaluate — deny", () => {
  it("denies destructive and chained/substitution bypasses", async () => {
    const { engine } = makeEngine();
    for (const command of ["rm -rf /", "git status; rm -rf /", "echo $(rm -rf /)"]) {
      const v = await engine.evaluate({ tool: "Bash", command });
      expect(v.decision, command).toBe("deny");
    }
  });

  it("denies writes to denied / traversal / absolute paths", async () => {
    const { engine } = makeEngine();
    for (const file of [".env", "../../etc/passwd", "/etc/passwd"]) {
      const v = await engine.evaluate({ tool: "Write", file });
      expect(v.decision, file).toBe("deny");
    }
  });

  it("fails closed on unknown tools", async () => {
    const { engine } = makeEngine();
    const v = await engine.evaluate({ tool: "MysteryTool", command: "whatever" } as ToolCall);
    expect(v.decision).toBe("deny");
    expect(v.ruleId).toBe("fail-closed");
  });
});

describe("GovernanceEngine.evaluate — allow", () => {
  it("allows in-scope commands and paths", async () => {
    const { engine } = makeEngine();
    expect((await engine.evaluate({ tool: "Bash", command: "git status" })).decision).toBe("allow");
    expect((await engine.evaluate({ tool: "Write", file: "src/x.ts" })).decision).toBe("allow");
  });

  it("allows read-only tools", async () => {
    const { engine } = makeEngine();
    expect((await engine.evaluate({ tool: "Read", file: "anything" })).decision).toBe("allow");
  });
});

describe("GovernanceEngine.evaluate — ask", () => {
  it("asks for sensitive commands and records a pending id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aigov-appr-"));
    const approvals = new ApprovalStore(dir);
    const { engine } = makeEngine({ approvals });
    const v = await engine.evaluate({ tool: "Bash", command: "git push origin main" });
    expect(v.decision).toBe("ask");
    expect(v.pendingId).toBeTruthy();
    const pending = await approvals.listPending();
    expect(pending.map((p) => p.id)).toContain(v.pendingId);
  });
});

describe("GovernanceEngine — every verdict is audited", () => {
  it("writes one hash-chained record per evaluation", async () => {
    const { engine, sink } = makeEngine();
    await engine.evaluate({ tool: "Bash", command: "git status" });
    await engine.evaluate({ tool: "Bash", command: "rm -rf /" });
    const records = sink.read();
    expect(records.length).toBe(2);
    expect(verifyChain([...records]).ok).toBe(true);
  });

  it("fails closed when the audit sink throws", async () => {
    const failing = { append: async () => { throw new Error("disk full"); } };
    const engine = new GovernanceEngine({
      scope: new ScopeValidator(realPolicy),
      audit: new AuditLog(failing, NOW, "test"),
      now: NOW,
    });
    const v = await engine.evaluate({ tool: "Bash", command: "git status" });
    expect(v.decision).toBe("deny");
    expect(v.ruleId).toBe("audit-fail-closed");
  });
});

describe("GovernanceEngine — one-time approval closes the loop", () => {
  let approvals: ApprovalStore;
  beforeEach(async () => {
    approvals = new ApprovalStore(await mkdtemp(join(tmpdir(), "aigov-loop-")));
  });

  it("ask -> grant -> allow once -> ask again", async () => {
    const { engine } = makeEngine({ approvals });
    const call: ToolCall = { tool: "Bash", command: "git push origin main" };

    const first = await engine.evaluate(call);
    expect(first.decision).toBe("ask");

    await approvals.grant(first.pendingId!, "human", NOW);

    const second = await engine.evaluate(call);
    expect(second.decision).toBe("allow");
    expect(second.ruleId).toBe("token");

    // Token is one-time: a repeat goes back to ask.
    const third = await engine.evaluate(call);
    expect(third.decision).toBe("ask");
  });
});

describe("FileAuditSink — tamper detection", () => {
  it("verifyChain fails after a record is edited on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aigov-audit-"));
    const path = join(dir, "audit.jsonl");
    const log = new AuditLog(new FileAuditSink(path), NOW, "test");
    await log.record("INTERCEPT", "a");
    await log.record("INTERCEPT", "b");
    await log.record("INTERCEPT", "c");

    const clean = await readChain(path);
    expect(verifyChain(clean).ok).toBe(true);

    // Tamper: flip the action of the middle record without fixing hashes.
    const raw = await readFile(path, "utf8");
    const tampered = raw.replace('"action":"b"', '"action":"HACKED"');
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, tampered, "utf8");

    const res = verifyChain(await readChain(path));
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(2);
  });
});

describe("GovernanceEngine — mass-delete", () => {
  it("denies find -delete even though `find` is on the allow-list", async () => {
    const { engine } = makeEngine();
    const v = await engine.evaluate({ tool: "Bash", command: "find . -delete" });
    expect(v.decision).toBe("deny");
    expect(v.ruleId).toBe("mass-delete");
  });
});

describe("audit anchoring — detects whole-file deletion/rebuild", () => {
  it("anchored head verifies against the chain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aigov-anchor-"));
    const path = join(dir, "audit.jsonl");
    const anchorFile = join(dir, "audit.anchor");
    const log = new AuditLog(new FileAuditSink(path), NOW, "test");
    await log.record("INTERCEPT", "a");
    await log.record("INTERCEPT", "b");
    const head = await log.record("INTERCEPT", "c");

    await writeAnchor(anchorFile, { seq: head.seq, hash: head.hash }, NOW);

    const res = verifyAgainstAnchor(await readChain(path), await readAnchors(anchorFile));
    expect(res.ok).toBe(true);
    expect(res.checked).toBe(1);
  });

  it("flags a rebuilt/truncated log that drops the anchored record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aigov-anchor-"));
    const path = join(dir, "audit.jsonl");
    const anchorFile = join(dir, "audit.anchor");
    const log = new AuditLog(new FileAuditSink(path), NOW, "test");
    await log.record("INTERCEPT", "a");
    await log.record("INTERCEPT", "b");
    const head = await log.record("INTERCEPT", "c");
    await writeAnchor(anchorFile, { seq: head.seq, hash: head.hash }, NOW);

    // Attacker wipes the log and rebuilds a shorter, internally consistent chain.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "", "utf8");
    const rebuilt = new AuditLog(new FileAuditSink(path), NOW, "test");
    await rebuilt.record("INTERCEPT", "innocent");

    const chain = await readChain(path);
    expect(verifyChain(chain).ok).toBe(true); // internal chain looks fine…
    const res = verifyAgainstAnchor(chain, await readAnchors(anchorFile));
    expect(res.ok).toBe(false); // …but the anchor catches the rebuild.
    expect(res.brokenAt).toBe(3);
  });

  it("an old anchor stays valid as the chain legitimately grows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aigov-anchor-"));
    const path = join(dir, "audit.jsonl");
    const anchorFile = join(dir, "audit.anchor");
    const log = new AuditLog(new FileAuditSink(path), NOW, "test");
    await log.record("INTERCEPT", "a");
    const mid = await log.record("INTERCEPT", "b");
    await writeAnchor(anchorFile, { seq: mid.seq, hash: mid.hash }, NOW);

    await log.record("INTERCEPT", "c");
    await log.record("INTERCEPT", "d");

    const res = verifyAgainstAnchor(await readChain(path), await readAnchors(anchorFile));
    expect(res.ok).toBe(true);
    expect(res.checked).toBe(1);
  });
});

describe("GovernanceEngine — shell writes obey the path policy", () => {
  it("denies redirect/tee/sed/cp to out-of-scope paths", async () => {
    const { engine } = makeEngine();
    for (const command of [
      "echo pwned > /etc/passwd",
      "echo x | tee /etc/hosts",
      "sed -i 's/x/y/' /etc/shadow",
      "cp secret ~/.ssh/authorized_keys",
    ]) {
      const v = await engine.evaluate({ tool: "Bash", command });
      expect(v.decision, command).toBe("deny");
      expect(v.ruleId, command).toBe("path-in-command");
    }
  });

  it("allows in-tree redirection", async () => {
    const { engine } = makeEngine();
    const v = await engine.evaluate({ tool: "Bash", command: "echo x > build.log" });
    expect(v.decision).toBe("allow");
  });
});

describe("GovernanceEngine — general-purpose executors escalate to ask", () => {
  it("asks before running interpreters and build tools", async () => {
    const approvals = new ApprovalStore(await mkdtemp(join(tmpdir(), "aigov-elev-")));
    const { engine } = makeEngine({ approvals });
    for (const command of ["node build.js", "npm run build", "make deploy", "X=node; $X evil.js"]) {
      const v = await engine.evaluate({ tool: "Bash", command });
      expect(v.decision, command).toBe("ask");
      expect(v.ruleId, command).toBe("ask-elevated");
      expect(v.pendingId, command).toBeTruthy();
    }
  });

  it("does not escalate non-executor commands", async () => {
    const { engine } = makeEngine();
    expect((await engine.evaluate({ tool: "Bash", command: "git status" })).decision).toBe("allow");
  });
});

describe("GovernanceEngine — self-protection", () => {
  function guarded(approvals?: ApprovalStore) {
    return new GovernanceEngine({
      scope: new ScopeValidator(realPolicy),
      audit: new AuditLog(new InMemoryAuditSink(), NOW, "test"),
      approvals,
      protectedPaths: ["/opt/aigov", ".aigov", "engine.js"],
      askCommands: ["git push"],
      now: NOW,
    });
  }

  it("denies writing to its own files", async () => {
    const v = await guarded().evaluate({ tool: "Write", file: "src/engine.js" });
    expect(v.decision).toBe("deny");
    expect(v.ruleId).toBe("self-protect");
  });

  it("denies shell tampering with its own files", async () => {
    const v = await guarded().evaluate({ tool: "Bash", command: "echo x > /opt/aigov/policy.json" });
    expect(v.decision).toBe("deny");
    expect(v.ruleId).toBe("self-protect");
  });

  it("a granted token cannot override self-protection", async () => {
    const approvals = new ApprovalStore(await mkdtemp(join(tmpdir(), "aigov-self-")));
    const call: ToolCall = { tool: "Bash", command: "sed -i s/x/y/ /opt/aigov/engine.js" };
    await approvals.grant(signatureId(call), "human", NOW);
    const v = await guarded(approvals).evaluate(call);
    expect(v.decision).toBe("deny");
    expect(v.ruleId).toBe("self-protect");
  });
});

describe("GovernanceEngine — approval token TTL", () => {
  it("an expired token is not honored and the operation goes back to ask", async () => {
    const approvals = new ApprovalStore(await mkdtemp(join(tmpdir(), "aigov-ttl-")));
    const call: ToolCall = { tool: "Bash", command: "git push origin main" };
    // Granted at t0 with a 1s TTL.
    await approvals.grant(signatureId(call), "human", () => "2026-07-29T00:00:00.000Z", 1000);

    // Engine clock is one hour later — the token has expired.
    const later = () => "2026-07-29T01:00:00.000Z";
    const engine = new GovernanceEngine({
      scope: new ScopeValidator(realPolicy),
      audit: new AuditLog(new InMemoryAuditSink(), later, "test"),
      approvals,
      askCommands: ["git push"],
      now: later,
    });

    const v = await engine.evaluate(call);
    expect(v.decision).toBe("ask");
    // Expired token is cleaned up on consume.
    expect(await approvals.hasToken(call, later)).toBe(false);
  });
});

