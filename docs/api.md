# API

The Rust API defaults to `127.0.0.1:4311`. Development and production web servers proxy same-origin `/api`, WebSockets, and `/install.sh`. JSON bodies are limited to 2 MiB; individual fields have smaller validation limits.

Owner requests accept `Authorization: Bearer <PC_ADMIN_TOKEN>` or the HttpOnly `pc_session` cookie. Browser requests require the configured origin. Enrollment tokens and machine credentials cannot access owner endpoints. Secret values are omitted from snapshots and require explicit reveal endpoints.

## Owner endpoints

| Area | Endpoints | Behavior |
|---|---|---|
| Session | `POST /api/session`, `DELETE /api/session` | Create a hashed, revocable 12-hour session or sign out |
| Overview | `GET /api/snapshot`, `WS /api/events` | Six core objects, integration status, durable activity; snapshots on change and every ten seconds |
| Fleet history | `GET /api/fleet/history` | Last hour of per-machine CPU, memory and disk samples recorded from heartbeats (`{since, step_seconds, machines: {id: [{at, cpu, mem, disk}]}}`); samples are retained for 24 hours and removed with the machine |
| Projects | `POST /api/projects`, `DELETE /api/projects/:id` | GitHub repository, production branch, owned resources |
| Services | `POST /api/projects/:id/services`, `PUT/DELETE /api/services/:id` | Port, health path, repository directory, architecture, resource limits, placement, automatic deploy |
| Deployments | `POST /api/services/:id/deploy`, `GET /api/deployments/:id` | Durable source-build or immutable-image job; ordered steps and explicit errors |
| Rollback | `POST /api/services/:id/rollback` | `{deployment_id}` selects a previously healthy image without rebuilding |
| Diagnostics | `GET /api/services/:id/logs`, `GET /api/services/:id/metrics`, `WS /api/services/:id/events` | Runtime logs, allocation measurements, restart count; unavailable measurements remain explicit |
| Environment | `GET/PUT /api/projects/:id/environment`, `DELETE /api/projects/:id/environment/:key`, `GET .../:key/reveal` | Encrypted project variables, runtime injection, explicit reveal |
| Databases | `POST /api/databases`, `POST /api/databases/:id/attach`, `GET .../:id/connection`, `POST .../:id/retry`, `DELETE .../:id` | PostgreSQL, authenticated readiness, pinned node and volume, preserved data on removal |
| Domains | `POST /api/domains`, `DELETE /api/domains/:id` | Owned Cloudflare Tunnel/DNS lifecycle and observed public HTTPS health |
| Integrations | `GET /api/integrations`, `PUT .../github`, `PUT .../cloudflare`, `POST .../cloudflare/discover` | Validate and encrypt scoped provider credentials |
| GitHub | `GET /api/github/repositories`, `GET /api/integrations/github/webhook` | Repository selection and webhook configuration |
| Fleet | `POST /api/enrollment-tokens`, `PUT/DELETE /api/machines/:id` | One-use enrollment, roles, tags, location; protected stateful and hub dependencies |
| Runtime | `GET/PUT /api/runtime`, `POST .../bootstrap-registry` | Automatic fleet relay, advanced connection settings, R2 registry provisioning |
| Network | `GET/PUT /api/networking`, `GET /api/networking/:id/check` | Private inventory and observed outbound relay diagnostics |

`placement` is `{kind:"automatic"}`, `{kind:"home"}`, `{kind:"vps"}`, or `{kind:"machine",machine_id:"UUID"}`. Locations are `home`, `vps`, `dedicated`; roles are `compute`, `builder`, `database`.

## Agent and provider endpoints

- `GET /api/health`: unauthenticated process/version health.
- `POST /api/agent/enroll`: `{token,report}` atomically consumes an enrollment token and creates a separate durable identity.
- `POST /api/agent/:id/heartbeat`: machine-authenticated inventory and health; server owns roles, tags, identity and last-seen time.
- `GET /api/agent/:id/config`: authenticated fleet configuration, without other agents' private keys or Nomad management tokens.
- `GET /api/agent/:id/commands`, `POST /api/agent/:id/commands/:command_id`: bounded, encrypted-at-rest outbound command relay, scoped to the assigned machine.
- `POST /api/agent/:id/runtime-ready`: reports observed local scheduler readiness.
- `POST /api/github/webhook`: raw-body HMAC verification, durable delivery deduplication, branch filtering and a retryable deployment outbox.

WebSockets recheck session expiry and revocation. Fleet reconnects receive a complete snapshot. Service streams send `{type:"observability",lines,metrics,restarts,at}` or an explicit unavailable state. Network counters require the allocation's own agent; no counters are invented when the runtime cannot measure them.

See [runtime contracts](runtime-contract.md) for request examples and [the V1 specification](product/v1-spec.md) for product behavior.

## Cloudflare-hosted edition

The hosted backend preserves the fleet/project/service API under `/api`, with GitHub sessions replacing the single-owner token. `GET /api/session` identifies hosted mode and the current account/workspace. `POST /api/workspaces` creates a separate cloud; `POST /api/workspaces/:id/select` switches the session. Workspace owners manage membership under `/api/workspace/members`. GitHub App installation grants are selected explicitly per workspace.

Every authenticated workspace request is routed to that workspace's Durable Object. Machine credentials and single-use enrollment tokens resolve through the directory to exactly one workspace. Global `/api/events` and service `/api/services/:id/events` WebSockets require the same session and membership checks.

`POST /api/registry/credentials` returns that workspace's scoped OCI credentials. `/v2/` is the managed registry backed by R2. The operator-only `/api/operator/import` endpoint is disabled unless `MIGRATION_TOKEN` is configured. See [hosted setup](cloudflare-hosted.md) and [migration](hosted-migration.md) for deployment and supported migration boundaries.

