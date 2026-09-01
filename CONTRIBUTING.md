# Contributing to dsh-community

Thanks for contributing. This repository is a community distribution,
compatibility, and verification layer around the published
`@deepseek-ai/dsh` Runtime. It is not a fork of the Agent Runtime.

## What contributions are welcome

- Bug fixes in the community TUI, Desktop shell, bridge, packaging, or
  compatibility checks.
- Compatibility updates for a newly published DeepSeek Harness version.
- Marketplace registry additions or updates backed by reproducible evidence.
- Tests that close a real regression or strengthen a documented boundary.
- Security hardening, release-integrity improvements, and documentation fixes.

For large architectural changes, open an issue first. For suspected
vulnerabilities, do **not** open a public issue; follow [SECURITY.md](SECURITY.md).

## Architectural boundaries

These rules are part of the product contract:

1. Official `@deepseek-ai/dsh` is the only Agent Runtime.
2. Do not vendor or copy the official `packages/*` tree into this repository.
3. Do not add a second Agent loop, tool-execution pipeline, model adapter, or
   Session persistence implementation.
4. TUI/Desktop business state must use official seams such as `session/event`
   and `ctx.agents`; stdout/stderr are diagnostics, not a business protocol.
5. Runtime composition may use official `@deepseek-ai/*` packages, this
   workspace's `@dsh-community/*` packages, and explicitly reviewed generic
   libraries only.
6. Third-party Harness/TUI products may be referenced in the compatibility
   registry, but must not be mounted as runtime dependencies or composition
   rows.
7. Plugin installation remains on the official `dsh plugin add/remove` path.
   Do not introduce a second installer.

See [ARCHITECTURE.md](ARCHITECTURE.md) and
[docs/reconstruction.md](docs/reconstruction.md) for the rationale.

## Development setup

Requirements: Node.js 22.15+ and pnpm.

```sh
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

If you touch the marketplace registry, also run:

```sh
node packages/marketplace/scripts/verify.mjs --offline
```

A compatibility claim is stronger than a schema check. When a PR says a plugin
works on a specific DSH line, include the actual install/compose/runtime
evidence described in
[packages/marketplace/docs/registry-guide.md](packages/marketplace/docs/registry-guide.md).

## Pull request evidence

A useful PR description should state:

- **Problem:** what is broken or missing.
- **Scope:** what files/surfaces are intentionally changed.
- **Boundary:** whether Runtime, Session, plugin, permission, network, or
  release behavior changes.
- **Validation:** exact commands run and their results. Do not write "tests
  pass" if they were not executed.
- **Release impact:** whether the change affects packaged artifacts,
  compatibility metadata, or the current release line.
- **Known limitations:** anything still unverified.

Keep unrelated cleanup out of the same PR when it makes review harder.

## Plugin registry submissions

A catalog entry is compatibility/security metadata, not an endorsement.
Submissions should include:

- public source repository and installable package/version;
- the exact `testedDsh` line;
- package integrity/digest evidence where available;
- structured security metadata for network, data egress, credentials,
  filesystem, process execution, and persistence;
- install + compose evidence through the official DSH plugin chain;
- runtime smoke evidence when claiming `[VERIFIED]` rather than
  `[PARTIAL]`.

The registry may list third-party packages. That does **not** permit those
packages to become dependencies of the community Runtime surfaces.

## Review and merge policy

The current primary maintainer reviews repository changes and release-impacting
updates. External contributions are welcome; approval is based on reproducible
evidence and the architectural boundaries above, not contributor identity.

See [GOVERNANCE.md](GOVERNANCE.md) for maintainer and release responsibilities.
