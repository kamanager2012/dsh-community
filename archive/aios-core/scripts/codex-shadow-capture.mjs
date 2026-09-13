#!/usr/bin/env node

// AIOS Core — safe Codex shadow capture harness.
//
// This script captures one real, non-mutating Codex exec JSONL canary run in an
// isolated temporary workspace. It never points Codex at the project under test,
// never accepts a custom prompt, and never enables sandbox/approval bypasses.
//
// The resulting raw JSONL is intended for offline ingestion through
// aios-core/codex + aios-core/codex/evidence.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CANARY = "AIOS_CAPTURE_OK";
const FIXED_PROMPT = [
  `Reply with exactly ${CANARY}.`,
  "Do not call tools, execute commands, read files, search the web, or modify anything.",
].join(" ");

function usage() {
  console.error(
    "Usage: node scripts/codex-shadow-capture.mjs --model <model> --out <directory> [--codex <path>]",
  );
}

function parseArgs(argv) {
  const result = { codex: "codex", model: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model" || arg === "--out" || arg === "--codex") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
      if (arg === "--model") result.model = value;
      else if (arg === "--out") result.out = value;
      else result.codex = value;
      continue;
    }
    throw new Error(`unsupported argument: ${arg}`);
  }

  if (!result.model) throw new Error("--model is required");
  if (!result.out) throw new Error("--out is required");
  if (!/^[A-Za-z0-9._:/-]+$/.test(result.model)) throw new Error("--model contains unsupported characters");
  return result;
}

function listWorkspaceEntries(root) {
  if (!existsSync(root)) return [];
  const entries = [];
  const walk = (dir, prefix = "") => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = statSync(full);
      entries.push({ path: relative, type: stat.isDirectory() ? "directory" : "file", size: stat.size });
      if (stat.isDirectory()) walk(full, relative);
    }
  };
  walk(root);
  return entries;
}

function parseJsonl(raw) {
  const events = [];
  const malformedLines = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        malformedLines.push(i + 1);
      } else {
        events.push(value);
      }
    } catch {
      malformedLines.push(i + 1);
    }
  }
  return { events, malformedLines };
}

function inspectCanary(events) {
  let turnsCompleted = 0;
  let fatalErrors = 0;
  let toolEventCount = 0;
  const agentMessages = [];

  for (const event of events) {
    if (event.type === "turn.completed") turnsCompleted++;
    if (event.type === "turn.failed" || event.type === "error") fatalErrors++;
    if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
      const item = event.item;
      if (!item || typeof item !== "object") continue;
      if (item.type === "agent_message" && typeof item.text === "string") agentMessages.push(item.text);
      if (["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(item.type)) {
        toolEventCount++;
      }
    }
  }

  return {
    turnsCompleted,
    fatalErrors,
    toolEventCount,
    finalAgentMessage: agentMessages.at(-1) ?? null,
  };
}

function ensureOutputDirectory(outDir) {
  if (existsSync(outDir)) {
    if (!statSync(outDir).isDirectory()) throw new Error(`--out is not a directory: ${outDir}`);
    if (readdirSync(outDir).length > 0) throw new Error(`--out must be empty: ${outDir}`);
  } else {
    mkdirSync(outDir, { recursive: true });
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exitCode = 2;
    return;
  }

  const outDir = resolve(args.out);
  try {
    ensureOutputDirectory(outDir);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  const versionProbe = spawnSync(args.codex, ["--version"], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (versionProbe.error || versionProbe.status !== 0) {
    console.error(`unable to execute Codex binary: ${args.codex}`);
    process.exitCode = 2;
    return;
  }
  const codexVersion = versionProbe.stdout.trim() || "unknown";

  const tempRoot = mkdtempSync(join(tmpdir(), "aios-codex-shadow-"));
  const workspace = join(tempRoot, "workspace");
  mkdirSync(workspace);

  const codexArgs = [
    "exec",
    "--strict-config",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--json",
    "--sandbox",
    "read-only",
    "--model",
    args.model,
    "--cd",
    workspace,
    "--config",
    'approval_policy="never"',
    "--config",
    'web_search="disabled"',
    "--",
    FIXED_PROMPT,
  ];

  const startedAt = new Date().toISOString();
  const run = spawnSync(args.codex, codexArgs, {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  const completedAt = new Date().toISOString();

  const rawJsonl = run.stdout ?? "";
  const { events, malformedLines } = parseJsonl(rawJsonl);
  const canary = inspectCanary(events);
  const workspaceEntries = listWorkspaceEntries(workspace);

  const checks = {
    processExitZero: run.status === 0 && !run.error,
    jsonlWellFormed: malformedLines.length === 0 && events.length > 0,
    terminalTurnObserved: canary.turnsCompleted > 0 && canary.fatalErrors === 0,
    noToolEvents: canary.toolEventCount === 0,
    exactCanaryMessage: canary.finalAgentMessage === CANARY,
    temporaryWorkspaceUnchanged: workspaceEntries.length === 0,
  };
  const passed = Object.values(checks).every(Boolean);

  writeFileSync(join(outDir, "codex.jsonl"), rawJsonl, "utf8");
  writeFileSync(
    join(outDir, "provenance.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "aios-codex-shadow-capture",
      codexVersion,
      requestedModel: args.model,
      startedAt,
      completedAt,
      processExitCode: run.status,
      processSignal: run.signal,
      stderrBytes: Buffer.byteLength(run.stderr ?? "", "utf8"),
      eventCount: events.length,
      malformedLines,
      canary,
      workspaceEntries,
      checks,
      passed,
      safetyProfile: {
        workspace: "isolated-empty-temporary-directory",
        prompt: "fixed-no-tool-canary",
        ephemeral: true,
        ignoreUserConfig: true,
        ignoreRules: true,
        sandbox: "read-only",
        approvalPolicy: "never",
        webSearch: "disabled",
        bypassApprovalsAndSandbox: false,
      },
      host: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
      },
    }, null, 2)}\n`,
    "utf8",
  );

  rmSync(tempRoot, { recursive: true, force: true });

  if (!passed) {
    console.error("Codex shadow capture failed closed; inspect provenance.json and codex.jsonl.");
    process.exitCode = 3;
    return;
  }

  console.log(`Codex shadow capture PASS: ${outDir}`);
}

main();
