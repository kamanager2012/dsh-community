# Linux first-run source-install acceptance

This is a **real source installation and CLI startup** check on a disposable Linux runner, not a fake-pnpm unit test. It does **not** validate model/provider calls, the official Session resume loop, actual WSL2 hardware, or Android handsets.

## Scope

1. Create a disposable local bare Git origin pointing at the workflow's exact checked-out commit.
2. Run the actual `scripts/install-linux.sh` with `--ref acceptance --expected-commit <SHA>` and frozen dependency installation/build. This does not trust a mutable branch for its source identity.
3. Execute installed `dsh-community version`, `--help`, `sessions --porcelain`, `dsh-marketplace --help`, and `remote --help` from an isolated working directory.
4. Isolate `HOME` and `DSH_HOME`; unset `DEEPSEEK_API_KEY`. Verify the session store is empty and `doctor` exits **2** with a missing-key warning (expected safe refusal).
5. Reinstall with a preexisting shared/setgid repo under `umask 027` using **real pnpm** with copy imports, then verify directory/file descendant GIDs, group read/traversal and installed CLI startup. When available, switch the repo to a supplementary group first.
6. Simulate a failed reinstall and verify the original CLI remains runnable and byte-identical; reject concurrent installation while either the prefix lock or the shared bin-dir lock is held.
7. Emit a small JSON evidence file recording the commit, Node version, and checks. **No source contents, credentials, QR links, Git diff or conversation transcript** are uploaded.

Run [linux-first-run-smoke](../.github/workflows/linux-first-run-smoke.yml) on relevant PRs / main pushes, or dispatch it manually. It runs on Ubuntu CI with Node 24.

## Reproduce on an expendable Linux workspace

Prerequisites: Node.js >=24.9, pnpm, git, bash, `flock` (util-linux). In a clean repository checkout:

~~~bash
bash scripts/e2e/linux-first-run-smoke.sh /tmp/first-run-evidence.json
~~~

The script installs into an isolated temporary directory and deletes it on exit. It does not touch the existing official `~/.dsh`, but real `pnpm install` downloads packages from configured registries and may run dependency lifecycle scripts. Use a throwaway runner for untrusted repository content.

The shell installer also preserves the prior repository's group ownership on an upgrade, and ignores secondary INT/TERM/HUP during handled-error rollback. These edges have fault-injection **unit tests**. Shared-setgid paths additionally have real Linux `pnpm` reinstallation and descendant GID/permission checks; this is still not a multi-user physical deployment acceptance. They are not evidence of power-loss/SIGKILL atomicity.

## Acceptance levels

| Claim | Verified by this workflow? |
| --- | --- |
| Actual source installation at pinned commit | Yes, on Ubuntu CI |
| Frozen pnpm build produces runnable CLI | Yes, on Ubuntu CI |
| Failed reinstall preserves the previously working CLI | Yes, injected pnpm failure in CI |
| Concurrent install refuses without touching active repo | Yes, held `flock` lock in CI |
| Different prefixes sharing bin-dir serialize shim publication | Yes, held shared bin lock while second real build reaches publish |
| Shared-setgid upgrade with real pnpm imports and descendant group access | Yes, real reinstall under umask 027; use pnpm copy import to avoid cache hardlink GID leakage |
| Missing-key safe failure and empty official sessions | Yes, isolated home |
| Live model calls and true DSH Session continuation | **No**; see user-loop-evidence |
| Real WSL2, physical arm64 Android or cross-network | **No** |
| Published AppImage/APK cryptographic verification | **No**; see artifact-smoke |

For real adoption issues, use the [redacted first-run issue form](https://github.com/kamanager2012/dsh-community/issues/new?template=first-run-feedback.yml). Do not paste personal or secret data.
