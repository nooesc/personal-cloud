# Move an existing self-hosted cloud to hosted Workers

This migration preserves machine identities, WireGuard addresses and the original server, Nomad job IDs, immutable image history, database volume ownership, existing public tunnels/DNS, project configuration, and encrypted credentials. It does **not** stop, replace, re-enroll, or move running workloads. The source PostgreSQL database remains unchanged.

The exporter reads a repeatable-read PostgreSQL snapshot and writes a new **mode 0600 encrypted bundle**. Decryption happens only in process memory. The importer requires a separate operator migration token and an empty destination workspace. Ordinary GitHub users cannot invoke it.

## Before exporting

1. Back up PostgreSQL, application volumes, and the source encryption key. Preserve the original control-plane deployment for rollback.
2. Deploy the hosted backend with D1 migrations, Durable Objects, R2, GitHub App credentials, `ENCRYPTION_KEY`, and the intended `PUBLIC_URL`. Keep the public domain on the existing backend until cutover is ready.
3. Keep the **same GitHub App ID and client ID** to preserve existing authorization tokens/installations. Configure that App's private key, client secret and webhook secret as hosted secrets. Import refuses to attach old grants to another App. Existing browser sessions are not transferred; the owner signs in again.
4. Choose the destination workspace UUID and hosted user UUID. If that GitHub account already signed into hosted, use its existing `users.id`; do not invent a second identity. An existing target workspace must have exactly that owner and no cloud data.
5. Quiesce control-plane changes: disable incoming deployment triggers and finish active builds/deployments, promotions, database/domain creation or deletion, pending GitHub deployment requests, and mutating fleet commands. Keep applications running. Export refuses these in-flight states rather than inventing a resume point. Do not let the old controller mutate state between export and final cutover.

## Export

Use Node.js 22+ and either local `psql` or a named PostgreSQL Docker container. Provide keys through an operator-managed environment; do not put secret values into shell history or commit them:

- `PC_SECRET_KEY`: source key, exactly 64 hexadecimal characters.
- `ENCRYPTION_KEY`: the destination Worker's encryption secret, at least 32 characters.

Example, using the source Docker container:

```sh
node scripts/export-hosted.mjs \
  --docker-container SOURCE_POSTGRES_CONTAINER \
  --database-user personal_cloud \
  --database-name personal_cloud \
  --workspace-id DESTINATION_WORKSPACE_UUID \
  --user-id DESTINATION_USER_UUID \
  --workspace-name 'My cloud' \
  --public-url https://cloud.example.com \
  --output /private/operator/location/hosted-bundle.json
```

Alternatively pass `--database-url "$DATABASE_URL"` instead of `--docker-container`; the exporter passes individual connection credentials to `psql` through its environment, without echoing them. Keep the calling environment and shell history private. PostgreSQL URL `sslmode` is preserved; additional libpq connection options can be supplied through the standard `PG*` environment variables.

The linked `github_owner` numeric ID is authoritative. A source that never linked GitHub requires explicit `--github-owner-id NUMBER --github-owner-login LOGIN`, supplied only after the operator has verified the intended account. Missing required tables or unsupported source states produce a diagnostic without creating an output file. Existing output files are never overwritten.

Treat the bundle like a database backup even though credentials are encrypted: it contains machine credential hashes, source names, IPs, routing identifiers, and encrypted secrets. Keep it outside the repository. The exporter never prints source rows or credentials.

## Import

Temporarily configure a random, separate `MIGRATION_TOKEN` of at least 32 characters on the hosted backend. The endpoint is absent when that secret is unset. It accepts:

```http
POST /api/operator/import
Authorization: Bearer <operator migration token>
Content-Type: application/json

<exact encrypted bundle bytes>
```

Upload with an operator tool that reads its Authorization header from protected storage. Do not paste the token into the dashboard, committed scripts, or chat. The importer is idempotent only for the **same bundle** and workspace; an altered bundle cannot overwrite an earlier import.

Import phases:

1. Validate format, encryption, foreign references, identity ownership, destination emptiness, and conflicting machine/domain routes.
2. Write documents atomically to the destination Durable Object with a `meta/migration` **staged** marker. The workspace must reject normal requests and alarms while staged.
3. Publish the owner, membership, installation grants and machine/domain directory routes in one D1 batch.
4. Mark the workspace active and schedule reconciliation.

If publication or activation fails, retry the exact bundle. Do not create a new export with different IDs and do not manually remove the staging marker. The importer does not expose an automatic destructive rollback. The source remains intact.