### Hosted readiness additions

- `GET /api/snapshot` includes `readiness`: status (`ready`, `blocked`, `checking`), observation time, connected/run/build counts, machine capabilities, actionable blockers, and recommended enrollment roles. Missing readiness on older/self-hosted servers means unknown, never implicitly ready.
- Snapshot `enrollments` contains only `{id, expires_at, status, machine_id}` for active/recent enrollment attempts; secret tokens and token hashes are never included.
- `GET /api/services/:id/preflight` returns the readiness shape plus `service_id`, validating service placement/architecture and, after fleet prerequisites pass, its selected GitHub repository/branch.
- An interactive source `POST /api/services/:id/deploy` that fails preflight returns `409` or `503` with `{error, readiness}` and creates no deployment. Actual job reconciliation remains authoritative. Rollback/image and webhook flows preserve their existing validation/history.
- Hosted enrollment accepts omitted metadata with recommended roles, `home` location and empty tags. Hosted service creation accepts an omitted port as `3000`. These are explicit defaults, not automatic framework or network detection.
- `DELETE /api/enrollment-tokens/:id` revokes an unused hosted enrollment command in the current workspace. It is safe to retry, removes the waiting entry, and rejects already-connected grants with `409`; it never disconnects a machine. A revoked token cannot enroll even if its request was routed before directory cleanup.

#### Hosted Cloudflare inventory

- `GET /api/integrations/cloudflare/overview`: workspace-only Workers/Pages inventory,
  24-hour Worker request/error/subrequest counts, provider issues, and observation time.
  Cached for 60 seconds. Returns `not_connected`, `connected`, `partial`, or `error`;
  unavailable metrics are null. This does not expose platform-wide credentials/resources.
- `POST /api/integrations/cloudflare/account`: `{account_id, api_token}`. Validates read
  access before encrypting and replacing the optional workspace inventory connection.
  A failed validation preserves the previous connection.
- `DELETE /api/integrations/cloudflare/account`: disconnects inventory, clears cached
  observations, and suppresses imported-credential fallback. Domain hosting is unaffected.

All three require an authenticated workspace member; machine credentials cannot use them.

#### Hosted project organization

`GET /api/snapshot` advertises `capabilities.project_organization: true` and adds
`project_resources`. Older/self-hosted backends omit the capability; clients must
keep their existing project workflow there.

- `POST /api/projects` accepts `{name, repository?, branch?}`. Without a repository,
  a project is an organization container and does not need machines or GitHub access.
  The stored `repository` is an empty string; `branch` defaults to `main`.
- `PATCH /api/projects/:id` accepts `{name?, repository?, branch?}`. This can attach a
  repository later. Source/branch changes are rejected while machine services exist.
  Adding a machine service still requires a repository and deployment still checks readiness.
- Cloudflare overview/account responses add `organization: {revision, resources}`.
  Records contain `id, account_id, kind, name, project_id, environment, ignored,
  updated_at`. Kind is `worker` or `pages`. Environment is `production`, `development`,
  `staging`, or `preview`. Overview records belong only to its current account;
  snapshot records retain associations from previously connected accounts.
- `POST /api/integrations/cloudflare/organize` accepts `{account_id, revision,
  assignments}`. Each assignment contains `{kind, name, environment?, project_id?,
  project_name?, ignored?}`. Select an existing project by ID or create/reuse a project
  by case-insensitive exact name. Ambiguous names require an ID. Omitting both project
  selectors unassigns; `ignored: true` hides an unassigned resource. Ignore and project
  assignment are mutually exclusive. One batch accepts up to 1,100 resources.
- Save returns `{projects, organization}`. All rows validate before a synchronous
  transaction. Stale revisions/account changes return `409`; foreign project IDs
  return `404`. New assignments require observed inventory. Existing metadata can be
  released when the provider no longer returns the resource.

Organization never renames, deploys, provisions, upgrades, or deletes provider resources.
Deleting a dinghy project releases its Cloudflare associations only. Credentials remain
workspace-encrypted; grouping suggestions are client-side hypotheses, never source or
billing claims. Existing provider plans and billing continue independently of grouping.

Explicit unassignment is persisted as `project_id: null, ignored: false`, so a later
organization session respects that choice instead of silently suggesting reassignment
as part of an unrelated save. Removing a project clears its resource `project_id` and
preserves these unassigned records. Never-touched discovered resources have no record.

### Hosted PostgreSQL backups

These routes require workspace membership. They are specific to the hosted edition.

- `GET /api/databases/:id/backups`: policy plus backup/restore history; no transfer tokens or storage keys.
- `POST /api/databases/:id/backups`: queue a manual backup of a healthy database.
- `PUT /api/databases/:id/backups/policy`: `{ "enabled": true, "keep": 7 }`; daily cadence, retention 1–30 successful copies.
- `POST /api/databases/:id/backups/:backupId/restore`: `{ "name": "Restored copy", "machine_id": "optional explicitly selected machine" }`; creates a separate destination and returns `target_database_id`.
- `DELETE /api/databases/:id/backups/:backupId`: expire one completed copy, rejected while a restore uses it. This permanently removes that backup object.

Backup transfers use `/api/agent/:machineId/database-backups/:operationId/data` with a short-lived operation credential; machine inventory credentials do not grant backup access. PUT is bounded binary data with Content-Length and `x-backup-sha256`; GET is allowed only for the matching restore operation. Each successful operation requires observed scheduler completion and a verified R2 object. See [hosted backup boundaries](cloudflare-hosted.md#postgresql-backups-and-restore-copies).
