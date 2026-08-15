# 0.1.1-preview

Community distribution preview around official DeepSeek Harness.

**Published only from** https://github.com/kamanager2012/dsh-community

This is not an official DeepSeek client. It does not replace `npx @deepseek-ai/dsh` or the reference `dsh-tui` binary. Workspace packages are **not** npm-published.

Runtime: published `@deepseek-ai/dsh@0.1.0-rc.6`.

## What this preview includes

- Linux AppImage: unsigned thin Electron shell around official `dsh web`
- Default session store: official `~/.dsh` (shared with official Web and our TUI)
- TUI launcher: `dsh-community-tui` → official `dsh --profile dsh-community-tui`
- `--list-sessions` / `--resume <id>` against official `~/.dsh/sessions`
- Desktop **Host → Official sessions** lists that same store

## Linux desktop

1. Download `dsh-community-0.1.1.AppImage`
2. `chmod +x dsh-community-0.1.1.AppImage`
3. `./dsh-community-0.1.1.AppImage`

## From source

```sh
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community
pnpm install
pnpm desktop
pnpm tui
```

Use official `npx @deepseek-ai/dsh web` if you only need the agent.
