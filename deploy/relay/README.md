# Self-Hosted Single-Port Blind Gateway (`BlindGatewayServer`)

`deploy/relay/Dockerfile` builds and runs `dsh-community remote gateway` on a single TCP port (`8787`), behind any TLS reverse proxy (Caddy, Nginx, Cloudflare Tunnel):

- `GET /healthz`: JSON health check & blind statistics (zero secrets exposed).
- `WS /relay`: `BlindRelayServer` forwarding opaque E2EE ciphertext frames only.
- `WS /signal`: `SelfHostedSignalingServer` forwarding WebRTC SDP/ICE candidates only.
- `GET /app/` (with `--serve-web`): read-only Remote Web PWA bundle with strict CSP and path containment.

## Example Build & Run

```bash
docker build -f deploy/relay/Dockerfile -t dsh-community-gateway .
docker run --rm -p 8787:8787 \
  -e DSH_REMOTE_GATEWAY_HOST_SECRET="replace-with-strong-secret" \
  dsh-community-gateway
```

> **Fail-Closed Authentication Requirement (F-04):** Binding `BlindRelayServer`,
> `SelfHostedSignalingServer`, or `BlindGatewayServer` to any non-loopback or wildcard address
> (`0.0.0.0`, `::`, LAN IP, or public IP) **fails closed at startup** unless a non-empty
> `hostAuthSecret` (`--host-secret` / `DSH_REMOTE_*_HOST_SECRET`) is configured. Starting the
> Docker container with empty `DSH_REMOTE_GATEWAY_HOST_SECRET` / `DSH_REMOTE_RELAY_HOST_SECRET`
> exits immediately with status `1` unless `DSH_REMOTE_GATEWAY_HOST` is explicitly loopback.

## Behind a TLS Reverse Proxy (Proxy-Aware Per-IP Caps)

By default (`trustedProxies` / `DSH_REMOTE_GATEWAY_TRUSTED_PROXIES` unset), forwarding headers
(`X-Forwarded-For`, `Forwarded`, `X-Real-IP`, `CF-Connecting-IP`) are **ignored** (fail closed)
and connections are bucketed strictly by TCP peer address.

When running behind a reverse proxy (Caddy, Nginx, Cloudflare Tunnel), set `--trusted-proxies`
or `DSH_REMOTE_GATEWAY_TRUSTED_PROXIES` to the explicit proxy IP/CIDR list and configure the
proxy to append/set `X-Forwarded-For` (`caddy reverse_proxy` does this automatically; in Nginx set
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`):

```bash
docker run --rm -p 127.0.0.1:8787:8787 \
  -e DSH_REMOTE_GATEWAY_HOST_SECRET="replace-with-strong-secret" \
  -e DSH_REMOTE_GATEWAY_TRUSTED_PROXIES="127.0.0.1,::1,172.17.0.0/16" \
  dsh-community-gateway
```

Trusted-proxy hops are stripped **right-to-left** so spoofed left-side client headers cannot
bypass `maxConnectionsPerIp`. Wildcard CIDRs (`/0`) and invalid entries fail closed at startup.

Pair your local host with the public TLS URL, passing the same registration secret via `DSH_REMOTE_RELAY_HOST_SECRET` and `DSH_REMOTE_SIGNALING_HOST_SECRET` (note `parseAndScrubRemoteHostEnv` reads and scrubs these secrets before spawning agent child processes):

```bash
DSH_REMOTE_RELAY_HOST_SECRET="replace-with-strong-secret" \
DSH_REMOTE_SIGNALING_HOST_SECRET="replace-with-strong-secret" \
dsh-community remote start \
  --relay-url wss://remote.example.com/relay \
  --signaling-url wss://remote.example.com/signal \
  --web-url https://remote.example.com/app/ \
  --qr
```
