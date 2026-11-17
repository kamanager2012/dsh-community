# DSH Community: sourced alternatives and product positioning

> Reviewed 2026-11-17 using primary-source project READMEs and websites. **Not an independent performance benchmark.** Omitted features are not proof a competitor lacks them.

## What problem do we own?

**Multi-agent dashboards, E2EE, mobile approvals and Git diff are common category features.** Our focus is access to the **unmodified official `@deepseek-ai/dsh` Runtime on Linux / WSL2** through TUI and signed AppImage, with official `~/.dsh` continuation, exact upstream pins and verifiable release evidence.

| Your primary need | Recommended tool | First-party source / scope |
|---|---|---|
| Official DSH Runtime with Linux TUI + signed desktop UI | **[DSH Community](../README.en.md)** | [release evidence](current-release.md); not the only Linux solution |
| Durable terminal panes, SSH, many CLI agents | [Herdr](https://github.com/herdrdev/herdr) | Official README: background terminal multiplexing, status |
| E2EE/self-hosted mobile and desktop multi-agent operation | [Happier](https://github.com/happier-dev/happier) | Official README: cross-device multi-provider workflows |
| Worktrees, editor, terminals, diff, browser and PRs | [Paseo](https://github.com/getpaseo/paseo) | Official README: integrated development environment |
| Agent threads to branches and GitHub PRs | [T3 Code](https://github.com/pingdotgg/t3code) | Official site/repo: review and PR delivery |
| Native DSH plugin remote with P2P/TURN and ACP backends | [DS Harness Remote](https://github.com/liguobao/ds-harness-remote) | Official README: remote plugin; hosted vs minimal self-host differs |
| Run the DSH runtime locally on Android | [dsh-Go](https://github.com/ccch1mneyyy/dsh-Go) | On-device runtime differs from our thin client |
| Independent, rich DSH terminal UI | [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) | Official README: third-party TUI |

## Supported claims, limitations and evidence levels

- **Supported**: no fork of the official DSH execution kernel; Linux/WSL2 TUI and AppImage, upstream compatibility/contract gates, signed release artifacts.
- **Session ownership**: only DSH uses the official `~/.dsh` Session store. Claude Code, Codex CLI and OpenCode preserve their native persistent sessions. The control surface does not merge session databases.
- **Release identity**: GitHub Latest `v0.2.2-rc.3` and community Pre-release `v0.2.2-rc.3-community.1` are separate channels. See [machine-backed release facts](current-release.md).
- **Separate evidence**: published-asset smoke, real Chromium with mock-agent E2EE, real official DSH Session continuation, Android x86_64 emulator R6 and physical arm64 devices are distinct acceptance classes.
- **Unverified**: Android physical `arm64-v8a` is `[UNVERIFIED]`; no native iOS; cross-version and real third-party CLI/network workflows still need more field evidence.
- **Security**: remote E2EE does not cover provider API handling, authorized endpoints or compromised hosts; do not imply an external cryptographic audit.
- **Public-copy guardrails**: no fixed Star numbers, exclusivity claims, unsupported missing-competitor features, or mock-fixture screenshots passed off as live external CLI runs.

## First-run validation plan (targets, not reported results)

| First-run task | Ask for redacted evidence | Failure class |
|---|---|---|
| Fresh Ubuntu / WSL2 installation | OS, Node/pnpm, install method, exit code | Prerequisites / packaging / PATH |
| Create and resume official DSH Session | Version, minimal actions, result | Upstream seam / process / storage |
| Verify and start AppImage | Release tag, checksum, GUI environment, result | Artifact / extraction / offline cache |
| Pair phone, approve and revoke | Phone OS, LAN or HTTPS/WSS transport, granted capabilities, result | Network / pairing / authorization / idempotency |
| Prefer DSH Community over an alternative? | Voluntary workflow, blockers, alternative used | Product fit / onboarding |

Collect **voluntary, redacted** [first-run feedback](https://github.com/kamanager2012/dsh-community/issues/new?template=first-run-feedback.yml). No default tracking or upload of local sessions.

## Public one-liner

> DSH Community complements the official DeepSeek Harness with Linux / WSL2 TUI and signed desktop distribution while preserving its runtime and DSH session source of truth; multi-agent E2EE remote is optional.

[中文版](competitive-positioning.md)
