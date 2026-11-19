# Official breaking changes we have actually hit

Record the delta here when contract CI or a pin bump hits a public-surface move.
Do not invent a compatibility shim in Desktop IPC.

## 0.2.2-rc.5

- surface: package / runtime-closure / pin (non-breaking web & CLI surface)
- what moved:
  - Candidate Source AND Community Product Version are synced 1:1 at `0.2.2-rc.5` (`@deepseek-ai/dsh@0.2.2-rc.5`, `next` dist-tag, published `2026-11-18T13:17:23.604Z`; upstream tag `dsh-v0.2.2-rc.5`, release commit `9bf478edde5b14e6a15d3802a8834bdca83f2d97`, merge commit `9c2670d3bce5275e0d1610272958121af87787bb`, 13 commits / 300 changed files from `dsh-v0.2.2-rc.3`). `engines.node` remains `>=24.9.0`.
  - Official Web default config snapshot (`202` rows), published package snapshot (`198` entries), `exports`, and `cli` surfaces are unchanged in shape from `0.2.2-rc.3`.
  - Upstream `0.2.2-rc.4`–`0.2.2-rc.5` includes DeepSeek `safetyCheck` / refusal handling, `liveshare` clock & tunnel Electron Node fixes, and `web-search-deepseek` model defaults; `packages/util/ripgrep/src/index.ts` (blob `e9ca71e63618acc75b8cd3308d38c42e423354f8`), `packages/bundle/web-app/src/index.ts` (blob `b93b559620fe9a064b6ff24e0b2ed3bf22b3f6dd`), `apps/cli/src/args.ts` (blob `41d4ebeaa832473b25952af1b185e02a7c182844`), and `apps/cli/reference/README.md` (blob `dc84a267d8bd1f59758ca02b1fde0fee4d0ef825`) remain unchanged.
  - Community `apps/desktop/runtime-lock` stays at **676 total / 328 `@deepseek-ai/dsh*` packages** pinned cleanly to `0.2.2-rc.5`, retaining `zod@4.6.7` and `undici@^8.12.2` security overrides.
- community action:
  - Bump `PINNED_DSH_VERSION`, `COMMUNITY_PRODUCT_VERSION` (`0.2.2-rc.5`), workspace manifests, TUI official peers, Android target manifests/scripts, and Desktop runtime lock overrides/lifecycle policy to `0.2.2-rc.5`.
  - Re-extract `contracts/upstream` snapshots (`config-rows` 202, `packages` 198, `exports`, `cli`).
  - Regenerate CI-attested `apps/desktop/runtime-lock/package-lock.json` and `evidence.json` on `ubuntu-24.04` (Node `v22.23.5`, npm `10.9.9`, run `44438093968`), verify clean `pnpm audit` and `npm audit`, keep Android `[UNVERIFIED]` / `BLOCKED`, and keep `Published Latest` (`v0.2.2-rc.3`) independent until `v0.2.2-rc.5` is released.

## 0.2.2-rc.3

- surface: package / runtime-closure / pin (non-breaking web surface)
- what moved:
  - Candidate Source AND Community Product Version are synced 1:1 at `0.2.2-rc.3` (`@deepseek-ai/dsh@0.2.2-rc.3`, `next` dist-tag, published `2026-11-13T08:05:45.455Z`; upstream tag `dsh-v0.2.2-rc.3`, release commit `4c1cf20cb1fa6dd021a6988454df1df853209f63`, merge commit `38a6a5c965aa99ab525161efb7cc5cf1fe62fced`). `engines.node` remains `>=24.9.0`.
  - Official Web default config snapshot (`202` rows), published package snapshot (`198` entries), `exports`, and `cli` surfaces are unchanged in shape from `0.2.2-rc.2`.
  - `@deepseek-ai/dsh@0.2.2-rc.3` adds experimental dependency `@deepseek-ai/dsh-deepseek-chat-import@0.2.2-rc.3` plus Windows installer `restart-status` fixes upstream; `packages/util/ripgrep/src/index.ts` (blob `e9ca71e63618acc75b8cd3308d38c42e423354f8`), `packages/bundle/web-app/src/index.ts` (blob `b93b559620fe9a064b6ff24e0b2ed3bf22b3f6dd`), `apps/cli/src/args.ts` (blob `41d4ebeaa832473b25952af1b185e02a7c182844`), and `apps/cli/reference/README.md` (blob `dc84a267d8bd1f59758ca02b1fde0fee4d0ef825`) remain unchanged.
  - Community `apps/desktop/runtime-lock` grows **327 → 328** `@deepseek-ai/dsh*` packages pinned cleanly to `0.2.2-rc.3`, retaining `zod@4.6.7` and `undici@^8.12.2` security overrides.
