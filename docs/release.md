# Preview release order

Official `@deepseek-ai/dsh` is the **development foundation**. We build TUI and Desktop on the pinned official runtime. A newer official rc is an upgrade of that foundation (pin + contract extract), not a gate that pauses product work.

1. **GitHub preview repo** — done: https://github.com/kamanager2012/dsh-community
2. **Linux AppImage** — done: [v0.1.0-preview](https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.0-preview)
3. **Our TUI / Desktop on official dsh** — thin patch, official `~/.dsh/sessions`, `--list-sessions` / `--resume`.
4. **Windows / macOS artifacts** — when we sit on those OSes.
5. **Do not npm-publish** workspace packages.

GitHub Release (when you have an artifact):

```sh
gh release create v0.1.0-preview \
  --title "0.1.0-preview" \
  --notes-file CHANGELOG.md \
  apps/desktop/release/linux-unpacked/dsh-community
```

Prefer attaching an AppImage or a zip of `linux-unpacked` over committing the 600MB tree.
