# Release order

Official `@deepseek-ai/dsh` is the **development foundation**. We build TUI and Desktop on the pinned official runtime. A newer official rc is an upgrade of that foundation (pin + contract extract), not a gate that pauses product work.

Candidate Source and Published Latest both live in
[`current-release.json`](current-release.json), but they are independent states.
A source bump moves the candidate core/product/tag and Dual-Badge with `pin.ts`;
it does **not** move GitHub Latest, published installer names, plugin evidence, or
user-loop evidence. `publishedReleaseEvidence` records the real GitHub release
ID plus primary asset IDs/digests, and `scripts/validate-published-latest.mjs`
re-checks those facts against GitHub before a release tag can enter the build
matrix. See [Version and identity policy](version-policy.md).

## Channels

| Channel | Tag | Notes |
|---|---|---|
| Latest-eligible official-core mirror | `vX.Y.Z` or `vX.Y.Z-rc.N` | Community version exactly mirrors the official core; may become GitHub Latest |
| Upstream prerelease candidate | `vX.Y.Z-alpha.N`, `vX.Y.Z-beta.N`, etc. | Candidate/testing channel only; GitHub pre-release, never displaces Published Latest |
| Community patch | `vX.Y.Z[-prerelease]-community.N` | Community-owned fix on the same official core; GitHub pre-release |

Windows and macOS Desktop installers (`DSH Community Setup *.exe`, `dsh-community-*.dmg`) are **retired** after historical `v0.1.1-rc.2` under the **Complementary Edition** policy — official `deepseek-ai/deepseek-harness` owns Windows (`win-x64`) and macOS (`mac-arm64`, `mac-x64`) Desktop releases. Future `dsh-community` releases build Linux (`ubuntu-latest`) AppImage + CycloneDX SBOM only.

## Fail-closed, create-only release provenance

Release publication must be a **new immutable version**, not a backfill of missing assets
to an existing Release. The tagged workflow does not run `gh release upload` or
`gh release edit` on an existing tag. It refuses to proceed if a Release already
exists and uses `gh release create --verify-tag`; the GitHub API remains the
final arbiter if another publisher races the preflight.

**GitHub CLI atomicity boundary:** `gh release create` with assets uses
separate Draft → upload → publish API requests. Only a *published* release is
locked by GitHub's immutable release setting; a failed command may leave a
Draft behind. Keep such drafts quarantined for review. Never treat a retry
that appends to an existing Draft/Release as an immutable new publication;
review a fresh version and unused Tag for recovery. Do not claim that
workflow-level duplicate detection makes all asset uploads atomic.

**P1/P2 tag and Draft-window defense:** The tagged workflow now requires
active tag-update/deletion Ruleset protection for **both** `refs/tags/v*`
and `refs/tags/release-attempt-v*` during the Draft upload window, not
only a point-in-time Git SHA check. GitHub repository Release Immutability
should also be enabled before the next release; it becomes effective only
after publication.

Before `gh release create`, the publish job creates
`refs/tags/release-attempt-<TAG>` using the Git References create-only API.
The marker is **independent of the Draft**: if a partial upload fails and
GitHub CLI deletes the Draft, the marker remains and replay of the same
version fails closed. Do not delete or retarget the marker to retry; audit
the failure and cut a fresh version.

**Policy inspection credential gate:** GitHub
does not disclose `bypass_actors` to the built-in `github.token`.
When `vars.DSH_RELEASE_POLICY_APP_CLIENT_ID` and
`secrets.DSH_RELEASE_POLICY_APP_PRIVATE_KEY` are configured in the protected
`release-policy-audit` environment, the tagged pipeline mints a one-hour,
repository-scoped **GitHub App installation token** (pinned
`actions/create-github-app-token@v3.3.0`, `Administration: write` + `Contents: read`)
and runs strict bypass-actor inspection via `scripts/release-governance.mjs`.

When no external GitHub App credential is configured (single-maintainer repository mode,
where GitHub server-side **Release Immutability**, **Tag Ruleset `protect-release-tags`**
covering `refs/tags/v*` + `refs/tags/release-attempt-v*` with empty `bypass_actors`,
and the protected **`release-policy-audit`** environment with human deployment approval
are active on `kamanager2012/dsh-community`), the pipeline runs `scripts/release-governance.mjs`
with `github.token --allow-omitted-bypass-actors`: it still enforces active tag ruleset
coverage (`update` + `deletion`, zero unknown exclusions), rejects any non-empty
`bypass_actors` whenever disclosed, and verifies the `release-attempt-*` marker is absent (`404`).

