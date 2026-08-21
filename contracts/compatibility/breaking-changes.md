# Official breaking changes we have actually hit

Record the delta here when contract CI or a pin bump hits a public-surface move.
Do not invent a compatibility shim in Desktop IPC.

## 0.1.0-rc.8

- surface: cli / readiness
- what moved:
  - Local `dsh web` now opens the default browser after the Loader tree settles.
  - Official prints `dsh web: opening the default browser; pass --no-open to disable` on the same prefix as the bind URL.
  - `dsh web --help` adds `--no-open` and repeatable `--trusted-host`.
  - Official release notes: SQLite session storage format is incompatible with earlier rcs.
  - Web default-config grew additively (129 → 135 rows): `session-reference`, `file-reference-local`, `ui-renderer`, `ui-brand-official`, `ui-attachment`, `ui-reference`. Required session/agent/approval/plugin domain rows still exist.
- community action:
  - Bump pin to `0.1.0-rc.8` (official GitHub current release / npm `next`; npm `latest` is still `0.1.0-rc.7`).
  - Desktop spawn passes `--no-open` so the Electron shell does not also hand off to a system browser.
  - Readiness parser skips non-URL `dsh web:` lines; still fail-closed on non-loopback binds.
  - Re-extract `contracts/upstream`. Do not migrate official `~/.dsh` SQLite.

## 0.1.0-rc.N

- surface: cli | config-row | package | readiness
- what moved:
- community action: bump pin / edit dsh-bridge / update snapshot
