import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const harness = join(repoRoot, "scripts/codex-shadow-capture.mjs");

function createFakeCodex(root: string): string {
  const path = join(root, "fake-codex.mjs");
  writeFileSync(path, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  console.log("codex-cli 0.fake");
  process.exit(0);
}

if (process.env.FAKE_CODEX_ARGS_FILE) {
  writeFileSync(process.env.FAKE_CODEX_ARGS_FILE, JSON.stringify(args), "utf8");
}

const workspaceIndex = args.indexOf("--cd");
const workspace = workspaceIndex >= 0 ? args[workspaceIndex + 1] : undefined;
const mode = process.env.FAKE_CODEX_MODE ?? "success";
if (mode === "side-effect" && workspace) {
  writeFileSync(new URL("mutated.txt", \`file://\${workspace}/\`), "unexpected", "utf8");
}

const events = [
  { type: "thread.started", thread_id: "fake-thread" },
  { type: "turn.started" },
];
if (mode === "tool") {
  events.push({
    type: "item.completed",
    item: {
      id: "cmd-1",
      type: "command_execution",
      command: "echo should-not-run",
      aggregated_output: "",
      exit_code: 0,
      status: "completed",
    },
  });
}
events.push({
  type: "item.completed",
  item: {
    id: "msg-1",
    type: "agent_message",
    text: mode === "wrong-message" ? "WRONG" : "AIOS_CAPTURE_OK",
  },
});
events.push({
  type: "turn.completed",
  usage: {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 3,
    reasoning_output_tokens: 0,
  },
});
for (const event of events) console.log(JSON.stringify(event));
`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function runHarness(options: { mode?: string; extraArgs?: string[]; prefillOut?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "aios-codex-capture-test-"));
  const fakeCodex = createFakeCodex(root);
  const out = join(root, "capture");
  if (options.prefillOut) {
    mkdirSync(out);
    writeFileSync(join(out, "existing.txt"), "do not overwrite", "utf8");
  }
  const argsFile = join(root, "args.json");
  const args = [
    harness,
    "--model",
    "gpt-test",
    "--out",
    out,
    "--codex",
    fakeCodex,
    ...(options.extraArgs ?? []),
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_CODEX_MODE: options.mode ?? "success",
      FAKE_CODEX_ARGS_FILE: argsFile,
    },
  });
  return { root, out, argsFile, result };
}

describe("Codex shadow capture harness", () => {
  it("captures the fixed no-tool canary with fail-closed CLI flags", () => {
    const { out, argsFile, result } = runHarness();
    expect(result.status).toBe(0);

    const provenance = JSON.parse(readFileSync(join(out, "provenance.json"), "utf8"));
    expect(provenance.passed).toBe(true);
    expect(provenance.codexVersion).toBe("codex-cli 0.fake");
    expect(provenance.requestedModel).toBe("gpt-test");
    expect(provenance.checks).toEqual({
      processExitZero: true,
      jsonlWellFormed: true,
      terminalTurnObserved: true,
      noToolEvents: true,
      exactCanaryMessage: true,
      temporaryWorkspaceUnchanged: true,
    });
    expect(provenance.safetyProfile).toMatchObject({
      workspace: "isolated-empty-temporary-directory",
      prompt: "fixed-no-tool-canary",
      ephemeral: true,
      ignoreUserConfig: true,
      ignoreRules: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      webSearch: "disabled",
      bypassApprovalsAndSandbox: false,
    });

    const codexArgs = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    expect(codexArgs).toContain("--strict-config");
    expect(codexArgs).toContain("--skip-git-repo-check");
    expect(codexArgs).toContain("--ephemeral");
    expect(codexArgs).toContain("--ignore-user-config");
    expect(codexArgs).toContain("--ignore-rules");
    expect(codexArgs).toContain("--json");
    expect(codexArgs).toContain("read-only");
    expect(codexArgs).toContain('approval_policy="never"');
    expect(codexArgs).toContain('web_search="disabled"');
    expect(codexArgs).not.toContain("--approve-for-me");
    expect(codexArgs).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(codexArgs.at(-1)).toContain("AIOS_CAPTURE_OK");
  });

  it("fails closed when Codex emits any tool event during the no-tool canary", () => {
    const { out, result } = runHarness({ mode: "tool" });
    expect(result.status).toBe(3);
    const provenance = JSON.parse(readFileSync(join(out, "provenance.json"), "utf8"));
    expect(provenance.passed).toBe(false);
    expect(provenance.checks.noToolEvents).toBe(false);
    expect(provenance.canary.toolEventCount).toBe(1);
  });

  it("fails closed when the isolated temporary workspace is modified", () => {
    const { out, result } = runHarness({ mode: "side-effect" });
    expect(result.status).toBe(3);
    const provenance = JSON.parse(readFileSync(join(out, "provenance.json"), "utf8"));
    expect(provenance.passed).toBe(false);
    expect(provenance.checks.temporaryWorkspaceUnchanged).toBe(false);
    expect(provenance.workspaceEntries).toContainEqual({
      path: "mutated.txt",
      type: "file",
      size: 10,
    });
  });

  it("fails closed when the final agent message does not match the fixed canary", () => {
    const { out, result } = runHarness({ mode: "wrong-message" });
    expect(result.status).toBe(3);
    const provenance = JSON.parse(readFileSync(join(out, "provenance.json"), "utf8"));
    expect(provenance.checks.exactCanaryMessage).toBe(false);
  });

  it("refuses prompt/sandbox extension arguments instead of becoming a generic Codex runner", () => {
    const { result } = runHarness({ extraArgs: ["--prompt", "do something else"] });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unsupported argument: --prompt");
  });

  it("refuses to overwrite a non-empty capture directory", () => {
    const { result } = runHarness({ prefillOut: true });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--out must be empty");
  });
});
