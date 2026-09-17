# Cloudflare hosted dinghy

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

The managed OCI endpoint supports image manifest/index push and pull, blob uploads, ranged reads and tag listing. Upload requests require Content-Length and are limited to 100 MiB per chunk; larger layers need chunked resumable uploads. Incomplete upload state expires after 24 hours. Image garbage collection is not implemented: configure operational retention before offering unbounded image storage. Customer PostgreSQL backup scheduling is opt-in; see the backup and restore section below. Image storage alone does not protect database volumes.

## Migration

See `hosted-migration.md`. Migration is explicit, operator-authenticated and into an empty hosted workspace; it preserves machine credential hashes and persistent ownership. Do not run both controllers against the same fleet. Keep the old database/keys and a reversible routing change until the hosted controller, existing agents, applications and domains are observed working.

## Deployment readiness and guided setup

The hosted snapshot includes `readiness`, the shared source for workspace prerequisites and machine capabilities. Agent contact is distinct from permission to run workloads. A recent agent heartbeat alone does not make a machine deployment-ready: readiness also requires a recent scheduler observation, an eligible non-draining node, and a healthy Docker driver. New-server role recommendations include Builder whenever no verified builder exists, including when the workspace already contains inventory-only computers.

Scheduler observations refresh in the background when the dashboard requests a snapshot. The snapshot does not block on a fleet request. Observations expire after 30 seconds, coordinator changes invalidate them, and unverified or unavailable capability remains visibly checking/blocked. These are prerequisite observations, not a guarantee that a subsequent build, resource allocation, health check, or public route will succeed.

`GET /api/services/:id/preflight` checks the service's placement/architecture against a compatible compute/build pair, then verifies access to its selected GitHub repository and branch. Interactive source deployments through `POST /api/services/:id/deploy` repeat the check and return `409` (blocked) or `503` (checking), with `{error, readiness}`, without creating a deployment. Actual deployment reconciliation still checks runtime eligibility and source access. Immutable-image and rollback requests retain their separate provenance checks. Webhook deployments retain the existing durable queue and failure history rather than retrying a blocked interactive preflight indefinitely.

Snapshots also include a bounded `enrollments` list containing only ID, expiry, waiting/connected status and the resulting machine ID. Tokens and hashes are omitted. This allows installation progress to follow the correct machine rather than guessing from fleet size. An omitted service port defaults to 3000; it is a configurable default, not repository detection.

These additions are backward-compatible for existing agents and require no storage migration. The retained self-hosted API does not yet publish this readiness contract; clients must show readiness as unavailable instead of deriving an optimistic answer.

Validation: focused tests cover inventory-only machines, stale/mismatched observations, drained and ineligible nodes, lost agent runtime capability, CPU architecture matching, repository prerequisites and coordinator removal races. `apps/control-cloud/test/hosted-local.py` additionally exercises the actual local D1/SQLite Durable Object/R2 APIs, enrollment progress, tenant isolation, blocked deploys with no deployment record, and readiness refresh/drain invalidation using a scheduler-protocol simulator. The simulator is not evidence of a successful real Nomad deployment.

Unused enrollment commands can be revoked with `DELETE /api/enrollment-tokens/:id` before generating a replacement. Revocation is recorded in the workspace before routing cleanup, so an in-flight enrollment cannot consume a revoked command. Already-connected grants are protected; machine retirement remains a separate operation.

The guided installer requests `setup_intent: "runtime"` when creating an enrollment token. Before the agent reports runtime capabilities, that newly enrolled machine is shown as checking for up to 15 minutes, never as ready. An overdue setup becomes actionable; ordinary inventory-only tokens retain monitoring-only behavior. Intent is not evidence that installation succeeded.

### Cloudflare account overview

The hosted Overview optionally lists a workspace's Cloudflare Workers and Pages projects.
This inventory connection is separate from dinghy's managed domain/R2 hosting: global
`CF_API_TOKEN` credentials are never used to reveal the operator account to customers.
An existing encrypted, workspace-imported Cloudflare connection can supply inventory;
otherwise connect an account ID and API token from Overview. Use account-scoped
**Workers Scripts Read**, **Pages Read**, and **Account Analytics Read** permissions.
Tokens are encrypted using the workspace-bound encryption context and never returned.
Disconnecting inventory preserves imported domain credentials and managed hosting.

Workers show uploaded scripts, modification dates, dashboard links, and the last 24 hours
of requests, invocation errors, and subrequests. These are Cloudflare's sampled analytics,
not uptime checks or HTTP error totals. Pages show their production branch and canonical
production deployment status/date; Pages traffic analytics are not included. Provider
failures and missing permissions appear explicitly, with unavailable metrics left null.
Results are cached for 60 seconds per workspace, concurrent reads are deduplicated, and
an account change invalidates both cached and in-flight responses. The inventory is
bounded to 1,000 Workers and 100 Pages projects and reports truncation instead of hiding it.

