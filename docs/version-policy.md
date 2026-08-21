# Version and identity policy

`dsh-community` uses one public version identity for the whole community
distribution and keeps the official runtime relationship visible.

## Version rules

1. The official core version is the value of `PINNED_DSH_VERSION` in
   `packages/dsh-bridge/src/pin.ts`, together with the matching
   `@deepseek-ai/dsh` dependency pin.
2. Without a community-only fix, the community product version is exactly the
   official core version. For example, official `0.1.1` means community
   `0.1.1`.
3. A community-only fix against the same official core appends the standard
   suffix `-community.N`. For example, the current unreleased line is
   `0.1.0-rc.8-community.1`: its base version is the official `0.1.0-rc.8`,
   and `.1` identifies the first community-only fix in that core line.
4. Every workspace `package.json` uses the same community product version.
   The suffix is part of the product version; it must not be applied to the
   official `@deepseek-ai/dsh` dependency itself.
5. A community suffix is valid only when its base version equals the official
   core version. The upstream contract test enforces this relationship.

Published tags are immutable historical records. Do not rewrite or retag an
older community release merely to bring it under this policy; cut the next
release instead.

## Dual-Badge identity

Desktop and TUI display the same two-part identity:

```text
DeepSeek Harness Community v<community-version> [Official Core: @deepseek-ai/dsh@<official-version>]
```

For the current source line, the exact output is:

```text
DeepSeek Harness Community v0.1.0-rc.8-community.1 [Official Core: @deepseek-ai/dsh@0.1.0-rc.8]
```

The badge is the user-facing source of truth. It must make the community
client version and the corresponding official core version legible together;
do not replace it with two unrelated version labels.

## Release checklist

- Update `PINNED_DSH_VERSION` and every official dependency pin together.
- Set every workspace package version to the exact community product version.
- Use `-community.N` only for community-owned changes on the same official
  core version.
- Update the changelog with both version identities.
- Verify the Desktop and TUI Dual-Badge output.
- Run `pnpm typecheck`, `pnpm test`, and the upstream pin-consistency checks.
