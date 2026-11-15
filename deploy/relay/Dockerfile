FROM node:22-bookworm-slim AS builder

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/dsh-bridge/package.json packages/dsh-bridge/
COPY packages/remote-adapter/package.json packages/remote-adapter/
COPY apps/remote-web/package.json apps/remote-web/
COPY apps/tui/package.json apps/tui/

RUN pnpm install --filter @dsh-community/shared-types \
  --filter @dsh-community/dsh-bridge \
  --filter @dsh-community/remote-adapter \
  --filter @dsh-community/remote-web \
  --filter @dsh-community/tui \
  --frozen-lockfile

COPY packages/shared-types packages/shared-types
COPY packages/dsh-bridge packages/dsh-bridge
COPY packages/remote-adapter packages/remote-adapter
COPY apps/remote-web apps/remote-web
COPY apps/tui apps/tui

RUN pnpm --filter @dsh-community/shared-types build \
  && pnpm --filter @dsh-community/dsh-bridge build \
  && pnpm --filter @dsh-community/remote-adapter build \
  && pnpm --filter @dsh-community/remote-web build \
  && pnpm --filter @dsh-community/tui build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
  DSH_REMOTE_GATEWAY_HOST=0.0.0.0 \
  DSH_REMOTE_GATEWAY_PORT=8787 \
  DSH_REMOTE_WEB_DIST_DIR=/app/apps/remote-web/dist

COPY --from=builder /workspace/node_modules ./node_modules
COPY --from=builder /workspace/package.json ./
COPY --from=builder /workspace/pnpm-workspace.yaml ./
COPY --from=builder /workspace/packages/shared-types ./packages/shared-types
COPY --from=builder /workspace/packages/dsh-bridge ./packages/dsh-bridge
COPY --from=builder /workspace/packages/remote-adapter ./packages/remote-adapter
COPY --from=builder /workspace/apps/remote-web/dist ./apps/remote-web/dist
COPY --from=builder /workspace/apps/tui/package.json ./apps/tui/package.json
COPY --from=builder /workspace/apps/tui/dist ./apps/tui/dist
COPY --from=builder /workspace/apps/tui/node_modules ./apps/tui/node_modules

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.DSH_REMOTE_GATEWAY_PORT || '8787') + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

USER node

CMD ["sh", "-c", "SECRET=\"${DSH_REMOTE_GATEWAY_HOST_SECRET:-${DSH_REMOTE_RELAY_HOST_SECRET:-}}\"; TRIMMED=$(printf '%s' \"${SECRET}\" | tr -d '[:space:]'); if [ -z \"${TRIMMED}\" ] && [ \"${DSH_REMOTE_GATEWAY_HOST}\" != \"127.0.0.1\" ] && [ \"${DSH_REMOTE_GATEWAY_HOST}\" != \"::1\" ]; then echo 'ERROR: DSH_REMOTE_GATEWAY_HOST_SECRET (or DSH_REMOTE_RELAY_HOST_SECRET) must be non-empty when binding dsh-community gateway to non-loopback/wildcard address.' >&2; exit 1; fi; exec node /app/apps/tui/dist/bin.js remote gateway --host \"${DSH_REMOTE_GATEWAY_HOST}\" --port \"${DSH_REMOTE_GATEWAY_PORT}\" --allow-wildcard --serve-web"]
