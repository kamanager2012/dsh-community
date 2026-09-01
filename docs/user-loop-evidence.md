# Real user-loop evidence

This gate answers a different question from normal CI and `artifact-smoke`:

> Can an exact published dsh-community release create a real official DSH
> session, receive a real model answer, stop cleanly, resume that same official
> session, and receive another real answer?

It is intentionally **manual** and **billable**. It is not scheduled and does
not run on pushes or pull requests.

## Scope

The current workflow covers the **WSL/Linux Terminal** endpoint only. A passing
Linux run is real evidence for that endpoint; it is not evidence that the
Windows/macOS packaged Desktop user loop has passed.

The evidence runner:

1. resolves an exact GitHub Release tag;
2. checks out that immutable tag into a dedicated `release-src/` directory;
3. installs the exact tag with the frozen lockfile and builds the Terminal endpoint;
4. uses an isolated temporary `DSH_HOME`;
5. starts `dsh-community new` in a real pseudo-terminal;
6. sends a randomized, non-tool prompt through `DSH_TUI_FIRST_PROMPT`;
7. waits for the real model to return the computed ACK marker;
8. exits cleanly;
9. proves exactly one official Session exists and that the launcher lists the
   same Session ID;
10. resumes that exact Session ID, sends a second randomized prompt, receives a
    second real model ACK, and exits;
11. proves resume did not create a second Session and that the official
    transcript advanced;
12. publishes a sanitized JSON evidence artifact.

The artifact contains a SHA-256 of the Session ID, not the Session ID itself.
It does not export the Session transcript or API key.

## Running it

The repository must have a GitHub Actions secret named `DEEPSEEK_API_KEY`.
Then use **Actions → user-loop-evidence → Run workflow**. Leave the tag empty
to test GitHub Latest, or enter an exact release tag.

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
