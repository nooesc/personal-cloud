# Personal Cloud

## Cloudflare hosted edition

A multi-customer deployment is available in `apps/control-cloud` and the existing web app's Cloudflare build. GitHub accounts own separate workspaces, fleet agents connect over HTTPS, and management state runs on Workers, D1, SQLite Durable Objects and R2. Customer machines run application workloads. See [hosted architecture and deployment](docs/cloudflare-hosted.md) and [migration](docs/hosted-migration.md).

`pnpm dev:cloud` starts the hosted local runtime after its D1 migrations and secret setup. `pnpm check:cloud` checks the hosted implementation. The Compose instructions below describe the retained self-hosted edition.


**Your hardware. Your cloud. One place to make things run.**

A self-hosted deployment platform for Linux machines at home and in the cloud. Connect GitHub and Cloudflare, install a machine, and deploy applications through one dashboard.

Personal Cloud combines a Rust control plane, PostgreSQL, a TanStack Start dashboard, Nomad, Docker, WireGuard, Railpack, BuildKit, and Cloudflare R2/Tunnel/DNS. It runs your workloads on machines you own or rent.

## Start the complete application

Prerequisites: Docker Engine/Desktop with Docker Compose, Python 3, and Git. Startup downloads published multiarchitecture API/web images and PostgreSQL. It does not compile Rust or install Node packages on your machine.

```sh
git clone https://github.com/nooesc/personal-cloud.git
cd personal-cloud
bash scripts/start.sh
```

Open **http://127.0.0.1:4310**. Sign in with `PC_ADMIN_TOKEN` from the generated **`.env.production`** file. The default workspace is live and empty; sample data is available only through the explicit **Explore sample workspace** action.

The production stack includes the built web application, API, and a persistent PostgreSQL volume. Only the web listener is published, on loopback by default. API requests, installer downloads, and WebSocket updates pass through the same web origin. PostgreSQL and the API have no published host ports.

`start.sh` creates the owner token, database password, and encryption key once with mode `0600`, then reuses them on every start. **Back up `.env.production` with the database. Losing `PC_SECRET_KEY` makes stored integration credentials, environment values, and database credentials unreadable.** Do not replace it during an upgrade.

### Use a public HTTPS address

Remote machines need a reachable HTTPS control-plane URL. Put an HTTPS reverse proxy in front of the loopback web port; forward normal HTTP requests and WebSocket upgrades. On the first run:

```sh
PC_PUBLIC_URL=https://cloud.example.com bash scripts/start.sh
```

If you already initialized the stack, edit `PC_PUBLIC_URL` in `.env.production`, then run `bash scripts/start.sh` again. Set the exact origin without a path or trailing slash. This origin controls authenticated browser requests, secure cookies, and GitHub webhook registration. Configure the reverse proxy to preserve `Origin` and support WebSockets for `/api/events` and `/api/services/*/events`.

For a proxy on another host or container network, deliberately choose the host bind in `.env.production`; the default `PC_HOST_BIND=127.0.0.1` keeps it local. Avoid publishing the API or database directly.

### First deployment

1. **Settings → GitHub:** register your GitHub App, link your owner identity, and choose repositories on personal or organization accounts. The app requests read-only source access and push events. [GitHub setup and recovery](docs/github-access.md). Existing PAT connections remain available as an advanced option until you link the app.
2. **Settings → Cloudflare:** connect an API token, select the account and active domain zone, and provide an R2 bucket with S3 API credentials. The API validates credentials before saving them encrypted.
3. **Add machine:** choose its location, roles, and tags. The first machine defaults to compute and builder roles. Copy the one-use installer command to a supported Linux host.
4. **Private network:** the first installed machine becomes the fleet server. Give it a public WireGuard endpoint with reachable UDP port 51820 when joining machines across networks. Home nodes connect outbound to that server. A single machine can run without a public endpoint.
5. **Settings → Set up image storage:** provision the R2-backed registry. The first machine registers the cluster connection automatically; manual runtime settings are available under Advanced.
6. **New project:** choose a GitHub repository and production branch. Add a service, set its listening port and health path, then select **Deploy latest**.
7. Follow build and health-check progress in the service details. Add a public hostname through **Domains → Expose service** once the service is healthy.

The installer supports **Ubuntu 22.04/24.04 and Debian 12/13 with systemd**, on amd64 or arm64. It installs Docker, Nomad, and WireGuard, verifies release archive checksums, and runs the agent as a system service. Builder machines also install BuildKit. macOS machines require a Linux VM; see [fleet setup](infra/README.md).

