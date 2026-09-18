# Neon and Convex account connections

The Cloudflare-hosted control plane supports organization-level database integrations. The retained Rust control plane does not expose these endpoints; the shared dashboard hides provider controls when the snapshot does not advertise them.

## Connect once, choose resources

In **Settings → Connected backends**, connect a Neon organization or Convex team. Multiple accounts are supported. Credentials are encrypted in that workspace and never included in snapshots or app environments.

- **Neon:** enter an organization ID and an organization API key (or personal key authorized for that organization). Dinghy lists projects, branches, databases and non-protected roles. Linking retrieves a pooled TLS PostgreSQL URI for the selected database and role. Attach it to a service to supply `DATABASE_URL` on the next deployment.
- **Convex Cloud:** enter the numeric team ID and a team access token. A deployment key is not an organization credential. Dinghy lists the team's projects and cloud deployments, then links the selected deployment URL. It does not create deployments or deploy Convex functions.
- **Self-hosted Convex:** use **Databases → Self-hosted Convex** to connect an existing backend through a public HTTPS origin. An authenticated environment-list request verifies the admin key; returned environment values are discarded. The key is encrypted and available only through explicit connection reveal. Dinghy does not install, relocate, back up or upgrade this backend. Private-only endpoints and custom ports are not supported by this hosted connector.

Project and branch lists are paginated; use **Load more** for further results. An API failure is shown explicitly rather than replaced with an empty success state.

## Service attachments

Each service can attach one PostgreSQL connection (fleet or Neon) and one Convex connection. Conflicts require an explicit detach; Dinghy never silently replaces credentials. Cross-project attachments are rejected. Changes apply on the next deployment and are blocked while a deployment is active.

Convex attachments supply `CONVEX_URL` and optionally `NEXT_PUBLIC_CONVEX_URL`, `VITE_CONVEX_URL` or `PUBLIC_CONVEX_URL` **at runtime**. Frameworks that embed URLs into their browser bundle also need the same URL configured in their build; this feature does not add build-time variable injection or run `convex deploy`. Team tokens and self-hosted admin keys are never injected into apps or builds. For CLI deployment to a self-hosted backend, explicitly reveal its `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY` and use them in your own trusted deployment process.

Project environment values that conflict with an attached provider variable block deployment with an explanation. Database query health is not monitored by the connector: “linked” means provider discovery/access was checked at the recorded time, not that a current app query succeeded.

## Removal and credential changes

Detach readers before unlinking. Unlinking removes only Dinghy's saved connection; provider resources and data remain intact. Disconnect an account only after unlinking its resources. Project deletion is blocked while provider resources remain linked. Removing a service removes its provider bindings.

**Replace key** validates a new account credential before saving it. It does not rotate a Neon role password or update a cached database connection string. If the provider rotates a database password, detach/unlink and link that database again to fetch its new credentials. Backups, restores and data retention remain with Neon, Convex Cloud, or the self-hosted backend operator.

## Verification boundary

Tests exercise real local workerd/SQLite storage and production API handlers with synthetic external provider responses. They cover pagination, organization/workspace isolation, binding conflicts, lifecycle races, encryption/snapshot redaction, explicit reveal and non-destructive disconnect. Additional tests verify app environment isolation and rejection of conflicting variables. Desktop and 390-pixel mobile checks exercise the local account → project → branch → database → attachment flow, including a visible fleet-binding conflict.

No live Neon/Convex account or self-hosted backend has been connected as part of this implementation. Provider credentials must be entered through the application before claiming live access or application connectivity.

API references: [Neon organization API](https://neon.com/docs/manage/orgs-api), [Convex Management API](https://docs.convex.dev/management-api/overview), [Convex self-hosting](https://docs.convex.dev/self-hosting).

## Self-hosted Convex operating flow

After connecting an existing backend, its detail view includes a fresh authenticated access check, an optional dashboard shortcut, and individually copyable connection values. Localhost dashboard shortcuts require the owner's existing tunnel; Dinghy never places an admin key in a URL. The database overview counts connected backends as well as provisioned PostgreSQL instances, without treating connection access as application query health.

Save an explicit **HTTP actions URL** for workers that use `CONVEX_SITE_URL`. Attaching this variable supplies the actions origin and the normal `CONVEX_URL` separately on the next deployment. Readers must be detached before changing their actions origin. Frontend build-time injection remains outside this runtime attachment flow.

For a backend already running on the fleet, **Connect existing fleet runtime** verifies its Nomad job, original workspace machine, single instance, disabled relocation, and absolute persistent data mount. The recorded runtime can be refreshed from the detail view. Association does not modify the running job or import backup ownership. Native Convex provisioning, upgrades, backup orchestration and migrations are still not implemented; a linked or running badge does not claim those capabilities.
