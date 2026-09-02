# Security Policy

## Scope

`dsh-community` is a distribution shell around the official, published
`@deepseek-ai/dsh` runtime: a TUI launcher, an Electron Desktop shell, a
release/signing pipeline, and a thin marketplace UI over
[`packages/marketplace/catalog.json`](packages/marketplace/catalog.json). Official Source Ownership is 0 (see [ARCHITECTURE.md](ARCHITECTURE.md)):
this repo does not vendor or reimplement the agent runtime, tool execution, or
session storage.

In scope for a security report:

- The Desktop shell's IPC surface (`apps/desktop/src/preload.ts`,
  `ipcMain.handle` in `apps/desktop/src/main.ts`), permission handling, or
  navigation/window-open policy behaving differently from what this document
  describes below.
- The embedded official `dsh web` view (`WebContentsView` in
  `apps/desktop/src/window.ts`) gaining a preload script, Node access, or any
  path to the `dshCommunity` IPC bridge — by design it has none.
- The TUI adapter (`apps/tui`, `packages/tui-adapter`) or Desktop shell
  executing anything other than the official `dsh` CLI, or implementing an
  agent loop, tool execution, or a second session store (see "Success
  criteria" in [ARCHITECTURE.md](ARCHITECTURE.md)).
- A published release asset whose cosign bundle (`<file>.sigstore.json`) does
  not verify against this repo's `release.yml` workflow identity, or whose
  `.sha256` sidecar does not match the asset (see "Release integrity" below).
- The marketplace catalog fetch/cache path (`apps/desktop/src/marketplace.ts`)
  installing, updating, or removing a plugin the user did not request, or
  doing so through anything other than the official `dsh plugin add/remove`.
- Any dependency pinned in this repository's own `pnpm-lock.yaml` with a
  known moderate-or-higher severity advisory.

Out of scope (report upstream instead):

- The official DeepSeek Harness runtime (`@deepseek-ai/dsh`) itself — its
  agent loop, tool execution, model access, prompt handling, or `~/.dsh`
  session format. Report to
  [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
- Third-party community plugins listed in
  [`packages/marketplace/catalog.json`](packages/marketplace/catalog.json)
  or installed from the marketplace page — report to that plugin's
  own repository. The catalog `security` metadata (added 2026-08-28)
  records a disclosure and an install/compose check; it is not an
  independent security audit of the plugin's runtime behavior.
- Windows SmartScreen or macOS Gatekeeper warnings on installers — this is a
  disclosed, known gap (no OS-level code signing), not a vulnerability; see
  "Release integrity".
- Issues already superseded by the archived
  [`dsh-community-edition`](https://github.com/kamanager2012/dsh-community-edition).

## Desktop security model

- **Electron hardening.** Both the community chrome `BrowserWindow` and the
  embedded official `WebContentsView` are created with `contextIsolation:
  true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`
  (`apps/desktop/src/window.ts`). Neither renderer runs with Node access.
- **No bridge into the official view.** The embedded official `dsh web`
  content loads with no preload script and no IPC bridge at all — only the
  community chrome window's `preload.ts` exposes the `dshCommunity` object,
  and only a fixed, narrow set of methods (restart host, read snapshot/logs,
  copy text, apply a typed settings patch, run a plugin action by
  `{name, action}` against the catalog, open built-in pages). There is no
  generic `exec`, `eval`, or filesystem-read bridge.
- **Permissions denied by default.** `session.defaultSession` rejects every
  permission check and request (`hardenSession()` in `main.ts`) — camera,
  microphone, geolocation, notifications, etc. are refused for both views.
- **Navigation is allow-listed.** `will-navigate` and
  `setWindowOpenHandler` (`apps/desktop/src/navigation.ts`,
  `apps/desktop/src/window.ts`) send anything outside the official origin to
  the system's default browser via `shell.openExternal`, or deny it. The app
  never opens a second Electron window.
- **Loopback-only host.** The official `dsh web` process the Desktop shell
  spawns binds to `127.0.0.1` with an OS-assigned port
  (`bind: { host: '127.0.0.1', port: 0 }`); this shell never exposes it on a
  non-loopback interface.
- **Single instance.** `app.requestSingleInstanceLock()` stops two Desktop
  processes from racing the same official session store.

## Terminal prompt transport

- Community task text is not forwarded as a child-process positional argument.
  `dsh-community new <task>`, the shorthand `dsh-community <task>`, and an
  optional prompt after `resume <id>` are converted into
  `DSH_TUI_FIRST_PROMPT`; the child argv contains only launcher/profile
  control data. The TUI captures and deletes that environment value before it
  creates or resumes the official Agent, then submits the turn through the
  official `agent.followup` seam.
- This removes ordinary process-list / argv disclosure. It does **not** claim
  environment variables are a cryptographic secret store: code running under
  the same OS security principal may still inspect process state. Do not put
  long-lived credentials in prompts; provider credentials remain in the
  official credential/config path.

## Android security boundary

- Android source is active but remains `[UNVERIFIED]`; its machine-readable
  runtime substrate is currently `BLOCKED`. Official DSH alpha.4 needs Node
  22.19+, while the latest stock nodejs-mobile Android release observed for this
  gate is Node 18.20.4. The historical unverified Gradle plugin declaration is
  therefore not treated as a runtime integration.
- The target embedded Web bootstrap is explicitly loopback-only
  (`127.0.0.1`, `--no-open`), but it is not claimed as wired into a runnable
  APK yet. The current carrier candidate is a self-validated cross-build of
  official Node `v22.19.0`; Node upstream itself classifies Android as an
  unsupported platform with no CI coverage, so this candidate cannot advance
  without our real-device gate.
- The Node 22.19.0 carrier candidate is pinned to the GitHub-verified annotated
  tag object `a9d4750074c7b5439c61daa28ea9afb5dc28e43e`, which peels to
  commit `f8fe6858549f75a4b4e9633abf39dd2038dbf496`. The manual probe rejects a
  different tag object, commit, HEAD, or tracked source modifications before
  cross-building.
- A successful Node carrier is not sufficient for DSH: the current native
  closure still includes `node-pty`/`koffi`, `sharp`, platform sandbox
  binaries, and packaged ripgrep. Their machine-readable status lives in
  `apps/android/native-blockers.json`.
- The committed alpha.4 runtime lock proves this is an **installation-closure**
  problem, not only a runtime-row problem: published `@deepseek-ai/dsh`
  eagerly depends on `dsh-base` / `sdk-minimal` / `tool-fs-search`, and
  `dsh-base` pulls the blocker packages before profile selection. The
  network-free audit is `scripts/audit-android-official-cli-closure.mjs`;
  profile-only disabling is explicitly classified as ineffective.
- Native addon compatibility and Android runtime semantics are tracked separately
  in `apps/android/native-compatibility.json`. A node-pty/Koffi build or load
  success cannot waive the independent terminal, sandbox, app-private hard-link,
  sharp, or ripgrep gates. Android now provides terminal support through a
  first-party `AndroidSubprocessRuntime` that subclasses the official
  `LocalSubprocessRuntime` and replaces only `spawnTerminal()`; ordinary
  subprocess execution remains official code. The provider never uses the
  official local `terminalInspector` test hook. Its Android `/proc` inspector
  fences every process identity with starttime before signalling, tracks POSIX
  session members for teardown, and treats stdin-wait as unproven/false when the
  app sandbox does not expose enough kernel state. This conservative fallback
  cannot promote PTY evidence; exact-carrier node-pty and real-device minimal
  preset behavior remain release-blocking. The manual native device gate now
  chains a provider-level adb-shell smoke that uses the actual Android inspector
  and terminal handle to test write, foreground SIGINT, post-signal recovery,
  and POSIX-session cleanup. Its success marker explicitly states
  `NOT_APP_UID_ACCEPTANCE`; adb-shell success never substitutes for the APK
  app-UID official Web/minimal Reality Gate.
- `scripts/audit-android-portable-deps.mjs` is a network-free provenance check over
  the committed runtime lock. It distinguishes sharp's exact locked WASM fallback
  from actual optional-byte materialization, records that the frozen
  `@vscode/ripgrep@1.18.0` wrapper has no Android platform package, and pins
  `@deepseek-ai/node-addon-landlock-run@0.1.1` plus its npm integrity as the
  Android sandbox launcher's source package.
- Android sandboxing uses the official `ctx.sandbox` provider seam, not an
  internal hook. The invocation overlay disables only the official
  `dsh-sandbox-local` row and inserts the first-party Android provider. That
  provider uses official `writableRoots(policy)`, preserves the launcher's
  exit-125/signature failure rule, and reports full enforcement only after the
  launcher returns the exact `landlock: fully enforced` functional probe.
  Partial Landlock enforcement is refused. The NDK probe compiles the unmodified
  `src/main.c` shipped in the frozen npm package; adb-shell execution is never
  accepted as a substitute for APK app-UID confinement evidence.
- The embedded Android Node bootstrap has a second, app-UID-only fail-closed gate
  before official DSH spawn. Android Context supplies the canonical app data and
  cache paths; `android-app-uid-preflight.cjs` then executes Node `fs.linkSync()`
  in app-private storage and repeats the frozen Landlock full probe plus one
  allowed and one denied write. The denied target is a sibling directory that
  the same APK UID could otherwise write, so success demonstrates Landlock
  confinement rather than ordinary Android DAC. The preflight emits no PASS into
  repository evidence; only captured real-device evidence may promote the gate.
- `scripts/android-native-addon-probe.sh` is a manual no-download/no-source-patch
  gate over the frozen alpha.4 runtime. It requires the exact G1 Node carrier
  build and uses adb only for explicit device smoke; it does not convert public
  Termux results into APK evidence. Its sharp smoke pushes only the frozen sharp
  WASM closure and requires a valid PNG result; a missing optional WASM package
  is reported as a staging/materialization gap, not compatibility success.
- The Android ripgrep boundary is source-audited rather than inferred from
  package names alone. Alpha.4 `tool-fs-search/src/search-core.ts` is pinned at
  Git blob `60ea042d4f31f0e9c856536b8b34e2687482eec7`: `resolveRgPath()`
  accepts no input, exposes no explicit `rgPath/ripgrepPath` config or
  environment seam, imports `@vscode/ripgrep` in Node mode, and only uses an
  executable sidecar when `'pkg' in process`. The frozen runtime lock contains
  no Android `@vscode/ripgrep-*` package.
- `scripts/audit-android-ripgrep-seam.mjs` is the re-adjudication gate for each
  official DSH upgrade. It verifies the supplied official source blob identity
  when requested, detects an explicit future path seam conservatively, and
  never converts seam presence into compatibility PASS without review.
  Publishing a fake `@vscode` package, spoofing `process.pkg`, relying on a
  Termux/system `rg`, silently substituting a newer ripgrep, or forking the
  official glob/grep implementation solely to replace binary resolution are
  all forbidden.
- Android publication is fail-closed through
  `scripts/verify-android-release-ready.mjs` (`node scripts/verify-android-release-ready.mjs`).
  It requires coherent PASS evidence for carrier identity, native closure,
  real-device DSH boot, APK smokes, carrier/APK SHA-256, and the in-app runtime
  gate. The committed `apps/android/evidence/reality-gate.json` is currently
  `NOT_RUN`, so Android cannot be promoted or released from current evidence.

## Session and credential data

- By default, Desktop and TUI read and write the same official `~/.dsh`
  store (sessions, credentials, profiles, plugins) as any other official DSH
  client on the machine; neither copies or forks that data.
- Opt-in isolated mode (`DSH_COMMUNITY_ISOLATED=1`, or Desktop Settings)
  points the Desktop-spawned host at `userData/isolated-dsh` instead. This is
  for isolating one Desktop install's session state from the rest of the
  machine, not encryption — files on disk are not additionally encrypted by
  this repository in either mode.
- Desktop-owned state under `app userData` (`runtime-versions`,
  `window-state`, logs, crash reports) is separate from `~/.dsh` and holds
  diagnostics, not credentials.

## Release integrity

- Every release asset published since `v0.1.1-rc.2` (each installer plus its
  `.sha256` sidecar) ships a cosign **keyless** signature bundle
  (`<file>.sigstore.json`): GitHub OIDC → ephemeral Fulcio certificate → Rekor
  transparency log, no long-lived private key. Before the sole `contents: write`
  publish job calls `gh release create`, it re-computes SHA256 mappings,
  rejects missing/orphan sidecars and bundles, and runs `cosign verify-blob`
  on every downloaded asset against the **exact current tag** release-workflow
  identity. `artifact-smoke` then independently re-verifies the same single
  resolved release tag and the same exact signer identity. Unsigned bypass is
  limited to the explicit pre-signing historical tags; an unknown/new unsigned
  tag fails the smoke. Verification steps and the exact `cosign verify-blob` command are in
  [docs/release.md#artifact-signing-keyless](docs/release.md#artifact-signing-keyless).
  A passing verification means the asset was built by this repo's
  `release.yml` on a tag ref — it does not mean the binary is malware-free.
- **Disclosed gap:** OS-level signing is absent — no Windows Authenticode, no
  macOS notarization (`CSC_IDENTITY_AUTO_DISCOVERY=false`). Expect SmartScreen
  and Gatekeeper warnings on first run; verify via the sha256 sidecar and the
  cosign bundle instead of OS trust prompts.
- Windows packaging keeps hosted-runner antimalware protection enabled. The
  packager confines electron-builder to a staging workspace to keep scanning
  bounded, and a path-scoped Windows PR smoke proves NSIS packaging without
  disabling Defender.
- All three Desktop release targets now have pre-tag PR package smokes using
  the same packaging commands as `release.yml`: Windows NSIS, Linux AppImage,
  and macOS DMG. Linux additionally extracts the AppImage and requires
  `resources/app.asar`; macOS mounts the DMG read-only and requires a valid
  `.app/Contents/MacOS` executable. Every smoke runs the asar vendor=0 guard
  and independently recomputes the published SHA-256 sidecar.
- Workspace packages (`@dsh-community/*`) are never published to npm.

## Dependency security

- Dependabot monitors both npm dependencies and GitHub Actions weekly for routine minor/patch updates. Semver-major upgrades are intentionally excluded from bot PRs and require an explicit compatibility review. Pre-1.0 dependencies with known breaking-minor semantics can be held to patch-only automation; `esbuild` is currently treated that way.
- The existing frozen-lockfile install and repository supply-chain policy
  checks remain part of normal CI. Release assets are separately covered by
  the keyless signing and artifact verification controls above.
- Every external GitHub Action used by CI/release workflows is pinned to an
  immutable full commit SHA. Checkout steps set `persist-credentials: false`
  so the repository token is not left in git configuration for subsequent
  build/install steps. Dependabot still monitors GitHub Actions so pin updates
  arrive as explicit reviewable diffs.
- Release artifact upload/download Actions run on Node 24 majors and are bound
  to a PR round-trip smoke that uploads deterministic bytes, downloads the same
  artifact, and verifies SHA-256. The smoke must use the exact same immutable
  action commits as the release and user-loop workflows.
- New releases include an **official-runtime CycloneDX SBOM** generated with
  the Node/npm CLI from the committed runtime lock. It is explicitly scoped to
  the embedded official DSH dependency tree, not claimed as a whole-product
  Electron SBOM. The SBOM is checksumed and keyless-signed like executable
  assets; pre-publish verification requires exactly one valid SBOM containing
  the official DSH component before the release writer can start.
- Desktop release staging has a separate runtime-only npm lock under
  `apps/desktop/runtime-lock/`. It contains exactly the pinned official
  `@deepseek-ai/dsh` root dependency; every committed non-root package entry
  is bound to `https://registry.npmjs.org/` plus sha512 `integrity`. The
  stage script copies that manifest + lock into an isolated directory and runs
  `npm ci --ignore-scripts`, so Linux/Windows/macOS builds neither re-resolve
  the 500+ package tree nor execute arbitrary transitive install hooks.
  `lifecycle-scripts.json` must exactly cover every locked `hasInstallScript`
  package. The current reviewed set contains five packages: four explicitly
  rebuilt (`@deepseek-ai/dsh-subprocess-local`, `koffi`, `node-pty`,
  `protobufjs`) and `@google/genai`, which remains installed with its
  consumer lifecycle script suppressed. `evidence.json` separately binds the
  committed lock bytes to the generation run and SHA-256.
- `runtime-lock-verify` is read-only: it audits the independent npm lock and
  installs it on Ubuntu, Windows, and macOS. The acceptance run for the current
  lock passed all three installs and reported `found 0 vulnerabilities` from
  npm audit. The full Windows protected-package smoke also passed the
  lifecycle-script staging → NSIS → checksum path from the same committed lock.
- Dependency updates are reviewed as normal pull requests; advisory severity,
  runtime exposure, and transitive impact are part of maintainer triage.
- Dependency-changing pull requests run `pnpm audit --audit-level high`, and the
  same audit runs weekly plus on explicit manual dispatch. High/critical npm
  advisories therefore fail that focused gate without making unrelated PRs
  depend on the registry audit endpoint.

## Known gaps

- A dependency-graph-backed PR blocking gate is not enabled today. The
  repository's GitHub Dependency Graph is not currently available to the
  dependency-review action, so that action is intentionally not wired as a
  permanent red check.
- Moderate npm advisories are in scope and should be triaged, but the automated
  root `pnpm audit` and independent runtime-lock `npm audit` gates currently
  block at **high** severity and above. Raising the threshold to moderate is an
  explicit policy decision, not implied by the existence of either audit workflow.
- `artifact-smoke` (see [docs/release.md](docs/release.md)) is a partial
  install / first-ready / missing-key check, not a full
  new-session/resume/plugin/restart loop. Do not read a green run as a
  complete security regression test of a release.

## Supported Versions

| Version | Supported |
| --- | --- |
| Current [`releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest) tag | Yes |
| Older tags, including historical `v0.1.2`–`v0.1.6` | No — never the current download; see [docs/release.md](docs/release.md) |
| [`dsh-community-edition`](https://github.com/kamanager2012/dsh-community-edition) | No — archived, migrated into this repository |

## Reporting a Vulnerability

Please **do not** open a public issue for a suspected security problem.

1. Preferred: open a [GitHub Security Advisory](https://github.com/kamanager2012/dsh-community/security/advisories/new) (private to maintainers until resolved).
2. If that is not available to you, contact the maintainer through the email
   on the commit history of this repository, and include:
   - the affected surface (Desktop IPC, navigation policy, release signing,
     marketplace install path, or a specific dependency);
   - exact OS/platform, app version (`dsh-community version` or the Release
     tag), and whether the official `@deepseek-ai/dsh` version is pinned or
     drifted;
   - reproduction steps, and whether it reproduces with `pnpm test` /
     `pnpm typecheck` or only in a packaged build.

We aim to acknowledge reports within 5 business days and to share a
remediation plan or explanation within 14 days. Coordinated disclosure is
welcome; please allow a fix to land before public disclosure.

## Our Commitment

- A release asset published without a valid cosign bundle, or a `.sha256`
  mismatch on Latest, is treated as a P0 release-integrity issue.
- The embedded official view gaining a preload script, IPC access, or a
  granted permission it should not have is treated as a P0 issue, with a
  regression test added under `apps/desktop`.
- A plugin action reaching anything other than the official
  `dsh plugin add/remove` on the exact name and action the user chose is
  treated as a P0 issue.
