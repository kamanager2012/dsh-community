# governor-core — Threat Model

This document states, without euphemism, what `governor-core` defends against and
what it does not. If you are deciding whether to rely on it, read this first.

## 1. What governor-core is

A **deterministic policy & accountability layer** for AI coding agents. It
intercepts tool calls at a host integration point (today: the Claude Code
`PreToolUse` hook), returns `allow` / `deny` / `ask`, and records every verdict to
a hash-chained audit log. A denied action does not run, and every action is
accountable.

It is a **guardrail**, not a **security boundary**.

## 2. The reference-monitor test

A true enforcement boundary must satisfy three classic properties
(Saltzer & Schroeder):

1. **Complete mediation** — every dangerous action passes through the checkpoint.
2. **Tamper-proof** — the checkpoint cannot be bypassed or disabled.
3. **Verifiable** — the core is small enough to audit.

governor-core satisfies (3). It **cannot** satisfy (1) or (2), by construction:

> It judges the **command string**, but the OS executes at the **syscall layer**,
> and the command allow-list necessarily contains general-purpose executors
> (`node`, `python3`, `make`, …). There is an irreducible gap between "what the
> matcher thinks a command does" and "what the shell actually does." The governor
> also runs **inside the same blast radius** (same filesystem, same host) it is
> trying to contain.

## 3. In scope — the cooperative-agent boundary

Against an agent that is *trying to behave* but drifts, hallucinates, or makes
mistakes, governor-core is genuinely effective and is tested against these:

- Destructive commands: `rm -rf /`, `rm -rf ~`, `mkfs`, `dd if=…of=/dev/sda`.
- Command-chain / substitution smuggling: `git status; rm -rf /`,
  `echo $(rm -rf /)`, backtick bodies, nested substitution.
- Simple variable-indirection: `X=rm; $X -rf /`, `A=rm; B=$A; $B …`.
- Mass-deletion semantics even for allow-listed tools: `find . -delete`,
  `find … -exec rm`, `shred`, `rm -rf *`.
- Path escapes for file tools and shell write targets: writes to `/etc/passwd`,
  `~/.ssh/authorized_keys`, `../../…`, `.env`, `secrets/**` — via redirection,
  `tee`, `sed -i`, `cp`/`mv`/`ln`/`install`, `dd of=`.
- Inline eval on allow-listed interpreters: `node -e`, `python3 -c`, `deno eval`.
- Self-tampering with the governor's own files (inviolable, checked before any
  approval token).
- Accountability: every verdict is written to a tamper-evident chain; an
  audit-write failure fails the action closed.

## 4. Out of scope — the adversarial-agent reality

Against an agent (or injected/hostile code) that is *actively trying to escape*,
the command layer is **advisory**. The following are known, accepted bypasses.
They are registered here and asserted in `tests/adversarial.test.ts` so nobody is
misled.

| # | Bypass class | Example | Why it works |
|---|--------------|---------|--------------|
| 1 | Interpreter via stdin | `echo '<code>' \| python3` | Interpreter head is allow-listed; no `-c`/`-e` to match; stdin code executes |
| 2 | Interpreter via script file | `node evil.js` (evil.js written in-tree first) | Allow-listed interpreter + allowed in-tree write = arbitrary execution |
| 3 | Build-tool lifecycle | `npm run x`, `make`, `cargo run`, `go run` | These execute shell defined in project config the governor never inspects |
| 4 | Symlink / name aliasing | in-tree `build/` → symlink to `/etc` | Path policy matches strings, not resolved `realpath`; TOCTOU |
| 5 | Governor self-disable | code (via #1/#2) rewrites `~/.claude/settings.json` | The governor cannot protect its own activation from arbitrary code |
| 6 | Audit erasure | code (via #1/#2) truncates/deletes the audit log | Chain is tamper-*evident*, not tamper-*proof*; mitigated only by external anchors (§5) |
| 7 | Host blind spots | `Task` sub-agent tool; `allow` reliability | Upstream: `PreToolUse` does not gate `Task` ([#26923]); `allow` has been unreliable ([#52822]) |

The root cause of #1–#3 is singular: **allowing a general-purpose interpreter or
build tool is equivalent to allowing arbitrary code.** Inline-eval denial is a
speed bump, not a wall.

**Partial mitigation (shipped).** The default `policy.json` now lists these
executors in `elevatedCommands` and the engine escalates any command that invokes
one to `ask` (`ruleId: ask-elevated`), so a human sees every `node`/`python3`/
`make`/`npm`/`cargo`/… invocation before it runs. Against a **cooperative** agent
this converts #1–#3 from silent bypasses into human-gated actions. It is **not** a
fix for an adversarial agent: a determined attacker can still get code to run once
a human approves any interpreter, and habitual approval (rubber-stamping) erodes
the check. Teams that find the prompts too intrusive can set `elevatedCommands: []`
to restore silent allow — at the cost of this mitigation.

## 5. Audit tamper-resistance and its limits

The audit log is a SHA-256 hash chain: any edit, reorder, or deletion of an
existing record is detected by `verifyChain`. But a whole-file delete-and-rebuild
produces a new, internally consistent chain that `verifyChain` alone accepts.

**External anchors** (`aigov anchor`) mitigate this by pinning the chain head
`(seq → hash)` into a separate store; `aigov log --verify` then cross-checks it
(`verifyAgainstAnchor`). A rebuilt or truncated log no longer contains the
anchored record and is flagged.

This only helps to the degree the anchor store is out of the agent's reach:

- **Weak:** default `~/.aigov-anchors/` — survives `rm -rf ~/.aigov` but not a
  determined local attacker.
- **Strong:** replicate the anchor to a **remote / WORM / read-only** sink. That
  is the only configuration that meaningfully resists an adversary with local
  write access.

## 6. Fail-closed is delegated at the edge

Internally, governor-core fails closed: unclassifiable tool → deny, audit-write
failure → deny, expired/absent token → ask/deny. But the **final enforcement**
depends on the host honoring the hook's verdict. If the host times out, crashes,
treats a hook error as "allow", or the user disables the hook, enforcement is
gone. That decision lives outside governor-core's trust boundary.

## 7. Recommended deployment

- **Trusted / semi-trusted agent, developer workstation:** governor-core alone is
  a reasonable guardrail + audit trail. Enable external anchoring to a remote
  store.
- **Untrusted code, CI, shared infrastructure, anything adversarial:** run the
  agent inside an **OS-level sandbox** (container with read-only mounts,
  seccomp/eBPF syscall filtering, AppArmor/SELinux, a restricted user). The
  sandbox enforces at the syscall layer regardless of command obfuscation;
  governor-core then serves as the auditable **policy brain** feeding it.

## 8. Roadmap toward a real boundary

The honest path to "unbypassable" is to move enforcement off the string and onto
the effect:

- syscall-level path enforcement (FUSE / LSM / eBPF) so write policy holds
  regardless of how the command was written;
- treating allow-listed interpreters/build tools as arbitrary-execution and
  gating them behind `ask` or a sandbox, not the command matcher;
- `realpath` resolution to close the symlink/TOCTOU gap;
- first-class remote anchor sinks.

Until then: **cooperative agent = inside the boundary; adversarial agent = needs
defense in depth.**

## Reporting

Security issues: see [SECURITY.md](../SECURITY.md).

[#26923]: https://github.com/anthropics/claude-code/issues/26923
[#52822]: https://github.com/anthropics/claude-code/issues/52822
