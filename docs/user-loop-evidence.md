# Real user-loop evidence

This gate answers a different question from normal CI and `artifact-smoke`:

> Can an exact published dsh-community release create a real official DSH
> session, receive a real model answer, stop cleanly, resume that same official
> session, and receive another real answer?

It is intentionally **manual** and **billable**. It is not scheduled and does
not run on pushes or pull requests.

## Scope

The current workflow covers the **WSL/Linux Terminal (`dsh-community`) ↔ Official `dsh --profile headless` ↔ Linux AppImage bundled runtime (`official-dsh.tar`) cross-surface Session roundtrip** plus automated **Lifecycle recovery** checks. A passing Linux run is real evidence for Terminal, AppImage bundled runtime extraction/recovery, and cross-surface `DSH_HOME` Session handoff; it is not evidence that the packaged GUI Electron window interactive user loop has passed.

The evidence runner:

1. resolves an exact GitHub Release tag;
2. checks out that tag into a dedicated `release-src/` directory and records
   the resulting full 40-character Git commit SHA as the immutable tested
   source identity;
3. installs the exact tag with the frozen lockfile and builds the Terminal endpoint;
4. downloads the exact release Linux `.AppImage` + `.sha256`, verifies SHA-256,
   and extracts `resources/host/official-dsh.tar` without FUSE;
5. uses an isolated temporary `DSH_HOME`;
6. verifies missing-`DEEPSEEK_API_KEY` refusal leaves zero orphan sessions before
   recovering with `DEEPSEEK_API_KEY` set;
7. starts `dsh-community new` in a real pseudo-terminal;
8. sends a randomized, non-tool prompt through `DSH_TUI_FIRST_PROMPT`;
9. waits for the real model to return the computed ACK marker;
10. exits cleanly;
11. proves exactly one official Session exists and that the launcher lists the
    same Session ID;
12. resumes that exact Session ID in `dsh-community`, sends a second randomized
    prompt, receives a second real model ACK, and exits;
13. proves resume did not create a second Session and that the official
    transcript advanced;
14. invokes the official `dsh --profile headless --session-id <id>` entrypoint
    against the same `DSH_HOME`, sends a third randomized prompt, receives a
    third real model ACK, and proves the official headless surface appended to
    the same Session without creating a second Session;
15. simulates an interrupted AppImage runtime extraction (partial temp file,
    missing `.dsh-host-ready`), verifies clean wipe-and-re-extract recovery from
    `official-dsh.tar`, and invokes that recovered runtime against the same
    Session ID (`appimageBundledRuntimeHandoff`) to receive a fourth real model ACK;
16. resumes that exact Session ID again in `dsh-community`, sends a fifth
    randomized prompt, receives a fifth real model ACK, and proves cross-surface
    Session roundtrip across `dsh-community-tui`, `official-dsh-headless`, and
    `linux-appimage-bundled-runtime`;
17. publishes a sanitized JSON evidence artifact.

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
