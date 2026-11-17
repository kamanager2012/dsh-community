# Linux first-run source-install acceptance

This is a **real source installation and CLI startup** check on a disposable Linux runner, not a fake-pnpm unit test. It does **not** validate model/provider calls, the official Session resume loop, actual WSL2 hardware, or Android handsets.

## Scope

1. Create a disposable local bare Git origin pointing at the workflow's exact checked-out commit.
2. Run the actual `scripts/install-linux.sh` with `--ref acceptance --expected-commit <SHA>` and frozen dependency installation/build. This does not trust a mutable branch for its source identity.
3. Execute installed `dsh-community version`, `--help`, `sessions --porcelain`, `dsh-marketplace --help`, and `remote --help` from an isolated working directory.
4. Isolate `HOME` and `DSH_HOME`; unset `DEEPSEEK_API_KEY`. Verify the session store is empty and `doctor` exits **2** with a missing-key warning (expected safe refusal).
5. Emit a small JSON evidence file recording the commit, Node version, and checks. **No source contents, credentials, QR links, Git diff or conversation transcript** are uploaded.

Run [linux-first-run-smoke](../.github/workflows/linux-first-run-smoke.yml) on relevant PRs / main pushes, or dispatch it manually. It runs on Ubuntu CI with Node 24.

## Reproduce on an expendable Linux workspace

Prerequisites: Node.js >=24.9, pnpm, git, bash. In a clean repository checkout:

~~~bash
bash scripts/e2e/linux-first-run-smoke.sh /tmp/first-run-evidence.json
~~~

The script installs into an isolated temporary directory and deletes it on exit. It does not touch the existing official `~/.dsh`, but real `pnpm install` downloads packages from configured registries and may run dependency lifecycle scripts. Use a throwaway runner for untrusted repository content.

## Acceptance levels

| Claim | Verified by this workflow? |
| --- | --- |
| Actual source installation at pinned commit | Yes, on Ubuntu CI |
| Frozen pnpm build produces runnable CLI | Yes, on Ubuntu CI |
| Missing-key safe failure and empty official sessions | Yes, isolated home |
| Live model calls and true DSH Session continuation | **No**; see user-loop-evidence |
| Real WSL2, physical arm64 Android or cross-network | **No** |
| Published AppImage/APK cryptographic verification | **No**; see artifact-smoke |

For real adoption issues, use the [redacted first-run issue form](https://github.com/kamanager2012/dsh-community/issues/new?template=first-run-feedback.yml). Do not paste personal or secret data.
