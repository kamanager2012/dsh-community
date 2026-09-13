# Security Policy

ACS is a security tool, so its own security matters twice over: a bug in a
constraint system is not just a bug, it is a potential hole in the safety
boundary of every agent it protects.

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via one of:

- **GitHub private security advisory**: go to
  [Security → Advisories → New advisory](https://github.com/kamanager2012/agent-constraint-system/security/advisories/new)
  and fill in the details. You can submit a draft without a fix.
- **Email**: reach the maintainers through the GitHub advisory flow above —
  the advisory includes a private discussion thread.

When reporting, include:

1. The ACS version (`acs version` or the `VERSION` file)
2. The agent/OS environment
3. A minimal reproduction: the exact command or write that bypasses or breaks
   a constraint
4. What you expected (blocked) vs what happened (allowed)

You will receive an acknowledgement within 48 hours. We aim to triage within
5 business days and, for confirmed issues, to ship a fix in the next release.

## Security Design Principles

- **Fail-closed**: anything unclassifiable is denied. If the audit write
  fails, the action is denied.
- **Self-protection**: the constraint layer cannot be modified or disabled by
  the agent it constrains (`hooks/`, `runtime/`, `settings.json` are
  ACS_SELF_PROTECT paths).
- **Integrity chain**: SHA-256 hash chaining detects tampering with constraint
  files; a broken chain is treated as a violation, not silently repaired.
- **Human-only unlock**: agents cannot self-unlock; unlocking requires an
  explicit human `--confirm` flag.
- **Zero dependencies**: the core uses only the Python standard library —
  no supply-chain surface to attack.

## Threat Model

See [docs/threat-model.md](docs/threat-model.md) for the full threat model:
attack scenarios (destructive shell execution, credential leakage,
unauthorized file mutation, prompt-injection-induced tool abuse, constraint
bypass), what ACS does and does not defend against, and the honest list of
known detection gaps.

## Known Limitations

Static pattern matching cannot catch every obfuscation. The benchmark's
[Known Gaps section](README.md#known-gaps-honest-v171-roadmap) documents the
4 known bypasses and 2 false positives at Level 1, with the roadmap to close
them (asset-aware trajectory analysis). We report gaps publicly rather than
claiming complete coverage.
