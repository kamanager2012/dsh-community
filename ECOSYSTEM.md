# DeepSeek Harness Community ecosystem

> Current source of truth for project roles and public positioning. Historical
> handoff material from 2026-08-21 is preserved at
> [docs/archive/ecosystem-handoff-2026-08-21.md](docs/archive/ecosystem-handoff-2026-08-21.md).

## One sentence

**Official DeepSeek Harness is the execution kernel. dsh-community is the
community distribution, compatibility, and security-validation layer around
that published Runtime.**

This repository does not ship a second Agent Runtime, a second Session store,
or a forked tool-execution pipeline.

## Current product reality

There are **five Community endpoints**:

1. WSL/Linux Terminal
2. Windows Desktop
3. macOS Desktop
4. Linux AppImage
5. Android

The first four currently have published artifacts. Android source is active in
`apps/android`, remains **[UNVERIFIED]**, and is not yet part of GitHub Latest.

Official Web is an upstream companion surface owned by DeepSeek. It is not a
Community-shipped endpoint.

```text
                    Official DeepSeek Harness Runtime
                                 │
                    official ~/.dsh source of truth
                                 │
       ┌─────────────────────────┼──────────────────────────┐
       ▼                         ▼                          ▼
 WSL/Linux Terminal        Community Desktop         Official Web
   (community)             ├─ Windows                (upstream)
                           ├─ macOS
                           └─ Linux AppImage

 Android: active source / UNVERIFIED / not yet published
```

Preferred public wording:

> **One Harness. Five community endpoints. Four shipped today; Android active / UNVERIFIED.**

Always distinguish product membership from publication evidence: Android is in the active product tree but is not yet a Published Latest artifact.

## What the official Runtime owns

- Agent loop and model execution
- tool execution and approvals
- official Session persistence and event stream
- official Web UI
- official CLI/profile/plugin execution semantics
- credentials and provider integration

## What dsh-community owns

- WSL/Linux Terminal and Desktop distribution UX
- process/lifecycle wrapping needed by those surfaces
- exact upstream Runtime pinning and contract snapshots
- compatibility CI for upstream changes
- GitHub Release packaging and integrity evidence
- keyless cosign/Sigstore release signing
- plugin discovery and compatibility/security metadata
- issue triage, contributor workflow, and release maintenance

When an official capability exists, use the official capability. Community code
should fill a verified distribution or UX gap, not create a competing core.

## Session and data boundary

By default, Community surfaces use the official `~/.dsh` Session source of
truth. TUI, Desktop, and official Web therefore operate on the same official
Session world.

Community-owned Desktop state such as logs, window state, crash reports, and
runtime cache belongs in Electron userData. It must not become a second
equivalent Session store.

## Compatibility layer

Upstream changes follow this path:

```text
Published @deepseek-ai/dsh
        ↓ exact pin
Contract snapshots
        ↓
Compatibility CI
        ↓
TUI/Desktop integration
        ↓
Release evidence
```

The repository records **latest tested**, not merely npm latest. An upstream
version is not treated as compatible until its actual surface has been checked.

Candidate Source, Published Latest, published assets, and evidence labels live
in [docs/current-release.json](docs/current-release.json). There is deliberately
no single "current version" invariant: source compatibility may advance before
publication, plugin verification, or real User-Loop evidence. Ecosystem
documents must not collapse those independent states into one number.

## Plugin ecosystem

The in-repo registry lives at
[packages/marketplace/catalog.json](packages/marketplace/catalog.json).

It is a **verification registry**, not an awesome list. A catalog entry should
answer questions such as:

- Which DSH version was actually tested?
- Does official `dsh plugin add` install it?
- Does compose / `--dump-config` succeed?
- What network, data-egress, credential, filesystem, process-execution, and
  persistence behavior is declared or reviewed?
- What evidence supports its compatibility status?

The registry may reference third-party packages as metadata. Those packages do
not become dependencies of the Community Runtime surfaces.

Current registry entries are tested against the line recorded in the catalog
and current-release facts. Never carry an older compatibility claim forward
without retesting.

## Repository topology

### Active

- **dsh-community** — canonical Community product, releases, compatibility
  contracts, and plugin registry
- **deepseek-harness-handbook** — operational documentation and evidence

### Archived / historical

- **deepseek-harness-suite** — archived Labs
- **dsh-community-edition** — archived
- **dsh-marketplace** — archived standalone registry/CLI; functionality moved
  into this repository
- **dsh-community-plugins** — archived standalone plugin registry

Archived repositories are not current download channels.

## Evidence language

Use evidence labels literally:

- `[UNVERIFIED]` — no sufficient real evidence yet
- `[PARTIAL]` — a bounded subset was exercised
- `[REAL]` — a specific real path has direct evidence
- `[FAIL-CLOSED]` / `[BLOCKED_BY_UPSTREAM]` — use only when the recorded
  failure condition actually applies

A green unit test, README sentence, successful build, or workflow definition is
not by itself proof of a real user loop.

The exact-release WSL/Linux user-loop workflow is intentionally manual and
billable. Its existence does **not** upgrade
`docs/current-release.json.evidence.userLoop.status`; only a successful real
release run can do that.

## Security and supply-chain boundary

- no vendored official Runtime source
- no generic renderer `exec` / `eval` / filesystem bridge
- Electron permissions default-deny
- navigation is allow-listed
- official Desktop host binds loopback only
- release assets carry checksums and keyless signature bundles
- Dependabot routine version PRs are limited to minor/patch updates
- semver-major dependency/action upgrades require explicit compatibility work

See [SECURITY.md](SECURITY.md) for the security policy and
[GOVERNANCE.md](GOVERNANCE.md) for maintainer responsibilities.

## What not to claim

Do not say:

- “five shipped Community endpoints”
- “Android is a current release endpoint”
- “Official Web is our Web client”
- “complete ecosystem”
- “100% compatible”
- “full user loop verified” until the real evidence exists
- “all catalog plugins are security audited”

## Canonical references

- [README.md](README.md)
- [README.en.md](README.en.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [docs/community-endpoints.md](docs/community-endpoints.md)
- [docs/current-release.md](docs/current-release.md)
- [docs/current-release.json](docs/current-release.json)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [GOVERNANCE.md](GOVERNANCE.md)

Historical design and migration material may describe earlier product shapes.
Those files are historical evidence, not current product truth.
