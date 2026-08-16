# Version Manager

Desktop-owned distribution feature. Not a second harness.

```
Official Release
       ↓
Contract CI
       ↓
contracts/compatibility/latest-tested.json
       ↓
Desktop Version Manager
       ↓
recommend latest tested
```

## What it stores

Under Electron `userData`, never under `~/.dsh`:

- `runtime-versions.json` — default pin, per-project pins
- `window-state.json`
- `desktop-settings.json` — hide-to-tray, isolated official home (Desktop-owned)
- `logs/host.log` — official stdout/stderr, diagnostics only

`latestTested` is overwritten from the contract file on every boot. A user cannot forge it.

## What it does not do

- Does not download arbitrary npm latest
- Does not switch official artifacts yet (this workspace still ships one pin)
- Does not parse agent/tool/session state
- Does not move sessions into Desktop AppData

When contract CI promotes rc.N, bump the workspace pin, extract snapshots, then latest-tested moves. Version Manager will then show “offer-tested”. Multi-rc staging is later.
