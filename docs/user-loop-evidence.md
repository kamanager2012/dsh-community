# Real user-loop evidence

This gate answers a different question from normal CI and `artifact-smoke`:

> Can an exact published dsh-community release create a real official DSH
> session, receive a real model answer, stop cleanly, resume that same official
> session, and receive another real answer?

It is intentionally **manual** and **billable**. It is not scheduled and does
not run on pushes or pull requests.

## Scope

The current workflow covers the **WSL/Linux Terminal (`dsh-community`) ↔ Official `dsh --profile headless` ↔ Linux AppImage bundled runtime (`official-dsh.tar`) ↔ Packaged Linux AppImage Electron GUI (`AppRun` under `xvfb-run`) cross-surface Session roundtrip** plus all four automated **Lifecycle recovery** checks (`missingKeyRefusal`, `interruptedRuntimeExtract`, `versionUpgrade`, and `offlineHandling`).

The evidence runner:

1. resolves an exact GitHub Release tag;
2. checks out that tag into a dedicated `release-src/` directory and records
   the resulting full 40-character Git commit SHA as the immutable tested
   source identity;
3. installs the exact tag with the frozen lockfile and builds the Terminal and
   Marketplace endpoints;
4. downloads the exact release Linux `.AppImage` + `.sha256`, verifies SHA-256,
   and extracts `squashfs-root` (including `AppRun` and
   `resources/host/official-dsh.tar`) without FUSE;
5. uses an isolated temporary `DSH_HOME`;
6. verifies missing-`DEEPSEEK_API_KEY` refusal leaves zero orphan sessions before
   recovering with `DEEPSEEK_API_KEY` set;
7. executes `verify_version_upgrade_recovery` against shipped
   `runtime-catalog.ts`, `runtime-view.ts`, and `profile.ts` to verify upgrade
   detection (`0.2.2-rc.2` -> `0.2.2-rc.3`), in-place profile bundle upgrade, and
   session/user patch preservation;
8. executes `verify_offline_handling` against shipped `plugin-catalog.ts`,
   `marketplace/src/client.ts` + `cli.ts`, and Desktop `marketplace.ts` +
   `pages.ts` to verify TUI fail-closed behavior and CLI/Desktop cached catalog
   fallback when offline;
9. starts `dsh-community new` in a real pseudo-terminal;
10. sends a randomized, non-tool prompt through `DSH_TUI_FIRST_PROMPT`;
11. waits for the real model to return the computed ACK marker;
12. exits cleanly;
13. proves exactly one official Session exists and that the launcher lists the
    same Session ID;
14. resumes that exact Session ID in `dsh-community`, sends a second randomized
    prompt, receives a second real model ACK, and exits;
15. proves resume did not create a second Session and that the official
    transcript advanced;
16. invokes the official `dsh --profile headless --session-id <id>` entrypoint
    against the same `DSH_HOME`, sends a third randomized prompt, receives a
    third real model ACK, and proves the official headless surface appended to
    the same Session without creating a second Session;
17. simulates an interrupted AppImage runtime extraction (partial temp files
    without `.dsh-host-ready`) and invokes the shipped Desktop extractor
    `ensureOfficialHostExtracted()` (`apps/desktop/src/host-extract.ts`) against
    that interrupted directory to prove clean wipe-and-re-extract recovery from
    `official-dsh.tar` before running `appimageBundledRuntimeHandoff` against
    the same Session ID to receive a fourth real model ACK;
18. boots the extracted packaged Linux AppImage Electron GUI (`AppRun` under
    `xvfb-run`) with pre-seeded `0.2.2-rc.2` `userData` against the shared
    `DSH_HOME`, connects over Chrome DevTools Protocol, verifies the `Session`
    tab (`#sessions-table`) lists the exact shared `session_id`, verifies the
    `Runtime` tab (`Version Manager`) and `runtime-versions.json` /
    `official-dsh/<version>/.dsh-host-ready` reflect the upgrade while keeping
    prior pin metadata, and closes with exit code `0`;
19. resumes that exact Session ID again in `dsh-community`, sends a fifth
    randomized prompt, receives a fifth real model ACK, and proves cross-surface
    Session roundtrip across `dsh-community-tui`, `official-dsh-headless`,
    `linux-appimage-bundled-runtime`, and `linux-appimage-electron-gui`;
20. publishes a sanitized JSON evidence artifact.

The artifact contains the release tag and exact tested Git commit SHA, plus a
SHA-256 of the Session ID rather than the Session ID itself. It does not export
the Session transcript or API key.

## Running it

The repository must have a GitHub Actions secret named `DEEPSEEK_API_KEY`.
Run the workflow from the repository's `main` branch. Leave the tag empty to
test GitHub Latest, or enter an exact release tag.

Credential scope is intentionally narrow:

- the repository token is exposed only to the exact-release resolution step;
- `DEEPSEEK_API_KEY` is exposed only to the explicit missing-secret check and
  the real model loop step;
- checkout, exact-tag `pnpm install`, build, and version verification do not
  receive either credential through job environment variables.

The workflow fails closed if the secret is missing. It never swaps in a mock
provider and never changes `docs/current-release.json` automatically.

## Evidence status policy

- Workflow exists but no successful exact-release run: `UNVERIFIED`.
- A successful exact-release Linux Terminal run: evidence-backed Linux user
  loop, but the overall cross-platform Distribution Reality Gate remains
  `PARTIAL` until the claimed packaged endpoints are tested at the same strength.
- Windows/macOS first-ready smoke is not equivalent to a full Desktop
  new/resume user loop.
- A run against `main` is not release evidence. The workflow tests an exact
  release tag in `release-src/` while the validator itself comes from the
  current repository revision.

When a real run succeeds, link its GitHub Actions run and sanitized evidence
artifact from the current release facts. Do not promote the status based only
on the existence of this workflow.