**Published release:** [v0.2.0](https://github.com/nooesc/personal-cloud/releases/tag/v0.2.0) includes agent downloads and public API, web, and builder images. Both `ghcr.io/nooesc/personal-cloud-api` and `ghcr.io/nooesc/personal-cloud-web` support Linux amd64 and arm64. Anonymous image pulls and a fresh default `bash scripts/start.sh` installation were verified: the published images served the dashboard, API, authenticated WebSockets, and persistent encrypted data without registry login or a source-build override. The `latest` API/web tags currently resolve to v0.2.0.

The default image tag is `latest`. Set `PC_VERSION=vX.Y.Z` in `.env.production` to pin both control-plane images to a release. To build an unpublished checkout or verify local changes instead:

```sh
PC_BUILD_FROM_SOURCE=1 bash scripts/start.sh
```

The explicit source-build path downloads Rust/Node build dependencies inside Docker. A failed image pull reports the failure without silently starting a source build.

## Capabilities

- **Fleet:** durable machine identities, CPU/RAM/disk/GPU/network inventory, roles, tags, health, and private network membership.
- **Applications:** GitHub repository selection, production-branch builds, automatic or explicit placement, resource limits, health checks, immutable image deployments, and rollback without rebuilding.
- **Builds:** Railpack detection/build planning, BuildKit builds, OCI image upload, scheduler placement, and ordered build progress with visible failure details.
- **Secrets:** encrypted project variables with explicit reveal; changes take effect on the next deployment.
- **PostgreSQL:** provision a persistent database on a healthy database-role machine, attach `DATABASE_URL` to a service, reveal connection credentials explicitly, and monitor health. Database placement stays pinned. Removing a database preserves its volume.
- **Domains:** provision Cloudflare Tunnel/DNS routing for healthy services and remove only the resources owned by Personal Cloud.
- **Observability:** live fleet snapshots, deployment progress, activity, service logs, and allocation metrics. Connection failures remain visible; live failures never switch to sample data.
- **Access:** GitHub owner sign-in, selected personal/organization repository access through GitHub App installations, owner-token recovery, hashed/revocable browser sessions, distinct one-use enrollment tokens and agent credentials, and encrypted provider credentials.

See the [original V1 specification](docs/product/v1-spec.md), [API overview](docs/api.md), and [runtime interfaces](docs/runtime-contract.md).

## Operate and upgrade

```sh
# Pull published images and start; preserves credentials and the database volume.
bash scripts/start.sh

# Status and logs.
docker compose --env-file .env.production -f compose.production.yml ps
docker compose --env-file .env.production -f compose.production.yml logs --tail=100 web api

# Stop without deleting persistent data.
docker compose --env-file .env.production -f compose.production.yml stop

# Control-plane database backup (protect this file as secret data).
mkdir -p work/backups
umask 077
docker compose --env-file .env.production -f compose.production.yml exec -T postgres \
  pg_dump -U personal_cloud -d personal_cloud -Fc > work/backups/control-plane.dump
```

Back up application PostgreSQL volumes separately. A control-plane backup contains configuration and encrypted credentials, not application database contents. Do not run `down --volumes` unless intentionally destroying the control database. Database machines are never automatically relocated; plan explicit offline backup/restore for a move.

`PC_ENV_FILE`, `PC_COMPOSE_PROJECT`, and `PC_PORT` can isolate an additional stack. `PC_VERSION` selects the published API/web image tag; `PC_BUILD_FROM_SOURCE=1` explicitly builds this checkout. Use a different Compose project to keep its volume separate. Existing credentials are never regenerated automatically.

## Current limits and validation boundary

The self-hosted Compose edition is a single-owner, single-control-plane implementation. It does not include billing, teams/SSO, automatic scaling, database HA, automatic database migration, automated backups, or a credential-rotation UI. Service metrics expose the runtime's reported allocation data; the dashboard is not a monitoring warehouse.

The production package has been checked in an isolated Compose stack: built SSR and static assets, same-origin HTTP and WebSocket routing, owner sessions, origin rejection, persisted service settings, encrypted secrets, and restart recovery all passed. The local checks and disposable Linux harness also exercise API persistence, builds, scheduling, and failure handling. Live scoped Cloudflare/R2 credentials, an R2-backed image build/deployment, and public Tunnel/DNS/TLS routing have also been verified against a real account. These checks also do not prove a user's GitHub permissions, firewall, or multi-machine connectivity. A production deployment is ready only after its own provider connections, machine enrollment, immutable deployment, public route, and application database are observed working. The ten-minute clean-machine onboarding target is a release acceptance criterion, not an asserted timing guarantee.

See [V1 verification](docs/verification-v1.md) for the executed acceptance checks and the connector acknowledgement fix. See [GitHub access](docs/github-access.md) for the v0.2.0 sign-in and installation flow.

## Development

Prerequisites: Rust 1.94+, Node 22.12+, pnpm 10, Python 3, and Docker with Compose.

```sh
pnpm install
pnpm dev                    # isolated development Postgres, API, web
pnpm check                  # Rust formatting/tests, web build/typecheck
cargo clippy --workspace -- -D warnings
pnpm smoke                  # API + Postgres checks; dev stack must be running
```

The development stack uses `.env`, API port 4311, web port 4310, and PostgreSQL port 55438, all on loopback. Production uses its separate `.env.production` and private Compose network. Stop one web stack or choose another `PC_PORT` before starting both.

```text
apps/web/              Dashboard and production web server
crates/control-plane/  API, integration/runtime controllers, encrypted persistence
crates/agent/          Machine identity, installation, inventory, private network
crates/core/           Shared models and placement contracts
migrations/           Versioned PostgreSQL schema
build/                Application builder image and build scripts
infra/                Disposable fleet harness and Linux host setup
scripts/              Development, production startup, installation, verification
```

## License

Personal Cloud is licensed under [Apache-2.0](LICENSE). Dependencies retain their licenses. Nomad is distributed separately; this project's license does not relicense Nomad.
