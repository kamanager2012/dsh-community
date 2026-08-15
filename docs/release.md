# Preview release order

Official `@deepseek-ai/dsh` is the **development foundation**. We build TUI and Desktop on the pinned official runtime. A newer official rc is an upgrade of that foundation (pin + contract extract), not a gate that pauses product work.

Publish **only** from this repository:

https://github.com/kamanager2012/dsh-community

Do not fold this tree into another community DSH suite, and do not npm-publish `@dsh-community/*` as a replacement for official or reference packages.

1. **GitHub preview repo** — this repo
2. **Linux AppImage** — [v0.1.1-preview](https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.1-preview)
3. **TUI / Desktop on official dsh** — official `~/.dsh/sessions`, `--list-sessions` / `--resume`
4. **Windows / macOS artifacts** — when we sit on those OSes
5. **Do not npm-publish** workspace packages

```sh
pnpm test
pnpm typecheck
pnpm desktop:package -- --appimage
sha256sum apps/desktop/release/dsh-community-*.AppImage \
  | tee apps/desktop/release/dsh-community-0.1.1.AppImage.sha256

gh release create v0.1.1-preview \
  --repo kamanager2012/dsh-community \
  --title "0.1.1-preview" \
  --prerelease \
  --notes-file CHANGELOG.md \
  apps/desktop/release/dsh-community-0.1.1.AppImage \
  apps/desktop/release/dsh-community-0.1.1.AppImage.sha256
```

Prefer attaching an AppImage or a zip of `linux-unpacked` over committing the unpacked tree.