Provider references: [Workers scripts](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/),
[Pages projects](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/list/),
[Workers analytics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/).

## Organizing existing cloud apps

Hosted projects can contain existing Cloudflare Workers/Pages without a repository or
fleet setup. The optional organization flow discovers inventory, offers editable
name/environment suggestions, and stores accepted associations in the workspace's
`project_resources` collection. It does not adopt the existing deployment pipeline.
Connect a GitHub repository explicitly before adding a machine service.

Resource identity is `(account_id, kind, name)`. Each resource has one project owner or
an ignored marker; shared infrastructure relationships are not part of this first slice.
A workspace revision prevents a stale browser from overwriting another organization
edit. Inventory connection revisions independently reject reconnect/disconnect races.
The batch validates before a single SQLite transaction; provider reads happen first,
never within that transaction. No schema migration or provider writes are required.

Use existing resources first. Paid provisioning and plan changes are not enabled by
organization. The UI must not call an unknown Cloudflare plan free or interpret request
counts as cost/remaining allowance. Free-tier eligibility, quotas, and optional paid
capabilities require provider-specific evidence before a future provisioning flow.

Existing addresses are read from the connected account: Worker custom domains
(Workers Domains API), enabled `workers.dev` routes (the account subdomain plus one
enabled-check per script, capped at 200 scripts with the remainder reported
unchecked; a disabled route is never listed), and Pages custom domains from the
project listing. They are shown under Domains and on project cards for the project
owning that exact resource. These provider-owned addresses are read-only; Dinghy
does not recreate them or change DNS. Account and script identity must match, and
named legacy Worker service environments are not inferred from script names. Each
source that fails is an explicit issue next to whatever the others returned; the
list is null only when no source answered. A row without an address means nothing
was reported, not that none exists.

Project cards join the same overview: each linked row shows its first reported
address, the footer sums 24h sampled requests and invocation errors across
production Workers, and "updated" is the latest deployment, Worker upload or Pages
deployment. Without machine services the card's status comes from these
observations only: a failed Pages production deployment, sampled invocation errors,
observed requests, or no traffic. None of these is a serving check, and the card
shows nothing until Cloudflare has answered.

Each card also carries two sparklines. "req · 24h" is the hourly shape of sampled
requests across production Workers, from a second Workers analytics query grouped
by hour; it is null (a flat grey line and "—") when that query fails or exceeds the
row limit, and the totals beside it come from the separate ungrouped query so they
never depend on it. "deploys · 14d" counts deployments per day: dinghy deployments,
Worker version uploads (one versions request per script) and Pages production
deployments (one request per project). Per-resource checks are capped at 200 per
kind; the remainder is reported as an explicit "not checked" issue.

### PostgreSQL backups and restore copies

Hosted database cards expose **Backups & restore**. Enable daily backups (seven successful copies by default), or run a manual backup. The authenticated policy API accepts retention from 1–30 copies. Scheduling is persisted in the workspace Durable Object; an unavailable database reports a schedule error and retries in an hour. Missed periods coalesce rather than enqueue a backlog.

Each backup is a PostgreSQL 17 custom-format logical dump, executed on the database's pinned Nomad node. A short-lived, operation-scoped transfer credential uploads it into workspace-prefixed private R2 storage. R2 validates SHA-256; an operation succeeds only after both scheduler tasks finish and the stored object is verified. The initial compressed-dump limit is **100 MiB** with a 30-minute operation deadline. Larger databases need a multipart backup implementation before this feature can protect them. This is not continuous WAL archiving, PITR, HA, or a backup of the hosted D1/DO control plane.

**Restore a copy** provisions a fresh database and volume on the explicitly selected machine (the original owner by default), verifies the stored checksum and runs `pg_restore --single-transaction --exit-on-error`. The destination remains unavailable for attachment, connection reveal and backup until restoration succeeds. It never rewrites the source or automatically rebinds applications. A failed copy keeps its own volume for diagnosis; retry by creating another restore copy. Confirm application-specific queries before switching a service to the restored copy.

Retention expires only successful copies beyond the policy count and skips copies used by active restores. Expiration reserves the copy before storage deletion, preventing a new restore from racing it. Removing a database is blocked while it has retained backups; explicitly delete backup copies first. Disabling a schedule preserves copies; retention still applies to the configured count. Backup metadata and failures remain visible.

Validation: `PC_BACKUP_POSTGRES=1 pnpm --filter @personal-cloud/control-cloud exec tsx --test test/backups-workerd.test.mjs` runs real PostgreSQL 17 dump/restore with an asserted persisted marker through local workerd R2/SQLite. The normal suite checks tenant isolation, credentials, SHA-256 rejection, separate restore ownership and the outer Worker's binary upload path. Local tests are not evidence of a live fleet backup.
