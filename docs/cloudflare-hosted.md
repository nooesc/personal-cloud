# Cloudflare hosted Personal Cloud

The hosted edition runs the web application and control plane on Cloudflare. Each customer signs in with GitHub, creates a workspace, installs the existing Rust agent on their machines, and deploys into that workspace. Application containers, builders and persistent databases run on customer machines. The management service does not require a running Mac or PostgreSQL server.

## Components

- `apps/web`: existing TanStack Start application and design, built with Cloudflare's Vite adapter. Its Worker forwards API, WebSocket, installer and OCI registry requests through a service binding.
- `apps/control-cloud`: TypeScript Worker entry, D1 account/session directory, workspace routing and GitHub App integration.
- One SQLite Durable Object per workspace: fleet state, projects, encrypted secrets, networking, command mailbox, durable deployment/database phases, events and live subscriptions. Tenant data is not selected by a browser-supplied workspace header.
- R2: private OCI blobs and manifests under workspace-specific paths. Registry credentials are unique to a workspace; customers never receive the platform's R2 credentials.
- Registry upload Durable Objects: streamed upload offsets, synchronization and cleanup.
- Durable Object alarms: controller reconciliation and retries. No continuously running server process or best-effort background task is required.
- Existing Rust agent and Nomad/Docker runtime: outbound HTTPS enrollment, heartbeat and commands. Machine identities cannot call browser APIs or choose a different tenant.

D1 stores only identity/routing data; high-frequency fleet state stays in the tenant object. Fleet history stores one actual sample per minute for six hours and returns the last hour. Logs and controller state are bounded. `MAX_MACHINES_PER_WORKSPACE` and `MAX_PROJECTS_PER_WORKSPACE` provide configurable quotas; authentication also rate-limits OAuth initiation.

## Operator setup

Use a Workers plan that supports the configured Durable Object and D1/R2 resources. This code does not assert a measured customer-capacity or cost figure.

1. Install dependencies with `pnpm install`.
2. Create the D1 directory and R2 bucket with Wrangler. Put their identifiers in an ignored deployment configuration derived from `apps/control-cloud/wrangler.jsonc`; the checked-in D1 ID is a local-development placeholder.
3. Set `PUBLIC_URL` to the final HTTPS dashboard origin. Keep one canonical origin for cookies, GitHub callbacks, WebSockets and image pulls.
4. Register one platform GitHub App, public for installation on customer personal or organization accounts. Repository permissions: contents read and metadata read; subscribe to push, installation, installation_repositories and github_app_authorization lifecycle events. Enable user access-token expiration. OAuth callback: `${PUBLIC_URL}/api/github/auth/callback`; installation setup URL: `${PUBLIC_URL}/api/github/app/installed`; webhook: `${PUBLIC_URL}/api/github/app/webhook`.
5. Set Worker secrets: `SESSION_SECRET`, `ENCRYPTION_KEY` (independent random values at least 32 characters), `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET`.
6. For managed application domains, set `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `CF_ZONE_NAME`. Scope the token to the intended account's tunnels and zone's DNS. Set `CF_ZONE_NAME` to an application-only suffix such as `apps.example.com` inside the selected zone, separate from the dashboard domain. Customers do not need a Cloudflare account. Customer vanity domains outside this suffix are not currently provisioned.
7. Apply D1 migrations, deploy the control Worker, then deploy the web Worker with its `CONTROL_PLANE` service binding. The web Worker uses `personal-cloud-control` by default. Route the dashboard domain to the web Worker only after account/fleet migration when replacing an existing installation.

Example commands, from the repository root:

```sh
pnpm --filter @personal-cloud/control-cloud exec wrangler d1 create personal-cloud-directory
pnpm --filter @personal-cloud/control-cloud exec wrangler r2 bucket create personal-cloud-artifacts
# Set IDs, account and PUBLIC_URL in your deployment config before deploying.
pnpm --filter @personal-cloud/control-cloud exec wrangler secret bulk /secure/path/secrets.json --config wrangler.production.jsonc
pnpm --filter @personal-cloud/control-cloud exec wrangler d1 migrations apply DIRECTORY --remote --config wrangler.production.jsonc
pnpm --filter @personal-cloud/control-cloud exec wrangler deploy --config wrangler.production.jsonc
pnpm --filter @personal-cloud/web deploy:cloud
```

Keep configuration and credentials backed up separately. Losing the encryption key loses access to encrypted connection credentials. The existing self-hosted Compose path remains available; its PostgreSQL schema and owner token are not used by the hosted edition.

## Customer flow

Sign in with GitHub, choose or create a workspace, attach the App's selected repositories, and enroll a supported Linux machine. Existing GitHub installations appear under Refresh access and can be explicitly attached to a workspace. Grants are checked against the granting user's current repository permissions before issuing short-lived, repository-scoped installation tokens. Revocation removes affected grants and sessions.

The installer currently supports Ubuntu 22.04/24.04 and Debian 12/13 with systemd. macOS needs a Linux VM for workloads. Native inventory agents on other operating systems do not become deployment workers merely by signing in. Multiple machines still need the private WireGuard/Nomad topology described in `infra/README.md`, including a reachable hub endpoint. Moving the dashboard does not remove that runtime networking requirement.

New builds push into the managed HTTPS registry. Immutable rollback uses a recorded image digest. PostgreSQL instances stay pinned to their original machine, Nomad node and volume; node failure never silently recreates a database elsewhere. Removal preserves volumes for explicit recovery.

## Local development

```sh
pnpm --filter @personal-cloud/control-cloud db:local
# Add random SESSION_SECRET/ENCRYPTION_KEY to ignored apps/control-cloud/.dev.vars.
pnpm --filter @personal-cloud/control-cloud dev
pnpm --filter @personal-cloud/web dev:cloud
```

Use `http://localhost:4320`, matching the configured origin. `127.0.0.1` is a different origin. Hosted API is on localhost:4321; service bindings connect both dev servers. For local GitHub sign-in use an appropriately registered development callback and development App credentials.

```sh
pnpm check:cloud
python3 apps/control-cloud/test/hosted-local.py
```

The Python integration check is restricted to localhost and creates explicitly synthetic QA workspaces in the local D1/DO/R2 state. GitHub protocol tests use mocked provider responses, and do not establish a live GitHub approval. The integration check verifies actual local Cloudflare runtime storage, enrollment, credential isolation and OCI uploads. It does not claim 500-customer load testing.

## Registry limits and retention

The managed OCI endpoint supports image manifest/index push and pull, blob uploads, ranged reads and tag listing. Upload requests require Content-Length and are limited to 100 MiB per chunk; larger layers need chunked resumable uploads. Incomplete upload state expires after 24 hours. Image garbage collection and customer backup scheduling are not implemented: configure operational retention before offering unbounded storage. R2 is not an automatic backup of customer database volumes.

## Migration

See `hosted-migration.md`. Migration is explicit, operator-authenticated and into an empty hosted workspace; it preserves machine credential hashes and persistent ownership. Do not run both controllers against the same fleet. Keep the old database/keys and a reversible routing change until the hosted controller, existing agents, applications and domains are observed working.
