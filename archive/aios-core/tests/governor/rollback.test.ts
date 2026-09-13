import { describe, it, expect, afterEach } from "vitest";
import { Rollback } from "../../governor/rollback.js";
import { MemoryStore } from "../../memory/index.js";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = () => "2026-06-14T00:00:00Z";

let tmpDir: string;

function makeDeps() {
  tmpDir = mkdtempSync(join(tmpdir(), "rb-test-"));
  const memory = new MemoryStore({ root: tmpDir });
  const commands: string[] = [];
  const deps = {
    runCommand: async (cmd: string) => {
      commands.push(cmd);
      return { ok: true, stdout: "", stderr: "" };
    },
    memory,
    now: NOW,
  };
  return { rb: new Rollback(deps), commands, memory };
}

afterEach(async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} });

describe("Rollback", () => {
  it("restore runs git restore with -- separator", async () => {
    const { rb, commands } = makeDeps();
    const result = await rb.restore(["src/a.ts"]);
    expect(result.ok).toBe(true);
    expect(result.method).toBe("restore");
    // `--` guards against paths beginning with "-" being parsed as flags
    expect(commands[0]).toBe("git restore -- src/a.ts");
  });

  it("restore without paths is a safe no-op (never git restore .)", async () => {
    // Regression: restore() used to default to ".", which reverts the whole
    // working tree and destroys unrelated uncommitted user work.
    const { rb, commands } = makeDeps();
    const result = await rb.restore();
    expect(result.ok).toBe(true);
    expect(result.method).toBe("none");
    expect(commands.length).toBe(0);
    expect(result.reason).toContain("no paths");
  });

  it("restore with empty paths is a safe no-op", async () => {
    const { rb, commands } = makeDeps();
    const result = await rb.restore([]);
    expect(result.method).toBe("none");
    expect(commands.length).toBe(0);
  });

  it("revert runs git revert", async () => {
    const { rb, commands } = makeDeps();
    const result = await rb.revert("abc123");
    expect(result.ok).toBe(true);
    expect(result.method).toBe("revert");
    expect(commands[0]).toContain("git revert --no-edit abc123");
  });

  it("snapshot creates a memory snapshot", async () => {
    const { rb, memory } = makeDeps();
    const id = await rb.snapshot();
    expect(id).toBeTruthy();
    const c = memory.count();
    expect(c.snapshots).toBeGreaterThanOrEqual(1);
  });

  it("undo fails when no snapshots exist", async () => {
    const { rb } = makeDeps();
    const result = await rb.undo();
    expect(result.ok).toBe(false);
    expect(result.method).toBe("undo");
    expect(result.reason).toContain("no snapshot");
  });

  it("undo restores from last snapshot", async () => {
    const { rb } = makeDeps();
    await rb.snapshot();
    const result = await rb.undo();
    expect(result.ok).toBe(true);
    expect(result.method).toBe("snapshot");
  });
});
