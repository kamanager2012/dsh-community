# Architecture

Community **distribution + compatibility** around official DeepSeek Harness. Not a second harness.

```
                  DeepSeek Harness
                 OFFICIAL UPSTREAM
                        │
              pinned npm/runtime
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

Isolated Desktop runtime is opt-in (`DSH_COMMUNITY_ISOLATED=1`).

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