- community action:
  - Bump `PINNED_DSH_VERSION`, `COMMUNITY_PRODUCT_VERSION` (`0.2.2-rc.3`), workspace manifests, TUI official peers, Android target manifests/scripts, and Desktop runtime lock overrides/lifecycle policy to `0.2.2-rc.3`.
  - Re-extract `contracts/upstream` snapshots (`config-rows` 202, `packages` 198, `exports`, `cli`).
  - Regenerate CI-attested `apps/desktop/runtime-lock/package-lock.json` and `evidence.json` on `ubuntu-24.04` (Node 22, npm 10), verify clean `pnpm audit` and `npm audit`, keep Android `[UNVERIFIED]` / `BLOCKED` / `NOT_RUN`, and keep `Published Latest` (`v0.2.2-rc.2`) independent until `v0.2.2-rc.3` is released.

## 0.2.2-rc.2

- surface: package / config-row / exports / ripgrep-seam / pin
- what moved:
  - Candidate Source is `@deepseek-ai/dsh@0.2.2-rc.2` (`next` dist-tag, published `2026-11-12T02:16:12.076Z`; upstream tag `dsh-v0.2.2-rc.2`, release commit `91319233e1e6ee64da0cb769dd10c9b4c4f95768`, merge commit `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`). `engines.node` remains `>=24.9.0`.
  - Official Web config snapshot grows **196 → 202** rows: added `agent-team`, `tool-agent-team`, `mcp-manager`, `ui-agent-team`, replaced `account-controller` with `ui-account-notifications`, and replaced `office-to-pdf` with `office-kit` + `workspace-dependencies` + `skill-office`.
  - Published package snapshot grows **192 → 198** entries: promoted `@deepseek-ai/dsh-agent-team` and `@deepseek-ai/dsh-tool-agent-team`, added `@deepseek-ai/dsh-client-ui-account-notifications`, `@deepseek-ai/dsh-client-ui-agent-team`, `@deepseek-ai/dsh-mcp-manager`, `@deepseek-ai/dsh-office-kit`, `@deepseek-ai/dsh-skill-office`, `@deepseek-ai/dsh-tool-workspace-dependencies`, and updated `@deepseek-ai/dsh-deepseek-account`.
  - `@deepseek-ai/dsh` `exports` / `files` adds `lib/*.js.map`, `lib/types/*.d.ts.map`, `docs`, and `src`.
  - `@deepseek-ai/dsh-tool-fs-search/src/search-core.ts` now imports `spawnRipgrep` and re-exports `resolveRgPath` from `@deepseek-ai/dsh-util-ripgrep` (`packages/util/ripgrep/src/index.ts`); `resolveRgPath()` semantics remain zero-argument `@vscode/ripgrep` (`1.18.0`) + `process.pkg` sidecar only (`NO_LEGITIMATE_ANDROID_EXECUTABLE_PATH`).
  - Community `apps/desktop/runtime-lock` grows **320 → 327** `@deepseek-ai/dsh*` packages pinned cleanly to `0.2.2-rc.2`, retaining `zod@4.6.7` and `undici@^8.12.2` security overrides.
- community action:
  - Bump `PINNED_DSH_VERSION`, `COMMUNITY_PRODUCT_VERSION`, workspace manifests, TUI official peers, Android target manifests/scripts, and Desktop runtime lock overrides/lifecycle policy to `0.2.2-rc.2`.
  - Re-extract `contracts/upstream` snapshots (`config-rows` 202, `packages` 198, `exports`, `cli`).
  - Point Android ripgrep seam & CLI closure audits at `@deepseek-ai/dsh-util-ripgrep` while keeping Android `[UNVERIFIED]` / `BLOCKED` / `NOT_RUN`.
  - Regenerate CI-attested `apps/desktop/runtime-lock/package-lock.json` and `evidence.json` on `ubuntu-24.04` (Node 22, npm 10), verify clean `pnpm audit` and `npm audit`, and keep `Published Latest` (`v0.1.1-rc.2`) independent until explicitly released.

## 0.2.2-rc.1

