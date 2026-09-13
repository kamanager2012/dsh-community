# Marketplace CLI usage

This page documents the discovery and installation layer. It does not replace the
official plugin protocol and does not own Runtime or Session persistence.

Source of truth: [`dsh-community/packages/marketplace`](https://github.com/kamanager2012/dsh-community/tree/main/packages/marketplace). Run `pnpm marketplace -- list` from that repo. The binary name is still `dsh-marketplace`.

```text
dsh-community/packages/marketplace/catalog.json
        ↓ compatibility evidence
dsh-marketplace
        ↓ official install chain
dsh plugin add
```

## Commands

```sh
dsh-marketplace list
dsh-marketplace search <keyword>
dsh-marketplace info <package-name>
dsh-marketplace install <package-name>[@version]
```

- `list` shows registry entries;
- `search` filters by keyword;
- `info` shows package version, compatibility, digest, and provenance `[待复核]`;
- `install` passes the selection to the official `dsh plugin add` chain instead of implementing a second installer.

The registry currently records 9 verified plugins `[待复核]`. Its verification layers
include shape, npm existence/version, `dist.integrity`, provenance, repository
reachability, and the compose workflow's official install plus assertion `[待复核]`.
The registry is evidence, not a security guarantee. An entry without matching evidence
or with unresolved staging must remain `[待复核]` and must not be described as unconditionally available.

See the [Chinese plugin overview](../../content/10-plugins/README.md), the
[ecosystem map](../00-overview/community-ecosystem.md), and the
[current release status](../11-operations/community-release-status.md).
