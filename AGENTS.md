# Personal Cloud

Read `docs/product/v1-spec.md` and the capabilities and validation boundary in `README.md` before changing scope. Local working plans may exist in ignored `docs/plans/`; do not commit them. This is a fresh, standalone product. The blessed stack and explicit V1 non-goals are settled.

## Rules
- Never claim a deployment, integration, tunnel, database, or network is operational from mock data or a generated configuration alone. Require observed provider/runtime state.
- Demo fixtures stay browser-only. A live backend failure must never silently fall back to demo data.
- Stateful workloads never automatically relocate. Preserve explicit node and persistent-volume ownership through failures, retries, removal and recovery.
- Owner, enrollment, machine, and application credentials have separate trust boundaries. Never include `.env`, identity files, or real infrastructure metadata in commits.
- The development stack defaults to loopback. Do not operate the user's existing cloud or fleet to test a change unless they authorize that scope.

## Checks
`pnpm check`, `cargo clippy --workspace -- -D warnings`, and `pnpm smoke` and `python3 scripts/test-postgres.py` against the local dev stack. UI changes require rendered desktop/mobile checks. API behavior is checked through PostgreSQL-backed smoke tests, not an in-memory substitute.

## Commands
`pnpm dev` for the complete local loop; `pnpm dev:web` for the frontend; `cargo run -p personal-cloud-agent` for inventory reporting. Development processes and intermediate artifacts belong in ignored `work/`.
