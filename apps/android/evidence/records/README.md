# Android Reality Gate evidence records

This directory is intentionally empty until real Android gate execution exists.

`reality-gate.json` remains the release-status source of truth, but every promoted
`PASS` claim must be backed by a version-bound JSON record in this directory.
`scripts/validate-android-evidence-backing.mjs` enforces that relationship in CI
and from `scripts/verify-android-release-ready.mjs`.

Accepted record kinds are:

- `carrier`
- `native-addon`
- `app-uid-preflight`
- `pty-app-uid`
- `ripgrep`
- `dsh-boot`
- `apk-arm64`
- `apk-x86_64`

Common mandatory fields:

- `schemaVersion: 1`
- `kind`
- `status: "PASS"`
- `officialDsh: "0.1.2-alpha.4"`
- offset-aware RFC3339 `capturedAt`
- full 40-hex `communityCommit`
- non-empty `producer`
- at least one artifact with a 64-hex SHA-256
- for device records, a SHA-256 `device.idHash` rather than a raw serial,
  Android API level, and ABI

A record does **not** promote a gate by itself. It only permits a matching PASS
claim to exist. Architecture blockers in `native-compatibility.json` still win;
for example, a fabricated ripgrep record cannot bypass the current missing
official Android package/path seam.
