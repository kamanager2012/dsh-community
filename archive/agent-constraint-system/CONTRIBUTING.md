# Contributing to ACS

Thanks for considering a contribution. This is a security tool, so the bar
for changes is deliberately high — especially for anything that touches
`acs_core/guard.py` (pattern matching) or the ledger modules (state).

## What We Need Help With

- **New benchmark scenarios** — especially adversarial ones. A scenario that
  finds a new bypass is the highest-value contribution this project can
  receive.
- **Adapter improvements** — better integration for the supported agents
  (Codex, Claude Code, CodeBuddy, Gemini, OpenCode, Cursor, Qoder, Hermes,
  Grok Build).
- **Documentation** — the threat model, runbooks, and Chinese translation.
- **Bug reports** with minimal reproductions.

## Development Setup

```bash
git clone https://github.com/kamanager2012/agent-constraint-system.git
cd agent-constraint-system

# Run the test suite
python3 -m pytest tests/ -q

# Run the benchmark (Level 1)
cd benchmarks && python3 runner.py

# Run all benchmark levels
cd benchmarks/level2 && python3 runner.py
cd benchmarks/level3 && python3 runner.py
cd benchmarks/level4 && python3 runner.py
```

Requires Python 3.11+. No other dependencies — the core is stdlib-only by
design.

## Adding a Benchmark Scenario

Scenarios live in `benchmarks/scenarios/` (Level 1). Each scenario is a JSON
record: the command to check, and the `expected` verdict (block / allow).
`expected` labels are an independent contract — they are never adjusted to
match the implementation.

```json
{
  "id": "bypass-XXX",
  "category": "bypass_attempts",
  "command": "<the command to check>",
  "expected": "block"
}
```

If your scenario exposes a real gap, do **not** change the `expected` label to
make the test pass. Report the gap in the benchmark output and, if you have a
fix, submit it separately. See the [Known Gaps](README.md#known-gaps-honest-v171-roadmap)
section for how honest failures are handled.

## Style and Review

- Keep the core free of external dependencies (stdlib only).
- New patterns in `guard.py` must be bounded (no unbounded `.*`/`\w+` —
  ReDoS resistance is part of the threat model). See the comments in
  `DANGEROUS_BASH`.
- Every behavioral change to detection logic should ship with at least one
  benchmark scenario that exercises it.
- Follow the existing comment style: explain *why*, not what.

## Commit and PR

- Use [Conventional Commits](https://www.conventionalcommits.org/) style
  (`fix:`, `feat:`, `docs:`, `test:`, `refactor:`).
- Reference the issue or scenario id in the commit body where relevant.
- Keep PRs focused: one logical change per PR.
- Tests must pass (`pytest`) and the benchmark must not regress.

## Security

Security vulnerabilities should **not** be reported via issues or PRs. See
[SECURITY.md](SECURITY.md) for the private reporting process.

## Code of Conduct

All contributors are expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).
