# contracts/

Snapshot official DSH. Do not fork official types.

```
contracts/
├── upstream/           frozen extract of the pinned official package
├── compatibility/      matrix, latest-tested, TUI patch-surface KPI
└── tests/              live compare + protocol/data-dir guards
```

`upstream/events.snapshot.json` is a **documented extract** of official architecture at this pin. Do not add Desktop/TUI events to it.

Refresh after a pin bump:

```sh
pnpm contracts:extract
pnpm test
```

Version Manager (Desktop-owned) should read `compatibility/latest-tested.json`, not npm `latest`. Domain tests (`session` / `agent` / `approval` / `plugin`) assert required official rows still exist — they do not define community events.

See [docs/version-manager.md](../docs/version-manager.md).
