# `@dsh-community/dsh-bridge`

The only code in this workspace that is allowed to know how to launch official DSH.

- Pin: `PINNED_DSH_VERSION` → `@deepseek-ai/dsh@0.1.2-alpha.4`
- Resolve: `node_modules/@deepseek-ai/dsh/lib/bin.js` (or `DSH_COMMUNITY_BIN`)
- Spawn: `node <bin> web --host 127.0.0.1 --port 0 --no-open`
- Ready: parse the official `dsh web:` loopback URL. Alpha.4 retains the alpha.3 one-time `?token=` browser bootstrap credential contract.
- Browser auth: the Host keeps that token out of lifecycle snapshots and diagnostics, exposes it through a one-shot in-process bootstrap channel, and Desktop lets the official Web surface exchange it for its signed cookie before settling on the clean root URL.
- Restart: `createOfficialHost` replaces a dead generation; it does not embed Cordis.
- Lifecycle only: pid / clean origin / phase. stdout/stderr are credential-redacted diagnostics, not a business protocol.
- Data dirs: default leave `DSH_HOME` alone (`~/.dsh`).

This package does not implement the agent loop.