**Integration contract:** route `handleMigration(request, env)` before regular user authentication in the control Worker. Route `handleWorkspaceMigration(request, ctx)` before ordinary Durable Object handlers; reject all other traffic and alarm work when `meta/migration.status === 'staged'`. The public Worker must continue rejecting `/internal/*`. Both helpers are in `apps/control-cloud/src/migration.ts`.

## What remains operational

- Machines retain their credential hashes and IDs. Point agents at the new control URL, or cut over the existing URL; **do not enroll them again**. Their original private IPs and server flags are preserved.
- Databases retain exact `volume_name`, original machine ID, Nomad node ID, job ID, port, and credentials. Hosted retry/deletion keeps the existing volume safeguards.
- Running services keep their deployment/current pointers and scheduler job IDs. Import emits completed deployment phases, so reconciliation observes existing workloads instead of resubmitting them.
- Old immutable images continue to use the encrypted `settings/legacy-runtime` registry connection for authorized rollback of imported image history. New builds use the hosted per-workspace registry. Keep the old registry and its storage available until all required old images are deliberately retired or migrated.
- Existing domains retain `account_id`, `zone_id`, `tunnel_id`, `dns_record_id`/`dns_id`, configuration version and upstream. `legacy: true` selects per-domain tunnel compatibility. Existing Cloudflare credentials are re-encrypted under `settings/legacy-cloudflare`; they remain scoped to this imported workspace. No tunnel or DNS replacement is required by the importer.
- Legacy provider credentials not used by hosted behavior remain encrypted in `legacy_integrations`, and additional settings remain encrypted in `legacy_settings`. They are not exposed in public snapshots.

After checking the imported dashboard, agent heartbeats, scheduler visibility, existing routes and database ownership, perform the planned DNS/agent cutover. Update the GitHub App callback/webhook URLs to the hosted origin if the origin changes. Prevent simultaneous old/new controllers from reconciling the same fleet. Remove `MIGRATION_TOKEN` after completion and retain a protected copy of the bundle with the source backup.

## Encryption and transformed document contract

Source AES-256-GCM values are standard Base64 of `12-byte IV || ciphertext || 16-byte tag`, with the raw 32-byte hexadecimal `PC_SECRET_KEY` and the legacy context as associated data. Contexts include `env:PROJECT:KEY`, `database:ID`, `runtime:registry`, `integration:KEY`, and `fleet-command:ID`.

Hosted workspace encryption uses SHA-256 of the textual `ENCRYPTION_KEY` as the AES key, fresh 12-byte IVs, and `WORKSPACE_ID:CONTEXT` as associated data. Serialization is `base64(IV).base64(ciphertext || tag)`, exactly matching `src/crypto.ts`. Legacy runtime and Cloudflare settings use contexts `legacy-runtime` and `legacy-cloudflare` respectively.

Hosted user OAuth tokens use associated data `github-user:USER_ID` and serialization `v1.base64url(IV).base64url(ciphertext || tag)`, matching `src/auth/crypto.ts`. Legacy OAuth `expires_at` seconds are converted to milliseconds.

The bundle contains documents shaped `{ collection, id, value }`, not executable SQL. Imported deployments carry `imported_from: 'self-hosted'` and `phase: 'done'`. Historical deployment redaction values are reconstructed from the current source environment and database binding. The legacy schema does not retain environment values from each old build; secrets changed before export cannot be reconstructed from PostgreSQL. A future/nonstandard nonempty `deployment_environment` table is rejected until its encryption contract is explicitly supported.

## Explicit limits

- No active-operation handoff or merging into a populated hosted workspace.
- One original enrolled fleet server; custom external Nomad servers, unmanaged WireGuard peers, direct Nomad URLs, and Nomad ACL-token configurations are rejected.
- All preserved immutable images must belong to the exported legacy registry. Historical images from another registry require explicit support instead of silently losing rollback capability.
- No new registry image copy, application volume copy, machine re-enrollment, provider permission grant, or DNS cutover occurs during export/import.
- Browser sessions, OAuth flows, unused enrollment tokens, old command results, old machine metric samples, and old webhook receipt deduplication are not transferred. They are operationally ephemeral; the source backup remains their archive.
- Maximum bundle size is 16 MiB and 10,000 documents. Larger fleets/history require a separately designed chunked import; this tool refuses oversized bundles.
- Validation of a synthetic bundle is not proof that existing machines, GitHub grants, Cloudflare credentials, images or routes work against the hosted deployment. Keep operational verification separate from migration format tests.
