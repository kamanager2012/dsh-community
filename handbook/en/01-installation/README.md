# Installation and first launch

## What are you installing?

There are two common ways to use dsh:

1. run the published CLI temporarily through npm;
2. clone the upstream repository and run from source.

For normal use, choose npm. Choose source when you need to read the code, develop
plugins, or control the complete repository build chain.

## Runtime prerequisites

The Web UI and CLI require Node.js. The current upstream guide requires Node.js 22.19+
or 24+; after upgrades, follow the repository's `engines`, development guide, and
command help.

```bash
node --version
npm --version
```

Source builds also require Git and pnpm. Use Corepack and do not mix multiple major
pnpm versions in one workspace:

```bash
corepack enable
pnpm --version
git --version
```

The Python SDK has separate Python, platform, Git, and isolated-workspace requirements.

## Shortest launch path

```bash
npx @deepseek-ai/dsh web
```

The default local address is:

```text
http://127.0.0.1:3080
```

Open the address printed by the terminal. Do not bind to a public network interface
for a first run, and do not select a production directory containing secrets as the
workspace.

## Community distribution entry

The community distribution entry for normal users is
[`dsh-community`](https://github.com/kamanager2012/dsh-community/releases/latest), not
Suite, Edition, Marketplace, or Plugins.

- Exact Published Latest version, Linux AppImage asset names, SHA-256 digests, keyless cosign bundles, and gate boundaries live in [`current-release.json`](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json) and [current Community release status](../11-operations/community-release-status.md) (current Latest: `v0.2.2-rc.3`, 1:1 with official kernel `@deepseek-ai/dsh@0.2.2-rc.3`).
- Under Complementary Edition, Windows and macOS Desktop installers belong upstream in `deepseek-ai/deepseek-harness` (retired from Community after historical `v0.1.1-rc.2`). Historical independent numbers `v0.1.2`–`v0.1.6` are not a download entry.
- Desktop and TUI display the Dual-Badge: `DeepSeek Harness Community v0.2.2-rc.3 [Official Core: @deepseek-ai/dsh@0.2.2-rc.3]`.

## Pin versions

Developer Preview releases may introduce breaking changes. For teams and CI, pin the
package version:

```bash
npx --yes @deepseek-ai/dsh@VERSION web
```

Replace `VERSION` with the approved version and record Node.js, Provider, model, and
profile information during upgrades. A successful npm download is not proof of
compatibility.

## First check after installation

1. Confirm that the Web UI opens.
2. Configure a Provider under **Settings → Models**.
3. Select a workspace with no important uncommitted changes.
4. Send a read-only task.
5. Check `git status`, `git diff --stat`, and the project's own test command.
6. Only then decide whether writing should be allowed.

Keep a redacted copy of errors. Never upload the full shell environment or credential
files for troubleshooting.
