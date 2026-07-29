# Security Policy

`governor-core` is a policy & accountability layer, and we hold its own behavior
to a high bar. This document covers how to report vulnerabilities and what the
tool does and does not defend against. The authoritative, detailed threat register
lives in [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md).

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub Security Advisories:
<https://github.com/kamanager2012/governor-core/security/advisories/new>

Include, where possible:

- affected version / commit,
- a minimal reproduction (e.g. a `ToolCall` or command string that is wrongly
  allowed or denied),
- the expected vs. actual verdict, and
- impact.

We aim to acknowledge within 72 hours and to ship a fix or mitigation for
confirmed high-severity issues promptly. Coordinated disclosure is appreciated.

### What we consider a vulnerability

- A **bypass**: a tool call that should be denied but is allowed (e.g. a new
  command-obfuscation technique that evades the scope checks).
- A **fail-open**: any path where an error results in `allow` instead of `deny`.
- **Audit tampering** that `verifyChain` fails to detect.
- **Token misuse**: a granted one-time token that authorizes an unrelated
  operation, is honored more than once, or survives its TTL.
- **Self-protection escape**: mutating governor-core's own files/state despite
  the self-protection rule.

## Threat model

`governor-core` is a **deterministic, fail-closed policy layer** at the agent's
tool boundary. Its guarantees:

- Decisions are reproducible and do not depend on a model.
- Unclassifiable input is denied; an audit-write failure denies the action.
- The audit log is tamper-evident (SHA-256 hash chain); whole-file
  deletion/rebuild is only detectable with an **external anchor** (`aigov anchor`,
  cross-checked by `aigov log --verify`).
- Approval tokens are one-time, TTL-bounded, and bound to a deterministic
  operation signature.

## Explicit non-goals / limitations

It is **not** an OS-level sandbox and does not by itself contain hostile,
determined code. Known limitations (also encoded in
`tests/adversarial.test.ts`, detailed in
[docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md)):

- The command layer is a conservative pattern matcher, **not a full shell
  parser**. Allowing a general-purpose interpreter or build tool is equivalent to
  allowing arbitrary code: inline eval (`node -e`, `python -c`) is denied, but a
  script **file** (`node build.js`), **stdin-fed** code (`echo '…' | python3`),
  and **lifecycle scripts** (`npm run …`, `make`, `cargo`) are not.
- Path checks are name-level, not `realpath`-resolved — an in-tree symlink to an
  out-of-tree target is a TOCTOU gap.
- Shell write targets (redirections, `sed -i`, `cp`, `mv`, `tee`, `dd of=`) are
  path-policed: writes that escape the tree are denied, but in-tree writes are
  trusted.
- The hash chain is tamper-*evident*, not tamper-*proof*; without a remote/WORM
  anchor, an attacker with local write access can erase and rebuild it.
- Host-adapter blind spots apply (Claude Code `PreToolUse` does not gate the
  `Task` sub-agent tool; `allow` has been unreliable upstream).

For untrusted or adversarial workloads, run agents inside an OS-level sandbox
(containers, seccomp, VMs) **in addition to** `governor-core`.

## Supported versions

Pre-1.0: only the latest `0.x` release receives security fixes.
