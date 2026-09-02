# Architecture

Official DeepSeek Harness is the kernel. Community is based on that kernel: one runtime, one `~/.dsh`, and five Community endpoints. Not a second harness. WSL/Linux Terminal, Windows Desktop, macOS Desktop, and Linux AppImage are currently published; Android source is active in `apps/android` but remains `[UNVERIFIED]` and is not a Published Latest artifact. Official Web is the kernel's own UI, not a Community endpoint.

```
                  DeepSeek Harness
              OFFICIAL FOUNDATION
             (our development base)
                        │
              pinned @deepseek-ai/dsh
                        │
               ┌────────┴────────┐
               │                 │
         Contract Layer      Compatibility CI
               │
               └────────┬────────┘
                        │
                    DSH Bridge
                        │
             ┌──────────┴──────────┐
             │                     │
     our TUI (apps/tui)     our Desktop
             │                     │
      Terminal UX             Distribution UX
```

There is no second agent runtime in the middle.

## What official currently signals

Official `apps/` today is `cli` and `web`. Architecture says UI/editor integration should drive `ctx.agents` and render from `session/event`, and that there is no privileged core to patch.

That is a strong **architecture** signal: runtime + composable surfaces, not every UI in core.

It is **not** a product declaration that official will never ship a TUI. If they do, community TUI still attaches through public seams instead of forking core.

## stdout is logs

```
Official DSH
   ├── official HTTP / WS / session/event   ← Desktop/TUI business state
   └── stdout / stderr                      ← crash / diagnostics / log viewer
```

Runtime Manager may own only what the desktop shell must know and official does not expose as a product API:

- PID, start success, port, exit code, crash, health

Do **not** parse “agent is reasoning” from stdout. Do **not** grow a Desktop Runtime Protocol (`agent/running`, `tool/start`, `session/changed`, …).

## Data directories

```
Official DSH          ~/.dsh/          sessions, credentials, profiles, plugins
Desktop-owned         app userData     runtime-versions, window-state, logs, crash-reports
```

Default: do not rewrite `DSH_HOME`. TUI, official Web, and Desktop see the same session log.

Isolated Desktop runtime is opt-in (`DSH_COMMUNITY_ISOLATED=1`, or Desktop Settings). Session list and `dsh web` then use `userData/isolated-dsh`.

## Distribution runtime lock is not a fork

Desktop installers must carry a self-contained copy of the **published official**
runtime so first launch does not depend on a fresh dependency solve. That
distribution concern is isolated under `apps/desktop/runtime-lock/`.

The committed npm lock records registry URLs and integrity digests for the
official runtime's transitive package tree. `stage-official-runtime.mjs` uses
`npm ci --ignore-scripts` to materialize those published packages, then
selectively rebuilds only lifecycle packages listed in the reviewed runtime
policy. A new or version-drifted `hasInstallScript` package is therefore a
review event, not an implicitly executable dependency. The resulting classic
`node_modules` tree is archived for Desktop packaging. Community does not edit
those packages or copy official source into this repository; the lock and
lifecycle policy are distribution metadata, not a second runtime implementation.
The runtime-only `package.json` remains inside the strict composition scan,
while generated/review metadata is verified by dedicated lock contracts.

## contracts/ snapshots official surface

Snapshot official exports, CLI, config rows, and packages. Do not maintain `event-types.ts` as “our DSH types”.

A new official rc: extract → diff snapshots → contract tests → then TUI/Desktop smoke. Compatibility matrix records **latest tested**, not npm latest. Desktop Version Manager reads that file and writes pins only under app userData.

## Success criteria

1. **Official Source Ownership = 0** — no vendored `packages/core`, `apps/web`, …
2. **TUI patch-surface reduction** — official Cordis row overrides go 33 → 15 → 8 → TUI-owned inserts only
3. **TUI/Desktop do not implement** Agent loop, Session persistence, Tool execution
4. **Upstream rc bump** does not require business UI code changes
5. **TUI / Desktop / official Web share the same session source of truth**
6. **Breaks fail in contract CI first**, not on a user’s machine

See [docs/reconstruction.md](docs/reconstruction.md), [docs/upgrade.md](docs/upgrade.md), [contracts/README.md](contracts/README.md).
