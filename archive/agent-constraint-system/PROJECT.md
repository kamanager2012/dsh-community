# Agent Constraint System (ACS)

Cross-agent runtime safety layer for autonomous coding agents.

**Current version: v1.6.1** — see [CHANGELOG.md](CHANGELOG.md)

## Quick Start

```bash
# One-line install
curl -fsSL https://raw.githubusercontent.com/kamanager2012/agent-constraint-system/main/install-remote.sh | bash

# Or via npm
npm install -g agent-constraint-system
acs install
```

## Repository Structure

```
agent-constraint-system/
├── acs_core/       ← Shared guard logic (Bash, Git, filesystem, violations, audit)
├── adapters/       ← Agent-specific adapters (Codex, Claude, Gemini, Cursor, etc.)
├── benchmarks/     ← 3-level adversarial benchmark suite
├── tests/          ← Test suite
├── bin/            ← CLI entry point (acs)
├── docs/           ← Documentation, design, runbooks, ADR, reports
├── demo/           ← E2E demo scripts
├── versions/       ← Historical source snapshots (Git tags preferred)
│
├── VERSION         ← Single source of truth for version number
├── package.json
├── install.sh / install-remote.sh
├── deploy.sh       ← Deploy hooks to agent runtime
└── README.md
```

## Command Reference

```bash
acs install              # Install constraint hooks
acs install --all        # Install all detected agents
acs list                 # List supported agents
acs status               # Check installation status
acs version              # Display version

python3 ~/.claude/hooks/acs_lite.py reset --force  # Unlock after violations
```

## Versioning

Single source of truth: `VERSION` file at repo root.
All components follow the same version — adapters do not carry independent version numbers.
See [docs/version-history.md](docs/version-history.md) for historical version mapping.