- `@deepseek-ai/dsh-tui`: `installModelSelection(agentCtx)` dropped its second parameter (`packages/tui/src/index.ts`).
- Presets / domains split: `agent-presets` and `@deepseek-ai/dsh-agent-presets` were replaced by `agent-preset-registry` (`@deepseek-ai/dsh-agent-preset`, `@deepseek-ai/dsh-agent-preset-registry`) plus `preset-standard`, `preset-ptc`, `preset-minimal`, and `preset-cordis`.
- Config / package / export surface (`contracts/upstream`): `web` config rows expanded `145 -> 196` (7 removed including `agent-presets`, `code-runtime`, `skill-badge`, `tool-ralph`, `tool-str-replace-editor`, `tool-subagent-list-agents`, `workflow-worker-thread`; 58 added) and packages expanded `144 -> 192`; root `@deepseek-ai/dsh` exports added `lib/types/*.d.ts` and moved `engines.node` from `^22.19.0 || >=24.0.0` to `>=24.9.0`.
- Web auth token exchange redirect: official Web now redirects to relative `./` instead of `/` (`packages/dsh-bridge/tests/official-web.smoke.test.ts`).
- Runtime / native closure shifts: `@deepseek-ai/node-addon-landlock-run@0.1.1` was replaced by `@deepseek-ai/node-addon-system@0.1.2` (keeping `src/main.c` and the `landlock-run` CLI contract), `koffi` resolved to `3.1.1` (was `3.1.6`), `sharp` / `@img/sharp-wasm32` moved to `0.35.5` (was `0.35.4`), and `tool-fs-search/src/search-core.ts` (Git blob `794a5d43fe6026c34cb61d65133ee715ed08b2f0`) added `.asar.unpacked` handling for Electron while `resolveRgPath()` still has no Android executable-path seam.

## 0.1.2-alpha.4

- surface: package / config-row / profile composition / runtime closure
- what moved:
  - Candidate Source is exactly `@deepseek-ai/dsh@0.1.2-alpha.4`; `latest-tested` remains alpha.3 until consolidated acceptance passes, and GitHub Published Latest remains the independently recorded rc.2 release.
  - The exact npm registry gate passed before the bump: `npm view @deepseek-ai/dsh@0.1.2-alpha.4 version` returned `0.1.2-alpha.4`.
  - Launcher/Web must-contain grammar is unchanged: `--profile`, `--dump-config`, `--dump-default-config`, `web`, `plugin`; Web still exposes `--host`, `--port`, `--no-open`; readiness prefix remains `dsh web: `. The alpha.3 one-time browser token exchange contract is unchanged.
  - Official Web config snapshot shrinks **146 → 145** rows: `tool-subagent-report` is removed and no config-row id is added.
  - Published package snapshot shrinks **145 → 144** entries: `@deepseek-ai/dsh-tool-subagent-report` is removed and no published package is added.
  - Root `@deepseek-ai/dsh` package surface is unchanged apart from version: bin remains `lib/bin.js`, ESM remains `type: module`, and published files remain `lib/*.js`.
  - Official CLI/profile documentation now explicitly includes `acp`, `sdk`, and `sdk-minimal` profiles and updated Web tool composition. This is a composition/documentation move even though the launcher argument parser blob is unchanged.
  - Regenerated Desktop runtime lock contains **580 package entries** and **214 DSH-family lock entries**, all exactly alpha.4; alpha.3 occurs zero times in both committed runtime and pnpm locks.
  - The reviewed lifecycle package-name set is unchanged: allow `dsh-subprocess-local`, `koffi`, `node-pty`, `protobufjs`; deny `@google/genai`. Their resolved versions move with the alpha.4 closure.
  - pnpm supply-chain gating surfaced 29 DSH packages that required explicit exact alpha.4 entries in `minimumReleaseAgeExclude`; they are enumerated rather than replaced by a broad namespace exemption.
- community action:
  - Keep every direct Candidate Source pin and TUI official peer exact at `0.1.2-alpha.4`; no semver ranges.
  - Keep the complete Desktop DSH-family npm override closure exact at alpha.4 and continue resolving lifecycle package paths from the committed lock topology rather than assuming hoisting.
  - Re-extract all four `contracts/upstream` snapshots and preserve the measured one-row/one-package removal.
  - Keep `latest-tested` at alpha.3 until final alpha.4 consolidated acceptance passes. Keep Published Latest, published installer evidence, plugin `testedDsh`, and User-Loop evidence independent.

## 0.1.2-alpha.3

- surface: package / config-row / published-files
- what moved:
  - Candidate Source is exactly `@deepseek-ai/dsh@0.1.2-alpha.3`; GitHub Published Latest remains the independently recorded rc.2 release.
  - Launcher and Web CLI must-contain grammar is unchanged: `--profile`, `--dump-config`, `--dump-default-config`, `web`, `plugin`, plus Web `--host`, `--port`, `--no-open`; readiness prefix remains `dsh web: `.
  - Official Web config snapshot grows **135 → 146** rows. Added ids: `deepseek-llm-api-extensions`, `plugin-package-inventory-deepseek`, `session-controller`, `session-log-deepseek`, `session-turn-outline`, `settings-controller`, `subagent-model-selection-settings`, `ui-approval`, `ui-chat`, `ui-schedule`, `ui-session`, `web-fetch-http`, `workspace-controller`. Removed ids: `api-gateway`, `client-runtime`.
  - Published package snapshot grows **134 → 145** entries. Added: `dsh-api-session-controller`, `dsh-api-settings-controller`, `dsh-api-workspace-controller`, `dsh-client-ui-approval`, `dsh-client-ui-chat`, `dsh-client-ui-schedule`, `dsh-client-ui-session`, `dsh-deepseek-llm-api-extensions`, `dsh-plugin-package-inventory-deepseek`, `dsh-session-log-deepseek`, `dsh-session-turn-outline`, `dsh-tool-subagent/model-selection-settings`, `dsh-web-fetch-http`. Removed: `dsh-client-runtime`, `dsh-host-apiproxy`.
  - The published CLI manifest no longer ships a top-level `config` directory in `files`; it ships `lib/*.js` only. Community code must use the supported profile/config-tree surface instead of assuming packaged config files.
  - npm resolution after alpha.4 publication can otherwise produce a mixed runtime (alpha.3 root with alpha.4 DSH transitive packages). The Desktop runtime lock therefore freezes the complete published DSH family to alpha.3 and verifies zero mixed-family versions.
