# `@dsh-community/dsh-bridge`

The only code in this workspace that is allowed to know how to launch official DSH.

- Pin: `PINNED_DSH_VERSION` → `@deepseek-ai/dsh@0.1.0-rc.6`
- Resolve: `node_modules/@deepseek-ai/dsh/lib/bin.js` (or `DSH_COMMUNITY_BIN`)
- Spawn: `node <bin> web --host 127.0.0.1 --port 0`
- Ready: parse `dsh web: http://127.0.0.1:<port>`
- Restart: `createOfficialHost` replaces a dead generation; it does not embed Cordis
- Lifecycle only: pid / origin / phase. stdout is diagnostics, not a business protocol
- Data dirs: default leave `DSH_HOME` alone (`~/.dsh`)

This package does not implement the agent loop.
