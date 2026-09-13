#!/usr/bin/env node
// governor-core — CLI: approve pending operations and inspect the audit chain.
//
//   aigov approve <id>          grant a one-time token for a pending operation
//   aigov pending               list operations awaiting approval
//   aigov log [--verify]        print the audit chain; --verify checks integrity
//                               (and cross-checks external anchors if present)
//   aigov anchor                pin the current chain head to the anchor store
//
// Env:
//   AIGOV_APPROVALS  approval store dir  (default ~/.aigov/approvals)
//   AIGOV_AUDIT      audit log path      (default ~/.aigov/audit.jsonl)
//   AIGOV_ANCHOR     anchor file path    (default ~/.aigov-anchors/audit.anchor)
//                    Put this out of the agent's reach — ideally remote/WORM —
//                    so whole-file deletion of the audit log is detectable.

import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { ApprovalStore } from "./approval.js";
import { readChain, verifyChain, writeAnchor, readAnchors, verifyAgainstAnchor } from "./audit.js";

function approvalsDir(): string {
  return process.env.AIGOV_APPROVALS ?? join(homedir(), ".aigov", "approvals");
}
function auditPath(): string {
  return process.env.AIGOV_AUDIT ?? join(homedir(), ".aigov", "audit.jsonl");
}
function anchorPath(): string {
  // Default deliberately lives outside ~/.aigov so wiping the audit dir does not
  // also erase the anchor. A remote/read-only store is stronger still.
  return process.env.AIGOV_ANCHOR ?? join(homedir(), ".aigov-anchors", "audit.anchor");
}
function now(): string {
  return new Date().toISOString();
}

async function cmdApprove(id: string): Promise<number> {
  if (!id) {
    console.error("usage: aigov approve <id>");
    return 2;
  }
  const store = new ApprovalStore(approvalsDir());
  const pending = await store.listPending();
  const match = pending.find((p) => p.id === id);
  if (!match) {
    console.error(`no pending request with id "${id}". Run \`aigov pending\` to list.`);
    return 1;
  }
  const who = safeUser();
  await store.grant(id, who, now);
  console.log(`granted one-time approval for ${match.tool} (${id}).`);
  console.log(`the next matching operation will be allowed once, then the token is consumed.`);
  return 0;
}

async function cmdPending(): Promise<number> {
  const store = new ApprovalStore(approvalsDir());
  const pending = await store.listPending();
  if (pending.length === 0) {
    console.log("no pending approvals.");
    return 0;
  }
  for (const p of pending) {
    const target = p.command ?? p.file ?? "";
    console.log(`${p.id}  ${p.tool}  ${target}`);
    console.log(`         reason: ${p.reason}`);
    console.log(`         since:  ${p.createdAt}`);
  }
  console.log(`\napprove with: aigov approve <id>`);
  return 0;
}

async function cmdLog(verify: boolean): Promise<number> {
  const records = await readChain(auditPath());
  for (const r of records) {
    const e = r.event;
    console.log(`#${r.seq}  ${e.timestamp}  ${e.mode}  ${e.action}${e.reason ? `  — ${e.reason}` : ""}`);
  }
  if (verify) {
    const res = verifyChain(records);
    if (!res.ok) {
      console.error(`\nCHAIN BROKEN at seq ${res.brokenAt}: ${res.error}`);
      return 1;
    }
    console.log(`\nchain OK: ${res.count} record(s), integrity verified.`);
    const anchors = await readAnchors(anchorPath());
    if (anchors.length === 0) {
      console.log(`no anchors found at ${anchorPath()} — run \`aigov anchor\` to pin the head.`);
      return 0;
    }
    const av = verifyAgainstAnchor(records, anchors);
    if (!av.ok) {
      console.error(`ANCHOR MISMATCH at seq ${av.brokenAt}: ${av.error}`);
      return 1;
    }
    console.log(`anchors OK: ${av.checked} anchor(s) matched against the chain.`);
  }
  return 0;
}

async function cmdAnchor(): Promise<number> {
  const records = await readChain(auditPath());
  const head = records[records.length - 1];
  if (!head) {
    console.log("audit chain is empty — nothing to anchor.");
    return 0;
  }
  const anchor = await writeAnchor(anchorPath(), { seq: head.seq, hash: head.hash }, now);
  console.log(`anchored head: seq ${anchor.seq} hash ${anchor.hash.slice(0, 16)}… -> ${anchorPath()}`);
  console.log(`for real protection, replicate this file to a remote/read-only store.`);
  return 0;
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "approve":
      return cmdApprove(rest[0] ?? "");
    case "pending":
      return cmdPending();
    case "log":
      return cmdLog(rest.includes("--verify"));
    case "anchor":
      return cmdAnchor();
    default:
      console.error("usage: aigov <approve|pending|log|anchor> [args]");
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