In strict default mode (unit tests and App-token mode), `verifyTagProtection` continues
to reject omitted `bypass_actors` (`undefined`) as well as non-empty bypass lists.
See [Issue #181](https://github.com/kamanager2012/dsh-community/issues/181)
for the repository governance audit record.

The local `scripts/release.mjs` now independently checks that the working branch
is `main`, its exact HEAD equals the current remote `main`, and neither local
nor remote already contains the requested tag. It runs this check **before**
installation/tests and **again immediately before** tagging and pushing.
The tagged GitHub Actions build verifies that its `GITHUB_SHA`, the peeled remote
tag commit, and current reviewed remote `main` are the same at the start and
again immediately before publication. A moved tag, stale branch, duplicate tag,
or release replay fails closed. Multiple runs on the same tag are serialized.

These guards do not by themselves activate GitHub repository-level immutable
release settings or a protected-tag ruleset. Maintainers must enforce those
settings separately; a repository administrator can otherwise edit a Release
outside this workflow. If the reviewed `main` moves before the tag builds,
review a new candidate and cut a fresh unused tag rather than moving an old one.

## Cut a release


```sh
pnpm typecheck && pnpm test          # gate
: "${REVIEWED_NEW_TAG:?Set a newly approved and unpublished release tag}"
node scripts/release.mjs "$REVIEWED_NEW_TAG"
```

Replace the example tag with the next intended community version. If the change
only advances the official core, use the exact official version. If it is a
community-only fix on the same core, increment `-community.N`.
Published Latest is tracked in [`current-release.json`](current-release.json) and points at
[releases/latest](https://github.com/kamanager2012/dsh-community/releases/latest).
Do not download historical `v0.1.2`–`v0.1.6` as the current product. Never move
or overwrite a published tag.

The script checks a clean tree and a free tag, then runs the canonical release-identity validator before building the AppImage locally and pushing the tag. The GitHub `release` workflow independently runs the same validator on the pushed tag **before any build starts**; a manually pushed tag cannot bypass the workspace/pin/current-release/CHANGELOG identity checks. Non-tag `workflow_dispatch` remains available for diagnostic builds. The tag push then builds the Complementary Edition release set on `ubuntu-latest`:

1. **Linux** — typecheck + test + AppImage + sha256
2. **Runtime SBOM** — official-runtime CycloneDX JSON + sha256

The `publish` job collects all assets and creates the GitHub Release using `scripts/release-notes.mjs` (pairing the CHANGELOG section with quick-start and verification guidance, plus `--title` Dual-Core framing). Only plain `vX.Y.Z` or `vX.Y.Z-rc.N` tags are eligible for `--latest`. Any other prerelease identifier, including `alpha`, `beta`, `preview`, or `community.N`, is forced to `--prerelease`.

## Promote Published Latest facts after publication

Publishing and source promotion are deliberately separate operations.

For an `alpha`, `beta`, `preview`, or `community.N` pre-release, GitHub
Latest does not move, so the existing Published Latest facts stay unchanged.

After a successful Latest-eligible `vX.Y.Z` or `vX.Y.Z-rc.N` release:

```sh
node scripts/sync-published-latest.mjs          # dry-run; exits 3 if a sync is needed
node scripts/sync-published-latest.mjs --write  # explicit mutation after review
node scripts/validate-published-latest.mjs      # re-check the written facts against GitHub
```

The sync is intentionally narrow. It may update only
`communityProduct.githubLatestTag`, `assets` / `publishedAssets`,
`publishedReleaseEvidence`, `schemaVersion`, and `asOf`. It snapshots and
refuses to mutate Candidate core/product/tag, Dual-Badge, plugin evidence, or
real User-Loop evidence. Those states advance only through their own gates.

### Official runtime staging is lock-based

Desktop artifacts embed the **published official** DSH runtime; they do not
vendor or patch official source. The packaging boundary lives under
`apps/desktop/runtime-lock/`: a runtime-only `package.json`, committed npm
`package-lock.json`, and generation provenance.

`stage-official-runtime.mjs` validates that the Desktop pin, runtime manifest,
and lock all name the exact same official `@deepseek-ai/dsh` version. It then
copies the committed manifest + lock into an isolated staging directory and
runs `npm ci --ignore-scripts`. The committed lifecycle policy must exactly
cover every locked package marked `hasInstallScript`; staging explicitly
rebuilds only the reviewed allowlist after verifying the installed version.
The current allowlist is `@deepseek-ai/dsh-subprocess-local`, `koffi`,
`node-pty`, and `protobufjs`. `@google/genai` is the current reviewed
deny entry and is not rebuilt. The existing module-resolution, node-pty
native-binary, classic-node_modules, and runtime-tar size checks then run on
the resulting staged tree.

The runtime lock is verified on Linux (`ubuntu-latest`) by
`runtime-lock-verify`, and its separate npm audit fails at high severity and
above. A pin bump therefore requires a reviewed lock/evidence update plus an
explicit lifecycle-policy review before a release build may use a different
transitive dependency or install-script surface.

Every new Release also carries a machine-readable **official-runtime CycloneDX
SBOM** generated by the Node/npm CLI directly from the committed runtime
`package-lock.json`. It describes the embedded official DSH dependency tree,
not the entire Electron application. The SBOM is treated as a release asset:
it receives its own SHA-256 sidecar and Sigstore keyless bundle, and the
pre-publish verifier rejects a release if the SBOM is missing, malformed, does
not contain the exact official DSH component, or lacks checksum/signature
coverage.

## Artifact naming

```text
dsh-community-x.y.z[-prerelease].AppImage                  Linux AppImage (Complementary Edition primary binary)
dsh-community-x.y.z[-prerelease]-official-runtime.cdx.json embedded official DSH CycloneDX SBOM
```

Historical `v0.1.1-rc.2` also included legacy `DSH Community Setup *.exe` and
`dsh-community-*.dmg` installers before those targets were retired to upstream.
Every published artifact ships a `<file>.sha256` sidecar.

## Artifact signing (keyless)

`[REAL since v0.1.1-rc.2]` — first signed release shipped on that tag: the `sign`
job ran on real GitHub OIDC and every published asset carries a bundle, and
`artifact-smoke` verified all of them in strict mode
([run 32579569995](https://github.com/kamanager2012/dsh-community/actions/runs/32579569995)).

**What gets signed.** Every release asset — the AppImage (plus historical Win/macOS installers on `v0.1.1-rc.2`), the CycloneDX SBOM, and every `<file>.sha256` sidecar — gets one cosign **bundle**:
`<file>.sigstore.json`, containing the detached signature, the Fulcio certificate,
and the Rekor transparency-log proof in a single file. The workflows pin cosign
**v2.6.1**: newer v3.x releases no longer ship the detached `.sig` assets that
`cosign-installer`'s self-verification downloads (observed as a curl 22 / 404 on
the first tagged run), and v2.6.1 produces the identical bundle via `--bundle`.
The `release` workflow refuses to publish an asset without its bundle. Before the sole `contents: write` publish job calls `gh release create`, it re-validates the complete downloaded release set: every primary binary must have a correctly named SHA256 sidecar whose digest is recomputed from the downloaded bytes, every binary and sidecar must have exactly one non-empty Sigstore bundle, orphan sidecars/bundles are rejected, and `cosign verify-blob` must validate every asset against the **exact current tag** workflow identity. `artifact-smoke` then resolves one release tag once and independently re-verifies that same tag after publication. Only the explicit pre-signing historical tags may skip the signature gate; an unknown/new unsigned tag fails.

**Who signs.** The `sign` job runs keylessly: GitHub issues a short-lived OIDC token
(`id-token: write`), Fulcio issues an ephemeral certificate bound to the workflow
identity, and the signature is logged in Rekor. No long-lived private key exists.
The certificate identity looks like:

```text
https://github.com/kamanager2012/dsh-community/.github/workflows/release.yml@refs/tags/v<version>
```

**Verify a download yourself** (requires [cosign](https://docs.sigstore.dev) ≥ v2.4;
our CI verifies with v2.6.1):

```sh
TAG=v0.2.2-rc.3   # example; use the exact tag and filename from current-release.json
BASE=https://github.com/kamanager2012/dsh-community/releases/download/$TAG

curl -fLO "$BASE/dsh-community-0.2.2-rc.3.AppImage" \
     -O "$BASE/dsh-community-0.2.2-rc.3.AppImage.sigstore.json"

cosign verify-blob \
  --bundle dsh-community-0.2.2-rc.3.AppImage.sigstore.json \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity \
    "https://github.com/kamanager2012/dsh-community/.github/workflows/release.yml@refs/tags/$TAG" \
  dsh-community-0.2.2-rc.3.AppImage
```

A passing check means: signed by this repo's `release.yml` on the **exact release tag being checked**, cert chain rooted at Sigstore's Fulcio CA, logged in Rekor, and the blob bytes match the signature. `artifact-smoke` reuses one resolved tag across signature, Linux AppImage, and Linux terminal checks; it does not re-read Latest mid-run. It does not mean the binary is malware-free.

**OS-level signing: absent.** Windows Authenticode and macOS codesign /
notarization are out of scope and not configured (`CSC_IDENTITY_AUTO_DISCOVERY=false`
in the build jobs). Expect SmartScreen and Gatekeeper warnings on first run; verify
via the sha256 sidecar and the cosign bundle above instead of OS trust prompts.

## Manual checks after a release

```sh
curl -sL https://api.github.com/repos/kamanager2012/dsh-community/releases/latest | head
```

All "download Community" links in every repo point at:

```text
https://github.com/kamanager2012/dsh-community/releases/latest
```

## Distribution Reality Gate

Published Latest is pinned in [`current-release.json`](current-release.json) (Complementary Edition tags publish Linux AppImage + official-runtime CycloneDX SBOM + `.sha256` / `.sigstore.json` only; historical `v0.1.1-rc.2` predated Windows/macOS retirement). Later `main` commits may contain code or verification fixes that are not in the published download.
Validate exact Release downloads separately from source or CI:

| Endpoint | Exact artifact / path | Required flow |
|---|---|---|
| WSL/Linux Terminal | `dsh-community` / `pnpm tui` | clean WSL/Linux → key → new/resume → plugin → restart |
| Linux AppImage | `dsh-community-*.AppImage` | clean Linux desktop → extract/launch → key → new/resume → plugin → restart |
| Android Remote Client | APK (`apps/android`) | `[UNVERIFIED]`; not a Latest download until Remote Acceptance passes |
| Windows / macOS Desktop (historical `v0.1.1-rc.2` only) | `DSH Community Setup 0.1.1-rc.2.exe`, `dsh-community-0.1.1-rc.2.dmg` | Retired in future releases; superseded upstream by official `deepseek-harness` |

The gate must also cover uninstall/reinstall, upgrade, missing key, bad network, and
broken or interrupted Runtime extraction. Record Official Web / Official Win & macOS Desktop ↔ WSL/Linux TUI ↔
Linux AppImage Session sharing and the exact asset filename plus SHA256.
`artifact-smoke` is only a partial install / first-ready / missing-key check; it is not
a full user loop. The manual, billable exact-release WSL/Linux new/resume gate is
[`user-loop-evidence`](user-loop-evidence.md); it never runs on a schedule, push, or PR. Earlier smokes (`v0.1.2`, `v0.1.1-rc.1`)
([32470195309](https://github.com/kamanager2012/dsh-community/actions/runs/32470195309),
[32578918509](https://github.com/kamanager2012/dsh-community/actions/runs/32578918509))
do not constitute the full user loop for `v0.1.1-rc.2`. Re-run `artifact-smoke` against the new tag; until
that run is green, this gate stays `[UNVERIFIED]` for the current Latest. A green
unit test or a main-source smoke is not that evidence.

## Rules

- Never publish workspace packages to npm.
- Do not attach the 600MB `linux-unpacked` tree; attach the AppImage / installers.
- A failed platform job does not block the others; fix it in a follow-up patch release.
- Never move or retag a published `vX.Y.Z`. If the bits are wrong, cut `vX.Y.Z+1`. The publish job refuses to overwrite an existing GitHub Release.
