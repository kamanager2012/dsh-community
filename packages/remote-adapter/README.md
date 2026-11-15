# @dsh-community/remote-adapter

E2EE Multi-Agent Remote Control Plane Host Adapter & Transports for `dsh-community` (issue #67).

This package enforces the Complementary Edition trust and runtime boundary:

- no direct dependency on `@deepseek-ai/*` (attaches to official DSH only through verified Cordis / `OfficialRemoteSeams`, and supervises external `claude`, `codex`, and `opencode` CLIs over stdio with secret scrubbing);
- no second durable Session store (durable DSH session truth stays in `~/.dsh`; external CLIs keep their native stores; only device trust records live in `DSH_REMOTE_CONFIG_DIR`);
- fail-closed Noise IK end-to-end encryption (`noise-handshake@4.2.0` audited exact pin) across LAN WebSocket, WebRTC P2P (`stun:`-only), blind relay (`BlindRelayServer`), self-hosted signaling (`SelfHostedSignalingServer`), and single-port multiplexing gateway (`BlindGatewayServer`);
- no generic remote shell or arbitrary read/write filesystem bridge (only least-privilege session RPCs plus Git-repo-contained, symlink/flag-injection-hardened read-only `workspace.git.status` / `workspace.git.diff` / `workspace.files`).

Physical `arm64-v8a` Android hardware acceptance remains `[UNVERIFIED]` (`DshApp.REAL_DEVICE_ACCEPTANCE_READY = false` in `apps/android`).

See [`docs/remote-host-client.md`](../../docs/remote-host-client.md) and [`deploy/relay/README.md`](../../deploy/relay/README.md).
