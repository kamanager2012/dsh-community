# governor-core

**A deterministic, agent-agnostic policy & accountability layer for AI coding agents.**

> **Part of the [Agent Governance Stack](https://github.com/kamanager2012/agent-constraint-system)** — the policy-engine layer between
> [ACS](https://github.com/kamanager2012/agent-constraint-system) (command-level execution gate) and
> [aios-core](https://github.com/kamanager2012/aios-core) (plan-level execution kernel).

`governor-core` intercepts an AI agent's tool calls *before* they run and returns
an **allow / deny / ask** verdict, recording every decision to a tamper-evident,
hash-chained audit log. A denied action does not happen, and every action is
accountable.

Most agent-governance tooling today is observability — dashboards and traces that
tell you what an agent *did*. `governor-core` decides what an agent is *allowed*
to do, deterministically and fail-closed, at the point of action.

> **What it is / is not.** This is a **guardrail and audit layer**, not a security
> boundary. It is effective against a **cooperative** agent that makes mistakes or
> drifts — a hallucinated `rm -rf /`, a write to the wrong path, an out-of-scope
> command. It is **not** sufficient against an **adversarial** agent or hostile
> code: any general-purpose interpreter or build tool on the allow-list (`node`,
> `python3`, `make`, …) can execute arbitrary logic, and the governor runs inside
> the same blast radius it is trying to contain. For untrusted workloads it must
> be paired with an OS-level sandbox. See
> [Threat model & limitations](#threat-model--limitations) and
> [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md).

> Status: `1.0.0`. The command layer is hardened and covered by an
> adversarial test suite that asserts both what it stops and what it does not.

Project overview: [Kama Projects](https://kamanager2012.github.io/).

---

## Why

- **Deterministic** — no model call in the decision path; the same tool call
  always yields the same verdict, so behavior is reproducible and auditable.
- **Fail-closed** — anything unclassifiable is denied. If the audit write fails,
  the action is denied. Governance that fails open is not governance.
- **Agent-agnostic** — the core speaks a single `ToolCall → Verdict` contract.
  Adapters translate a host agent's native payload into it. The first adapter
  targets the **Claude Code `PreToolUse` hook**.
- **Tamper-evident** — the audit log is a SHA-256 hash chain; any edit, deletion,
  or reorder is detectable with `aigov log --verify`.

## Install

```bash
npm install
npm run build      # compiles src → dist
npm test           # vitest
```

Zero runtime dependencies (Node's stdlib only). Requires Node.js >= 18.

## Use it with Claude Code

Build the project, then register the hook in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node /ABS/PATH/aigov/dist/adapters/claude-code/hook.js"
          }
        ]
      }
    ]
  }
}
```

Now, in a real session:

- `rm -rf /`, writing `.env`, or a path-traversal write is **denied**.
- `git push` (and other sensitive ops) return **ask** — a human grants a
  one-time token out of band.
- `git status`, editing `src/*.ts`, etc. are **allowed**.

### Environment

| Variable          | Default                    | Purpose                          |
| ----------------- | -------------------------- | -------------------------------- |
| `AIGOV_POLICY`    | built-in `DEFAULT_POLICY`  | Path to a `policy.json`          |
| `AIGOV_AUDIT`     | `~/.aigov/audit.jsonl`     | Hash-chained audit log path      |
| `AIGOV_APPROVALS` | `~/.aigov/approvals`       | Approval token / pending store   |
| `AIGOV_ANCHOR`    | `~/.aigov-anchors/audit.anchor` | External anchor for the audit head (put it out of the agent's reach) |

## Policy

`policy.json` is a field-level override of the built-in default:

```json
{
  "allowedPaths":    ["**/*"],
  "deniedPaths":     [".aigov/**", "**/.env", "**/secrets/**"],
  "allowedCommands": ["echo", "git", "node", "pnpm", "vitest", "tsc"],
  "deniedCommands":  ["rm -rf /", "rm", "sudo", "curl", "node -e", "..."]
}
```

- Paths are glob-matched (case-insensitive); absolute paths and `../` traversal
  are rejected outright.
- Commands are matched per-subcommand after the line is split on shell operators
  and command substitutions, with quoted literals stripped and simple variable
  assignments expanded — so `git; rm -rf /`, `echo $(rm -rf /)`, and
  `X=rm; $X -rf /` are all caught, while `echo "rm -rf /"` (a literal) is not.
- **Deny wins.** A command must both miss every deny rule *and* have an
  allow-listed head.

## CLI

```bash
aigov pending            # list operations awaiting approval
aigov approve <id>       # grant a one-time, TTL-bounded token for one op
aigov log                # print the audit chain
aigov log --verify       # verify chain integrity + cross-check external anchors
aigov anchor             # pin the current chain head to the anchor store
```

## Enforcement model

| Layer            | What it does                                                        |
| ---------------- | ------------------------------------------------------------------- |
| Scope            | Path allow/deny + traversal guard; command allow/deny per subcommand |
| Anti-bypass      | Splits chains/substitutions, strips quotes, expands `VAR=` indirection |
| Mass-delete      | Semantic detection (`find -delete`, `-exec rm`, `shred`, `rm -rf *`) independent of the allow-list |
| Escalation       | General-purpose executors (`node`, `python3`, `make`, `npm`, …) escalated to `ask` via `elevatedCommands` |
| Self-protection  | Inviolable deny for operations targeting governor-core's own files/state (checked before any token) |
| Approval         | One-time tokens keyed to a deterministic op signature, with a TTL   |
| Audit            | SHA-256 hash-chained JSONL; atomic writes; corrupt tail → fail-closed |
| Anchoring        | External head-hash anchor (`aigov anchor`) cross-checked on `--verify` — detects whole-file deletion/rebuild |
| Concurrency      | Atomic token claim (`rename`) + serialized audit append (`mkdir` lock) |

## Threat model & limitations

`governor-core` raises the cost of a **cooperative** agent going off the rails and
makes every action accountable. It is **not** an OS-level sandbox, and the command
layer is a conservative pattern matcher, not a full shell parser. The decisive
limitation is structural: **it judges the command string, but bash executes at the
syscall layer** — and the allow-list necessarily contains general-purpose
executors. Against an adversarial agent, treat the command layer as advisory.

Known bypass classes (registered in [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md)
and asserted honestly in `tests/adversarial.test.ts`):

- **Interpreters are arbitrary execution.** An allow-listed interpreter can run a
  script **file** (`node build.js`) or read code from **stdin**
  (`echo '<code>' | python3`); only inline `-e`/`-c` eval is denied, which is a
  partial cover, not a boundary. The shipped policy escalates these executors to
  `ask` (`elevatedCommands`, `ruleId: ask-elevated`) so a human sees each one —
  a gate for a cooperative agent, not a wall against an adversarial one.
- **Build tools run arbitrary lifecycle scripts.** `npm run …`, `make`, `cargo`,
  `go run` execute shell defined in project config the governor never inspects;
  these are likewise escalated to `ask` by the default policy.
- **Self-disable / audit erasure.** Code running via an allowed interpreter can
  rewrite the host hook config to unhook the governor, or truncate the audit log;
  the hash chain is tamper-*evident*, not tamper-*proof*, and needs an external
  anchor (see `aigov anchor`) to survive whole-file deletion.
- **Name-level path checks.** Path policy matches strings, not resolved
  `realpath`; an in-tree symlink to an out-of-tree target is a TOCTOU gap.
- Shell write targets (redirections, `tee`, `sed -i`, `cp`/`mv`/`ln`/`install`,
  `dd of=`) *are* held to the path policy, so writes escaping the tree
  (`echo x > /etc/passwd`, `cp x ~/.ssh/...`) are denied; in-tree writes are
  trusted.
- The Claude Code hook has upstream blind spots: `PreToolUse` does not gate the
  `Task` sub-agent tool ([#26923]), and `permissionDecision:"allow"` has been
  unreliable ([#52822]) — enforcement leans on `deny`/`ask`.

For untrusted or hostile code, run the agent inside an OS-level sandbox
(containers, seccomp/eBPF, read-only mounts, restricted user) **in addition to**
`governor-core`, which then serves as the auditable policy brain.
See [SECURITY.md](./SECURITY.md).

[#26923]: https://github.com/anthropics/claude-code/issues/26923
[#52822]: https://github.com/anthropics/claude-code/issues/52822

## Development

```bash
npm test           # run the suite (scope, engine, hook, concurrency, adversarial)
npm run build      # type-check + emit dist/
```

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). Security issues:
[SECURITY.md](./SECURITY.md).

## License

[Apache-2.0](./LICENSE) © 2026 James Oldman.
