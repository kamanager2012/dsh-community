# DSH Community Getting Started

> A task-oriented entry point for first-time users. Evidence snapshot: 2026-08-21.

[简体中文](getting-started.md) · [Back to English README](../README.en.md) · [Community endpoints](community-endpoints.en.md) · [Online Handbook](https://kamanager2012.github.io/dsh-community/en/)

## Choose the right entry

| Goal | Entry | Meaning |
| --- | --- | --- |
| Use Official Web or Windows / macOS Desktop | [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) (`npx @deepseek-ai/dsh web`) | Upstream product and Win/macOS desktop builds; Complementary Edition does not duplicate them |
| Use the community Terminal / TUI | `dsh-community` or `pnpm tui` from source | Primary Linux / WSL complementary endpoint around the official Runtime |
| Download the Linux Desktop AppImage | [Latest `v0.1.1-rc.2`](https://github.com/kamanager2012/dsh-community/releases/latest) `.AppImage` or `pnpm desktop:package -- --appimage` | Linux desktop complementary build absent upstream |
| Inspect Android Remote Client (experimental) | In-repo `apps/android` + `packages/remote-adapter` | `[LABS]` / `[UNVERIFIED]`, outside Published Latest |
| Read the full operational guide | [DeepSeek Harness Handbook](https://kamanager2012.github.io/dsh-community/en/) | Providers, Sessions, security, automation, and acceptance |

Do not download a formal client from archived Suite, the standalone Marketplace, the standalone Plugins registry, or Edition. **Published Latest** is defined by [releases/latest](https://github.com/kamanager2012/dsh-community/releases/latest) plus `githubLatestTag / publishedAssets / publishedReleaseEvidence` in `current-release.json`; published assets carry keyless cosign signatures (`.sigstore.json`). Do not download historical `v0.1.2`–`v0.1.6` as the current product. Official Web and Win/macOS Desktop are upstream surfaces, not Complementary Community endpoints. The product defines three complementary Community endpoints: two currently published (`WSL/Linux Terminal` and `Linux AppImage`) plus the active-source `Android` Remote Client, which remains `[UNVERIFIED]` and outside Published Latest. See [community-endpoints.en.md](community-endpoints.en.md) and the [version policy](version-policy.md).

A source checkout displays the **Candidate Source** Dual-Badge, not the Published Latest version. Candidate core, community product version, `candidateTag`, and Dual-Badge are read from [`current-release.json`](current-release.json); source may lead the published download.

## Current published download assets

Historical [`v0.1.1-rc.2`](https://github.com/kamanager2012/dsh-community/releases/latest) on the Release page (GitHub may display spaces as dots):

- `dsh-community-0.1.1-rc.2.AppImage` — Linux Desktop AppImage (retained on future Complementary Edition releases)
- `dsh-community-0.1.1-rc.2.dmg` — macOS (historical artifact; retired after `v0.1.1-rc.2` in favor of official `deepseek-harness`)
- `DSH Community Setup 0.1.1-rc.2.exe` — Windows (historical artifact; retired after `v0.1.1-rc.2` in favor of official `deepseek-harness`)

Future Complementary Edition releases publish only `.AppImage` plus the `official-runtime.cdx.json` SBOM. Each file has a matching `.sha256` sidecar and `.sigstore.json` bundle:

```sh
sha256sum -c dsh-community-0.1.1-rc.2.AppImage.sha256
```

The first desktop launch unpacks the official runtime into user data once. Sessions stay in official `~/.dsh`.

## Start from source in five minutes

You need Node.js 22.15+, pnpm, and a working `DEEPSEEK_API_KEY` (official 0.1.0-rc.8+ session JSONL uses `node:zlib` zstd, added in 22.15):

```sh
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community
pnpm install
export DEEPSEEK_API_KEY=...
pnpm run doctor
pnpm start
```

On Windows PowerShell:

```powershell
$env:DEEPSEEK_API_KEY = "..."
pnpm run doctor
pnpm start
```

`doctor` is a preflight check; it does not prove that a model request succeeded. After the first task, inspect the actual result, `git diff`, and the process exit status.

## Common entry points

```sh
dsh-community                 # resume the latest session when one exists
dsh-community new             # start a new session
dsh-community resume last     # resume the latest session
dsh-community sessions        # list official sessions
dsh-community doctor          # inspect the environment
dsh-community version         # show community-layer version information
dsh-community plugins         # read-only plugin catalog view
dsh-community desktop         # start the desktop shell
```

Source development also supports `pnpm start`, `pnpm new`, `pnpm run doctor`, and `pnpm desktop`. Do not run bare `pnpm doctor` — that is pnpm's own command. Plugin installation should remain on the official `dsh plugin add` chain or the Desktop marketplace flow.

## Session and data boundaries

- The official Session source of truth remains `~/.dsh`; Community does not maintain an equivalent second persistence layer.
- `new`, `resume`, and `sessions` are entry-point UX. They do not make Community the owner of the official Session format.
- For backup, recovery, event reading, or automation, start with the Handbook [Sessions section](https://kamanager2012.github.io/dsh-community/en/07-sessions/).
- Never put API keys, private Sessions, or customer data in repositories, screenshots, or issues.

## Plugin path

```text
packages/marketplace/catalog.json
          ↓ compatibility and evidence
      packages/marketplace (CLI: dsh-marketplace / pnpm marketplace)
          ↓ user selection
official dsh plugin add / official install chain
```

The catalog is not a security guarantee and does not replace the official installer. An entry without a matching `testedDsh` line must be treated as `[UNVERIFIED]`.

- [Plugin catalog](../packages/marketplace/catalog.json)
- [Marketplace guide](../packages/marketplace/docs/usage.en.md)
- [Registry verification guide](../packages/marketplace/docs/registry-guide.en.md)

## Troubleshooting first moves

| Symptom | Check first | Do not do this |
| --- | --- | --- |
| `dsh-community: command not found` | Use the source commands or fix the package PATH | Do not publish this repository as `@deepseek-ai/dsh` |
| No model response | `DEEPSEEK_API_KEY`, Provider settings, and `dsh web --help` | Do not treat a passing `doctor` as a successful model call |
| Port already in use | `doctor` output and the official `dsh web` process | Do not use `killall node` against unrelated projects |
| Unsure which release to download | [Published Latest](https://github.com/kamanager2012/dsh-community/releases/latest) | Exact tag/file names: `current-release.json`; do not download historical `v0.1.2`–`v0.1.6` |
| Want unpublished SDK / Checkpoint experiments | Those experiments are frozen in archived Labs | Do not install from the archived repo |

## Continue reading

- [Architecture boundary](../ARCHITECTURE.md)
- [Release guide](release.md)
- [Upgrade notes](upgrade.md)
- [Contract snapshots](../contracts/README.md)
- [Ecosystem notes](../ECOSYSTEM.md)
- [Official Runtime](https://github.com/deepseek-ai/deepseek-harness)
