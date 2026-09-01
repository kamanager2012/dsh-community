# Support and Issue Routing

Use the narrowest channel that matches the problem. This keeps community
maintenance separate from upstream Runtime support and third-party plugin
support.

## dsh-community issue

Open an issue in this repository for problems in:

- the community TUI or Desktop shell;
- packaging, installers, release artifacts, checksums, or signature bundles;
- the DSH bridge and lifecycle integration owned by this repository;
- compatibility contracts maintained here;
- marketplace registry metadata or its verification tooling;
- documentation describing this repository's behavior.

Use the structured bug or plugin-registry issue forms when they fit.

## Upstream DeepSeek Harness issue

If the problem reproduces in the official `@deepseek-ai/dsh` Runtime without
this community layer — Agent loop, model execution, official Web behavior,
official Session persistence, or official tool execution — report it to the
official DeepSeek Harness project instead.

## Third-party plugin issue

If a listed plugin itself misbehaves, report the runtime bug to that plugin's
maintainer. Open an issue here only when the community registry entry,
compatibility status, digest, or security metadata is wrong or stale.

## Security report

Do **not** open a public issue for a suspected vulnerability in this
repository. Follow [SECURITY.md](SECURITY.md) and use a private GitHub Security
Advisory.

## Usage and troubleshooting

Start with the [Getting Started guide](docs/getting-started.md) and the
[DeepSeek Harness Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/).
When asking for help, include the dsh-community version, official DSH version,
OS, exact command/path, and sanitized error evidence.
