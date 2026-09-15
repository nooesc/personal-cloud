# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS web-build
WORKDIR /app
RUN npm install --global pnpm@10.20.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY apps/web ./apps/web
RUN pnpm --filter @personal-cloud/web build

FROM node:24-bookworm-slim AS web
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=web-build --chown=node:node /app/node_modules ./node_modules
COPY --from=web-build --chown=node:node /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=web-build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --chown=node:node apps/web/package.json apps/web/server.mjs ./apps/web/
USER node
EXPOSE 3000
WORKDIR /app/apps/web
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]

FROM rust:1.94-bookworm AS api-build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY migrations ./migrations
COPY scripts ./scripts
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/app/target cargo build --locked --release -p personal-cloud-api && cp target/release/personal-cloud-api /usr/local/bin/personal-cloud-api

FROM debian:bookworm-slim AS api
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* && useradd --system --uid 10001 --create-home personal-cloud
WORKDIR /app
COPY --from=api-build /usr/local/bin/personal-cloud-api /usr/local/bin/personal-cloud-api
COPY scripts/install.sh /app/scripts/install.sh
USER personal-cloud
ENV PC_BIND=0.0.0.0:4311
EXPOSE 4311
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s CMD curl --fail --silent http://127.0.0.1:4311/api/health >/dev/null || exit 1
CMD ["personal-cloud-api"]
