# Upgrading official DSH

Official Harness is in developer preview and **will break**. This repo is designed so a bump is a pin change, not a source merge.

## Steps

1. Read the official changelog / `apps/cli` README for the new version.
2. Set `PINNED_DSH_VERSION` in `packages/dsh-bridge/src/pin.ts`.
3. Set the same exact version on every `package.json` that depends on `@deepseek-ai/dsh` (no `^`).
4. Update Candidate Source in `docs/current-release.json` (and the human index) in the same commit: `officialKernel.version`, `communityProduct.version`, `candidateTag`, and Dual-Badge move with the pin. Keep `communityProduct.githubLatestTag`, `assets` / `publishedAssets`, plugin `testedDsh`, and user-loop evidence on the last actually published/tested state until those independent gates pass. Sister repos must link that file instead of copying numbers.
5. `pnpm install`
6. `pnpm test` and `pnpm typecheck`
7. If tests fail because the CLI surface moved:
   - readiness prefix / URL rules → `packages/dsh-bridge/src/readiness.ts`
   - launcher flags (`web`, `--profile`, `--dump-config`) → contract tests + spawn args
   - web flags (`--host`, `--port`) → `packages/dsh-bridge/src/spawn-web.ts`
8. Do **not** copy files out of `deepseek-ai/deepseek-harness`.
9. Refresh official snapshots: `pnpm contracts:extract`. Commit the diff and note any public-surface move in `contracts/compatibility/breaking-changes.md`.
10. Only then consider recommending the candidate as `latest-tested`. Do not treat that as publication: GitHub Latest and published installer names move only when the release exists.

## Consolidated local acceptance

After the exact reconstructed alpha.3 baseline is an ancestor of the integration branch and
all hardening conflicts are resolved, run exactly one consolidated local gate:

```sh
node scripts/accept-alpha3-integration.mjs
```

The runner requires a clean non-main branch and verifies that the accepted
reconstructed baseline recorded in `remote-integration-gate.json` is an ancestor
of HEAD. It then verifies Candidate/Published identities, realizes the frozen pnpm
lock once, re-extracts contracts with zero drift, mirrors the runtime-lock install/audit
contract, and rejects any mixed-version `@deepseek-ai/dsh*` entry in the committed
runtime closure before running typecheck and the full Vitest
suite, and the offline marketplace check. It does not create a tag, open a PR,
dispatch Actions, or invoke a model/provider.

Do not use the old fixed `73 files / 290 tests` count as the final pass
criterion: hardening adds contract tests. The final criterion is the discovered
post-integration suite completing green in this single run.

## Remote integration gate

Do not open the alpha.3 pull request until the accepted reconstructed baseline is
integrated with the hardening commits and the
consolidated local acceptance suite has passed on the final tree.

A push to a non-main integration branch is the no-Actions staging path under the
current workflow triggers. Opening a pull request is not: the alpha.3 diff fans
out into CI, dependency audit, Linux/macOS package smoke, Windows package smoke,
runtime-lock verification, runtime-SBOM smoke, and artifact-action smoke.
Machine-readable state: `contracts/compatibility/remote-integration-gate.json`.

## Exact Desktop runtime closure

For prerelease candidates, an exact root dependency is not sufficient if upstream
packages depend on sibling DSH packages through prerelease ranges. A later
prerelease can otherwise enter a fresh npm resolution without changing the root
pin.

The Desktop runtime-only manifest therefore records explicit npm `overrides` for
the published DSH family. Acceptance checks the committed `package-lock.json`
across every package path ending in `node_modules/@deepseek-ai/dsh*`; every such
entry must equal the frozen candidate. Peer-resolved top-level DSH packages are
covered independently. Do not hand-edit registry integrity/resolved fields.

## Frozen candidate rule

An upstream prerelease discovered **after** an upgrade baseline has been frozen
does not silently replace that baseline. The current cycle is pinned in
`contracts/compatibility/upstream-candidate-watch.json`.

For this cycle, `0.1.2-alpha.3` is frozen. Upstream `0.1.2-alpha.4` was
published later and is recorded as `NEXT_UPGRADE_CYCLE`: its Web readiness
implementation and CLI argument parser are unchanged from alpha.3, but the
release interval contains substantive composition changes. Do not mix alpha.4
pins, lockfiles, snapshots, or evidence into the alpha.3 acceptance commit.
Advancing the target requires a new explicit upgrade cycle and fresh contract
extraction.

## What a failure means

| Failure | Meaning |
|---|---|
| version mismatch | pin file and lockfile disagree — finish the bump |
| `dsh --help` missing `web` | official launcher grammar changed — update the contract, then the spawn |
| readiness parser rejects the line | official print format changed — update the parser, keep loopback-only |
| no-vendored-core | someone added an official tree — delete it |
| snapshot mismatch | official public surface moved — update `contracts/upstream` and the bridge, not a Desktop protocol |

## TUI after a bump

TUI continues to depend on official `@deepseek-ai/dsh-*` packages as a **plugin**. Align its peer/pin with the same frozen candidate. Do not absorb TUI into this repo in order to upgrade. Measure patch-surface; do not grow overrides to “stay compatible”.
