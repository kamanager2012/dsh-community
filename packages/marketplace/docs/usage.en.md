# dsh-marketplace Usage and Data Flow

[简体中文](usage.md) · [Back to English README](../README.en.md) · [Online Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/en/)

## What it is

`dsh-marketplace` is plugin discovery and install UX. It reads this package's [`catalog.json`](../catalog.json), helps users search and inspect compatibility, and hands installation to the official `dsh plugin add` command.

It is not a Runtime, not a new Package Manager, and not the owner of user Sessions.

```text
packages/marketplace/catalog.json
              ↓ fetch / parse / classify
        dsh-marketplace
              ↓ official command
        dsh plugin add <name>
```

## Install

Node.js 22+ is required, and the official `dsh` CLI must be available on PATH. Source of truth is `dsh-community`; do not `npm i -g github:kamanager2012/dsh-marketplace`.

```sh
npm i -g @deepseek-ai/dsh
```

From source:

```sh
git clone https://github.com/kamanager2012/dsh-community
cd dsh-community
pnpm install
pnpm marketplace -- list
```

## Common commands

```sh
dsh-marketplace list
dsh-marketplace search <keyword>
dsh-marketplace info <package-name>
dsh-marketplace audit <package-name>
dsh-marketplace install [--yes] <package-name>[@version]
```

`list`, `search`, and `info` display registry verification lines.
`info` also displays digest, provenance, and `security` when present. Before
calling the official install chain, `install` compares the registry digest against npm
`dist.integrity`. Plugins with `requiresConfirmation` or non-`low` `risk` refuse unless
`--yes` is passed.

`audit` prints registry `security` when present; otherwise it falls back to a local
heuristic. Compatibility is not a live security scan.

## Read compatibility correctly

| Marker | Meaning |
| --- | --- |
| Matching `testedDsh` | The registry has evidence for that Runtime line |
| `⚠未验证` / `(未验证)` (unverified) | No matching line, stale evidence, or existence-only information (rendered as `[UNVERIFIED]` in other ecosystem docs) |

Compatibility is not trust. A plugin may read files, access the network, start processes, or mutate the system. Review its source, permission notes, and official install output before installing.

## First checks when something fails

1. Confirm `node --version` is 22+;
2. Confirm the official CLI is available with `dsh --help`;
3. Check whether the entry `testedDsh` matches the current Runtime;
4. Read the original error from official `dsh plugin add`, not only the Marketplace summary;
5. Check for undeclared credentials, network access, or system permissions.

Do not treat a successful catalog fetch, network request, or README claim as a successful plugin runtime test.

## Development and validation

```sh
npm install
npm run typecheck
npm run build
npm test
```

When catalog fields change, update this package's [`catalog.json`](../catalog.json) before changing presentation or parsing. Verify with `node scripts/verify.mjs` (`--offline` for shape only).

## Ecosystem links

- [Canonical Product: dsh-community](https://github.com/kamanager2012/dsh-community)
- [Plugin catalog](../catalog.json)
- [Archived Labs](https://github.com/kamanager2012/deepseek-harness-suite) (do not install from there)
- [Handbook plugin section](https://kamanager2012.github.io/deepseek-harness-handbook/en/10-plugins/)
- [Official Runtime](https://github.com/deepseek-ai/deepseek-harness)
