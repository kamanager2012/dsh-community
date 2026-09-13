# archive/

Frozen historical material kept for reference. Nothing in this directory is
part of the pnpm workspace, the vitest suite, or any CI build — it is excluded
by construction (workspace globs are root-anchored) and must stay that way.

## deepseek-harness-suite/

The former standalone `deepseek-harness-suite` repository — the frozen
"Community Labs" line, superseded by `dsh-community`, last Labs pin
`0.1.0-rc.6`. Its full code and commit history were merged into this
repository on 2026-09-13; the standalone repository was deleted the same day.

- Do not install from this directory. Canonical downloads remain
  [`dsh-community/releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest).
- Branch tips of the former repository that were never merged into its `main`
  are preserved as tags `archive/suite/<branch>` (e.g.
  `archive/suite/work-probe-fix`).
- The in-tree `.github/` files are inert: GitHub only reads workflows from the
  repository root.
