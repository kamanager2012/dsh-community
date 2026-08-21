# Upgrading official DSH

Official Harness is in developer preview and **will break**. This repo is designed so a bump is a pin change, not a source merge.

## Steps

1. Read the official changelog / `apps/cli` README for the new version.
2. Set `PINNED_DSH_VERSION` in `packages/dsh-bridge/src/pin.ts`.
3. Set the same exact version on every `package.json` that depends on `@deepseek-ai/dsh` (no `^`).
4. Update `docs/current-release.json` (and `docs/current-release.md`) in the same commit. Sister repos must link that file instead of copying numbers.
5. `pnpm install`
6. `pnpm test` and `pnpm typecheck`
7. If tests fail because the CLI surface moved:
   - readiness prefix / URL rules → `packages/dsh-bridge/src/readiness.ts`
   - launcher flags (`web`, `--profile`, `--dump-config`) → contract tests + spawn args
   - web flags (`--host`, `--port`) → `packages/dsh-bridge/src/spawn-web.ts`
8. Do **not** copy files out of `deepseek-ai/deepseek-harness`.
9. Refresh official snapshots: `pnpm contracts:extract`. Commit the diff and note any public-surface move in `contracts/compatibility/breaking-changes.md`.
10. Only then consider recommending the rc as `latest-tested`.

## What a failure means

| Failure | Meaning |
|---|---|
| version mismatch | pin file and lockfile disagree — finish the bump |
| `dsh --help` missing `web` | official launcher grammar changed — update the contract, then the spawn |
| readiness parser rejects the line | official print format changed — update the parser, keep loopback-only |
| no-vendored-core | someone added an official tree — delete it |
| snapshot mismatch | official public surface moved — update `contracts/upstream` and the bridge, not a Desktop protocol |

## TUI after a bump

TUI continues to depend on official `@deepseek-ai/dsh-*` packages as a **plugin**. Align its peer/pin with the same rc. Do not absorb TUI into this repo in order to upgrade. Measure patch-surface; do not grow overrides to “stay compatible”.
