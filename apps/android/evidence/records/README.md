# Android Reality Gate evidence records

This directory is intentionally empty until real Android gate execution exists.

`reality-gate.json` remains the release-status source of truth, but every promoted
`PASS` claim must be backed by a version-bound JSON record in this directory.
`scripts/validate-android-evidence-backing.mjs` enforces that relationship in CI
and from `scripts/verify-android-release-ready.mjs`.

Accepted record kinds are:

- `carrier-shell` — preliminary adb-shell executable evidence; never release carrier evidence
- `carrier-apk` — APK app-UID shared-lib/JNI carrier evidence; the only record that can back `gates.carrier`
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

## Record creation

Use `scripts/create-android-evidence-record.mjs` instead of hand-writing PASS
records. The creator hashes the transcript and artifacts itself, refuses raw
device serials, requires a full Community Git SHA and offset-aware capture time,
and writes with create-only semantics so an existing record cannot be silently
overwritten.

Example preliminary shell capture after a successful real-device executable probe:

```bash
node scripts/create-android-evidence-record.mjs \
  --kind carrier-shell \
  --transcript /path/to/carrier-shell.log \
  --artifact node-shell=/path/to/node \
  --out apps/android/evidence/records/carrier-shell.json \
  --community-commit <40-hex-sha> \
  --captured-at 2026-09-02T22:45:00+08:00 \
  --device-id-hash <sha256-of-device-id> \
  --api-level 35 \
  --abi arm64-v8a
```

That record is explicitly non-release evidence. A release carrier record must instead use `--kind carrier-apk`, include `--artifact libnode=<path/to/libnode.so>`, and its transcript must contain both the shared-build success marker and the real APK app-UID/JNI marker `ANDROID_APK_NODE_CARRIER_OK node=22.19.0 platform=android`.

The creator recognizes only explicit success markers from the corresponding
manual/embedded gates. It cannot create ripgrep PASS evidence while the official
Android package/path seam is unresolved.
