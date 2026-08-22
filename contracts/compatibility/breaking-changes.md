# Official breaking changes we have actually hit

Record the delta here when contract CI or a pin bump hits a public-surface move.
Do not invent a compatibility shim in Desktop IPC.

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
