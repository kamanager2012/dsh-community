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

Pair your local host with the public TLS URL:

```bash
dsh-community remote start \
  --relay-url wss://remote.example.com/relay \
  --signaling-url wss://remote.example.com/signal \
  --web-url https://remote.example.com/app/ \
  --qr
```
