# DSH Community Getting Started

> A task-oriented entry point for first-time users. Evidence snapshot: 2026-08-16.

[简体中文](getting-started.md) · [Back to English README](../README.en.md) · [Online Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/en/)

## Choose the right entry

| Goal | Entry | Meaning |
| --- | --- | --- |
| Use the official Runtime directly | [`npx @deepseek-ai/dsh web`](https://github.com/deepseek-ai/deepseek-harness) | Official product path |
| Use the community Terminal / TUI | `dsh-community` or `pnpm tui` from source | Community UX around the official Runtime |
| Download a desktop build | [Community Releases](https://github.com/kamanager2012/dsh-community/releases) | Use Preview for testing; the latest Actions run built three-platform artifacts, but a tag is still required before they become GitHub Release downloads |
| Read the full operational guide | [DeepSeek Harness Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/en/) | Providers, Sessions, security, automation, and acceptance |

Do not download a formal client from Suite, Marketplace, Plugins, or Edition. They are respectively the labs, discovery UX, compatibility registry, and historical archive.

## Start from source in five minutes

You need Node.js 22+, pnpm, and a working `DEEPSEEK_API_KEY`:

```sh
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community
pnpm install
export DEEPSEEK_API_KEY=...
pnpm doctor
pnpm start
```

On Windows PowerShell:

```powershell
$env:DEEPSEEK_API_KEY = "..."
pnpm doctor
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

Source development also supports `pnpm start`, `pnpm new`, and `pnpm desktop`. Plugin installation should remain on the official `dsh plugin add` chain or the Desktop marketplace flow.

## Session and data boundaries

- The official Session source of truth remains `~/.dsh`; Community does not maintain an equivalent second persistence layer.
- `new`, `resume`, and `sessions` are entry-point UX. They do not make Community the owner of the official Session format.
- For backup, recovery, event reading, or automation, start with the Handbook [Sessions section](https://kamanager2012.github.io/deepseek-harness-handbook/en/07-sessions/).
- Never put API keys, private Sessions, or customer data in repositories, screenshots, or issues.

## Plugin path

```text
dsh-community-plugins/catalog.json
          ↓ compatibility and evidence
      dsh-marketplace
          ↓ user selection
official dsh plugin add / official install chain
```

The registry is not a security guarantee and does not replace the official installer. An entry without a matching `testedDsh` line must be treated as `[UNVERIFIED]`.

- [Plugin compatibility registry](https://github.com/kamanager2012/dsh-community-plugins)
- [Marketplace guide](https://github.com/kamanager2012/dsh-marketplace)
- [Registry verification guide](https://github.com/kamanager2012/dsh-community-plugins/blob/main/docs/registry-guide.en.md)

## Troubleshooting first moves

| Symptom | Check first | Do not do this |
| --- | --- | --- |
| `dsh-community: command not found` | Use the source commands or fix the package PATH | Do not publish this repository as `@deepseek-ai/dsh` |
| No model response | `DEEPSEEK_API_KEY`, Provider settings, and `dsh web --help` | Do not treat a passing `doctor` as a successful model call |
| Port already in use | `doctor` output and the official `dsh web` process | Do not use `killall node` against unrelated projects |
| Unsure which release to download | Read the [current release status](https://kamanager2012.github.io/deepseek-harness-handbook/en/11-operations/community-release-status/) | Do not treat the `package.json` code line as Stable |
| Want to try SDK / Checkpoint work | Enter [Community Labs](https://github.com/kamanager2012/deepseek-harness-suite) | Do not treat Labs as a release channel |

## Continue reading

- [Architecture boundary](../ARCHITECTURE.md)
- [Release guide](release.md)
- [Upgrade notes](upgrade.md)
- [Contract snapshots](../contracts/README.md)
- [Six-repository ecosystem](../ECOSYSTEM.md)
- [Official Runtime](https://github.com/deepseek-ai/deepseek-harness)