- community action:
  - Keep every direct Candidate Source pin and TUI official peer exact at `0.1.2-alpha.3`; no semver ranges.
  - Regenerate pnpm and Desktop runtime locks from the exact candidate; preserve the reviewed five-package lifecycle-script name set.
  - Re-extract all four `contracts/upstream` snapshots and record the row/package removals rather than hiding them behind compatibility shims.
  - Keep `latest-tested` on rc.2 until the final integrated typecheck/full test/runtime acceptance gate passes.
  - Treat upstream alpha.4 as a separate upgrade cycle; do not mix alpha.4 packages or evidence into this baseline.

## 0.1.1-rc.2

- surface: package / pin / config-row
- what moved:
  - Official GitHub current and npm `latest`/`next` are `@deepseek-ai/dsh@0.1.1-rc.2`.
  - No public-surface move vs our rc.1 pin: `web --dump-default-config` stays at 135 rows with identical ids and order; launcher and web flags unchanged.
  - Image-attachment domain only (static tarball diff): `dsh-goal` / `dsh-session-reference` add an optional `originalDimensions` on `ImageAttachmentRef`; `dsh-tool-fs` trims the `read_image` schema description. Optional/additive; nothing removed.
  - `web --help` shows repeatable `--trusted-host` (present since the rc.8 lineage); must-contain checks unaffected.
- community action:
  - Bump pin and every workspace `package.json` to `0.1.1-rc.2` (1:1 mirror).
  - Re-extract `contracts/upstream`. Keep Node `>=22.15.0`.
  - Cut `v0.1.1-rc.2` as GitHub Latest when ready; first signed release under keyless cosign.

## 0.1.1-rc.1

- surface: package / pin
- what moved:
  - Official GitHub current and npm `latest`/`next` are `@deepseek-ai/dsh@0.1.1-rc.1`.
  - `dsh web --help` still includes `--host`, `--port`, `--no-open`.
  - Desktop spawn keeps `--no-open`; readiness still skips non-URL `dsh web:` lines.
- community action:
  - Bump pin and every workspace `package.json` to `0.1.1-rc.1` (1:1 mirror, no `-community.N`).
  - Re-extract `contracts/upstream`. Keep Node `>=22.15.0`.
  - Cut `v0.1.1-rc.1` as GitHub Latest. Do not rewrite historical `v0.1.2` / `v0.1.6` tags.

## 0.1.0-rc.8

- surface: cli / readiness
- what moved:
  - Local `dsh web` now opens the default browser after the Loader tree settles.
  - Official prints `dsh web: opening the default browser; pass --no-open to disable` on the same prefix as the bind URL.
  - `dsh web --help` adds `--no-open` and repeatable `--trusted-host`.
  - Official release notes: SQLite session storage format is incompatible with earlier rcs.
  - Web default-config grew additively (129 → 135 rows): `session-reference`, `file-reference-local`, `ui-renderer`, `ui-brand-official`, `ui-attachment`, `ui-reference`. Required session/agent/approval/plugin domain rows still exist.
  - `@deepseek-ai/dsh-session-persistence-jsonl` imports `createZstdDecompress` from `node:zlib` (Node 22.15+). Official `dsh web` exits before readiness on 22.14.
- community action:
  - Bump pin to `0.1.0-rc.8` (official GitHub current release / npm `next`; npm `latest` is still `0.1.0-rc.7`).
  - Desktop spawn passes `--no-open` so the Electron shell does not also hand off to a system browser.
  - Readiness parser skips non-URL `dsh web:` lines; still fail-closed on non-loopback binds.
  - Re-extract `contracts/upstream`. Do not migrate official `~/.dsh` SQLite.
  - Raise workspace `engines.node` to `>=22.15.0`. Do not vendor or patch official zlib imports.

## 0.1.0-rc.N

- surface: cli | config-row | package | readiness
- what moved:
- community action: bump pin / edit dsh-bridge / update snapshot
