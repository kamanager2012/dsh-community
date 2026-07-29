import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore } from "../src/approval.js";
import { FileAuditSink, readChain, verifyChain } from "../src/audit.js";
import type { ToolCall } from "../src/types.js";

const now = () => new Date().toISOString();

describe("concurrency safety", () => {
  it("consume is atomic: a granted token is honored at most once under a race", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aigov-conc-"));
    const store = new ApprovalStore(dir);
    const call: ToolCall = { tool: "Bash", command: "git push" };
    await store.recordPending(call, "needs approval", now);
    const id = (await store.listPending())[0]!.id;
    await store.grant(id, "tester", now);

    // 20 concurrent consumers race for one token.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.consume(call, now)),
    );

    expect(results.filter(Boolean).length).toBe(1);
    expect(await store.hasToken(call, now)).toBe(false);
  });

  it("append is serialized: concurrent audit writes form an unbroken chain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aigov-conc-"));
    const path = join(dir, "audit.jsonl");
    const sink = new FileAuditSink(path);
    const N = 30;

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        sink.append({ mode: "INTERCEPT", actor: "t", action: `a${i}`, timestamp: now() }),
      ),
    );

    const chain = await readChain(path);
    expect(chain.length).toBe(N);
    expect(verifyChain(chain).ok).toBe(true);
    // Sequence numbers are unique and contiguous 1..N.
    expect(new Set(chain.map((r) => r.seq)).size).toBe(N);
    expect(Math.max(...chain.map((r) => r.seq))).toBe(N);
  });
});
