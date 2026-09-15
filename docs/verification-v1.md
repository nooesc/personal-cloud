# V1 verification — 2026-09-15

These results describe executed checks, not inferred provider success. The original product target is in [the V1 spec](product/v1-spec.md).

## Application and release

- Rust workspace formatting/tests and Clippy with warnings denied passed.
- Dashboard production build and TypeScript checks passed.
- Desktop and 390px mobile project views were rendered and inspected; mobile content stayed within the viewport.
- Browser verification covered real deployment progress/history, logs, metrics, and saving/revealing an encrypted environment value.
- The production Compose package passed 25 checks covering built SSR/static assets, same-origin API and WebSocket proxying, authentication, origin rejection, persisted service settings, encrypted secrets, session revocation, and persistence across API/web restarts.
- A second fresh installation pulled the published API/web images anonymously using the default startup command and passed all 25 production checks. Both released images provide Linux amd64 and arm64 manifests; their `latest` tags matched `v0.1.0` at verification time.
- GitHub CI passed for the V1 implementation. The published agent release contains amd64/arm64 archives and SHA256 checksums.

## Runtime and recovery

An isolated Linux fleet ran Nomad 2.0.6, Docker, BuildKit 0.33.0, Railpack 0.39.0, and a real OCI registry.

- A pinned public FastAPI source commit was cloned, detected by Railpack, built by BuildKit, pushed as an immutable image, scheduled through the application API, and observed serving HTTP.
- A deliberately failing new health path failed deployment while the prior version kept serving HTTP.
- Explicit rollback selected the same image digest and completed without a source rebuild.
- Pausing a running application's container triggered automatic health-failure rollback; HTTP recovered in approximately 53 seconds.
- Hard-stopping a separate scheduler client and its workload containers moved an automatic stateless service to another node; HTTP recovered in approximately 31 seconds.
- PostgreSQL on the failed node remained pinned and unavailable, without moving to another node. Explicit retry after node recovery returned it to healthy on its original volume.

The first two-client harness shares a Docker daemon to simulate node loss cheaply. Its dangling-container collector is disabled because independent Nomad clients otherwise consider each other's containers untracked. Separate Debian/systemd agents below use separate Docker daemons and exercise the real installation model.

## Fresh agents and private networking

- Fresh Debian 12 machines installed Docker, Nomad, WireGuard, BuildKit where selected, and the agent as system services.
- The published `v0.1.0` installer and released arm64 archive were downloaded from GitHub, checksum-verified, installed, and observed joining the fleet. No local binary override was used.
- Multiple actual agents joined WireGuard and an ACL-protected Nomad cluster; selected roles/tags matched, private key/identity files were mode0600, and anonymous scheduler job requests returned 403.
- Outbound authenticated command relay returned observed scheduler health.
- A separate worker's PostgreSQL client crossed WireGuard to a pinned database, inserted/read a row, and read the row after the database allocation restarted.
- Real Docker network byte counters traversed the encrypted command relay. CPU and memory measurements were verified after enabling Nomad allocation telemetry.
- Anonymous pull of the published multi-architecture builder image passed.

## Data and concurrency

- PostgreSQL accepted an authenticated query before being marked healthy.
- Database credentials, named volume, cluster identity, and saved data survived recovery on the selected node. A real application received its attached `DATABASE_URL`.
- Database removal stopped the job and removed its active binding while retaining the Docker volume and encrypted recovery record.
- Seven PostgreSQL lifecycle regressions covered queue/deletion serialization, atomic promotion, post-commit errors, failed routing rollback, delayed acknowledgements, cleanup completion tracking, and diagnostics during database degradation.
- Additional PostgreSQL checks verified signed webhook deduplication/recovery and 1,000 network configuration refreshes without consuming new address allocations.
- An independent source review identified lifecycle/routing issues; its focused re-review reported no outstanding actionable findings after fixes.

## Public-provider boundary

GitHub/Cloudflare protocol, signature, ownership, encryption, retry, and failure paths have executable tests. After connecting a real account, scoped Cloudflare and bucket-specific R2 credentials passed discovery and signed bucket validation. An R2-backed registry was provisioned on the installed fleet. A fresh source build pushed an immutable image through that registry and served its application over a newly provisioned Cloudflare Tunnel and public HTTPS hostname. A subsequent immutable rollback moved the app to another installed machine, advanced the connector configuration version, and passed all 13 concurrent public HTTPS checks. Direct signed S3 listing confirmed image blobs and manifest records persisted in R2. The full zero-to-public-app ten-minute onboarding target remains unmeasured.

The live API omitted the optional connector `config_version`. The control plane now also checks cloudflared's own successful configuration acknowledgement, tied to the active connector UUID and allocation task start. Persisted checkpoints survive log rotation; missing or stale evidence keeps the previous deployment serving.

HTTP health probes explicitly close their connections. The live Python app intermittently closed idle connections at the probe interval; ten consecutive probes passed after the connection-reuse fix.

## Repeat locally

```sh
pnpm check
cargo clippy --workspace --all-targets -- -D warnings
pnpm smoke
python3 scripts/test-postgres.py
# See infra/README.md for an owned disposable Linux fleet.
python3 scripts/runtime-smoke.py <fleet-test-name>
python3 scripts/recovery-smoke.py <fleet-test-name>
```

Runtime tests intentionally leave labelled acceptance records for inspection. Database removal preserves volumes. Follow the harness's ownership-checked cleanup instructions; do not delete unrelated machines, containers, or volumes.
