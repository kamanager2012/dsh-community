# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-29

First release: a deterministic, agent-agnostic policy & accountability layer with
a Claude Code `PreToolUse` hook adapter.

### Added

- **Governance engine** — `ToolCall → Verdict` (allow/deny/ask), deterministic
  and fail-closed; every decision is audited, and an audit-write failure denies
  the action.
- **Scope** — path allow/deny with `../` traversal and absolute-path rejection;
  command allow/deny matched per subcommand.
- **Anti-bypass command handling** — splits on shell operators, extracts `$()`
  and backtick substitutions, strips quoted literals, and expands simple
  variable-assignment indirection (`X=rm; $X -rf /`).
- **Mass-delete detection** — flags `rm -rf` with wildcard/home/root,
  `find -delete`, `find -exec rm`, and `shred` independent of the allow-list.
- **Inline-eval denial** — `node -e`, `node --eval`, `python -c`, `perl -e`,
  `ruby -e`, `php -r`, `deno eval`, and friends are denied even when the
  interpreter is allow-listed.
- **Shell write-target path-policing** — redirections, `tee`, `sed -i`,
  `cp`/`mv`/`ln`/`install`, and `dd of=` targets are held to the same path
  policy as file tools; writes escaping the tree (`echo x > /etc/passwd`,
  `cp x ~/.ssh/...`) are denied (`ruleId: path-in-command`).
- **Elevated-executor escalation** — an `elevatedCommands` policy field lists
  general-purpose executors (`node`, `python3`, `make`, `npm`, `cargo`, `go`,
  `xargs`, …); the shipped `policy.json` escalates them from silent `allow` to
  `ask` (`ruleId: ask-elevated`), since allow-listing an interpreter or build tool
  is equivalent to allow-listing arbitrary execution. Tunable in one edit — set
  `elevatedCommands: []` to disable the prompts.
- **Tamper-evident audit** — SHA-256 hash-chained JSONL with `verifyChain`;
  atomic writes and a corrupt tail that fails closed.
- **External audit anchoring** — `aigov anchor` pins the chain head to a separate
  store; `aigov log --verify` cross-checks it (`verifyAgainstAnchor`), making
  whole-file deletion/rebuild of the audit log detectable.
- **Approvals** — one-time tokens keyed to a deterministic operation signature,
  bounded by a TTL, with a pending queue and `aigov approve`.
- **Self-protection** — inviolable deny for operations targeting governor-core's
  own files/state, checked before any approval token.
- **Concurrency safety** — atomic token claim via `rename`; audit append
  serialized with a `mkdir`-based cross-process lock (timeout fails closed,
  stale locks reclaimed).
- **CLI** — `aigov approve | pending | log [--verify] | anchor`.
- **Claude Code adapter** — `PreToolUse` JSON normalization and verdict mapping,
  with upstream blind spots documented.
- **docs/THREAT_MODEL.md** — authoritative register of what the tool stops
  (cooperative agent) vs. the accepted bypasses (adversarial agent).
- **Tests** — scope, engine, hook, concurrency, and an adversarial bypass suite.

### Changed

- **Honest positioning** — described as a deterministic policy & accountability
  layer (guardrail + audit), explicitly **not** an OS-level sandbox or a security
  boundary against adversarial code.

[1.0.0]: https://github.com/kamanager2012/governor-core/releases/tag/v1.0.0
