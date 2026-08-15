# Preview release order

Do these in order. Stop when the next item needs another machine or the upstream TUI repo.

1. **GitHub preview repo** — done: https://github.com/kamanager2012/dsh-community (`main` + Actions).
2. **Linux AppImage** — done: [v0.1.0-preview](https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.0-preview). Rebuild: `pnpm desktop:package -- --appimage`.
3. **Windows / macOS artifacts** — `pnpm desktop:package -- --win` or `--mac` on those OSes. No signing in this preview.
4. **Do not npm-publish** workspace packages. They stay `private`.
5. **Do not replace dsh-TUI.** Patch-surface KPI lives here; Ink stays upstream.
6. **First real official rc bump** — pin + `pnpm contracts:extract` + contract CI, then move `latest-tested`.

GitHub Release (when you have an artifact):

```sh
gh release create v0.1.0-preview \
  --title "0.1.0-preview" \
  --notes-file CHANGELOG.md \
  apps/desktop/release/linux-unpacked/dsh-community
```

Prefer attaching an AppImage or a zip of `linux-unpacked` over committing the 600MB tree.
