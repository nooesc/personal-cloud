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
