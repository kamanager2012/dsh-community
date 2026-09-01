# Version Manager

Desktop-owned distribution feature. Not a second harness.

```
Candidate Source / exact official package pin
       ↓
Contract extraction + validation
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

`latestTested` is overwritten from the contract file on every boot. A user cannot forge it. It means **compatibility-tested recommendation only**: it is neither Candidate Source nor GitHub Published Latest, even when the numbers happen to match.

## What it does not do

- Does not download arbitrary npm latest
- Does not switch official artifacts yet (this workspace still ships one pin)
- Does not parse agent/tool/session state
- Does not move sessions into Desktop AppData

When a Candidate Source pin has passed the required contract extraction/validation, `latest-tested` may move to that exact version. This does not publish a GitHub release or advance Published Latest. Version Manager will then show “offer-tested”. Multi-rc staging is later.
