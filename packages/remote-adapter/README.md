# @dsh-community/remote-adapter

Status: **[LABS] / [UNVERIFIED]** — R1 transport-free core for issue #67.

This package is deliberately boring:

- no socket server;
- no WebRTC;
- no Noise implementation;
- no relay;
- no direct dependency on `@deepseek-ai/*`;
- no Agent loop, Session persistence, tool executor, shell, filesystem bridge, or credential export.

It defines the policy/protocol core that a later Host integration can bind to verified official seams. R1 accepts an `OfficialRemoteSeams` facade so tests can prove authorization, idempotency, replay, bounded event resumption, and terminal approval/question behavior without inventing a second DSH runtime.

Transport authentication must supply `AuthenticatedPeer`; the adapter never trusts a caller-supplied device identity as the authentication root.

See `docs/remote-host-client.md`.
