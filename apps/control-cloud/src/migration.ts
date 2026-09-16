import type { Env } from "./env";
import { fail, json, type Doc, type WorkspaceContext } from "./core";
import { equal, open, sha256 } from "./crypto";
import { open as openAuth } from "./auth/crypto";

type MigrationEnv = Env & { MIGRATION_TOKEN?: string };
type Bundle = {
  format: string;
  created_at: string;
  workspace: { id: string; name: string };
  user: {
    id: string;
    github_id: number;
    login: string;
    avatar_url: string;
    github_token: string | null;
  };
  github_app: { id: number; client_id: string } | null;
  installations: Doc[];
  requirements: string[];
  documents: { collection: string; id: string; value: Doc }[];
  verification: string;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const collections = [
  "machines",
  "network_nodes",
  "projects",
  "services",
  "deployments",
  "databases",
  "retained_volumes",
  "bindings",
  "environment",
  "domains",
  "events",
  "settings",
  "legacy_settings",
  "legacy_integrations",
];
const emptyCollections = [
  ...collections,
  "commands",
  "enrollments",
  "samples",
  "push_requests",
  "runtime_stops",
  "runtime_operations",
  "webhooks",
];
const supported = new Set(["legacy-domain-tunnels", "legacy-registry-pull"]);
async function readJson(request: Request): Promise<Doc> {
  if (Number(request.headers.get("Content-Length") || 0) > 16 * 1024 * 1024)
    fail(413, "Migration bundle exceeds 16 MiB");
  const reader = request.body?.getReader();
  if (!reader) fail(400, "Migration bundle is required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16 * 1024 * 1024) {
      await reader.cancel();
      fail(413, "Migration bundle exceeds 16 MiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(400, "Invalid migration JSON");
  }
}
async function validateBundle(input: Doc, env: Env): Promise<Bundle> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail(400, "Invalid migration bundle");
  if (
    input.format !== "personal-cloud-hosted-v1" ||
    !uuid.test(input.workspace?.id) ||
    !uuid.test(input.user?.id) ||
    !Number.isSafeInteger(input.user.github_id) ||
    input.user.github_id < 1 ||
    typeof input.user.login !== "string" ||
    !input.user.login ||
    typeof input.workspace.name !== "string" ||
    !input.workspace.name.trim() ||
    input.workspace.name.length > 80
  )
    fail(400, "Invalid migration identity or format");
  if (
    !Array.isArray(input.documents) ||
    input.documents.length > 10000 ||
    !Array.isArray(input.installations) ||
    input.installations.length > 1000 ||
    !Array.isArray(input.requirements) ||
    input.requirements.some(
      (r: unknown) => typeof r !== "string" || !supported.has(r),
    )
  )
    fail(400, "Unsupported migration requirements or record count");
  if (
    (await open(
      env.ENCRYPTION_KEY,
      `${input.workspace.id}:migration-verification`,
      input.verification,
    )) !== "personal-cloud-hosted-v1"
  )
    fail(400, "Bundle encryption does not match this deployment");
  if (input.user.github_token || input.installations.length) {
    if (
      String(input.github_app?.id) !== String(env.GITHUB_APP_ID) ||
      input.github_app?.client_id !== env.GITHUB_CLIENT_ID
    )
      fail(
        409,
        "Preserve the existing GitHub App ID/client ID before importing its user grants",
      );
  }
  if (input.user.github_token) {
    const token = JSON.parse(
      await openAuth(
        env,
        `github-user:${input.user.id}`,
        input.user.github_token,
      ),
    );
    if (typeof token.access_token !== "string")
      fail(400, "Invalid encrypted GitHub user credential");
  }
  const keys = new Set<string>(),
    byCollection = new Map<string, Map<string, Doc>>();
  for (const row of input.documents) {
    if (
      !row ||
      !collections.includes(row.collection) ||
      typeof row.id !== "string" ||
      !row.id ||
      row.id.length > 256 ||
      !row.value ||
      typeof row.value !== "object" ||
      Array.isArray(row.value) ||
      JSON.stringify(row.value).length > 1024 * 1024
    )
      fail(400, "Invalid migration document");
    if (
      [
        "machines",
        "network_nodes",
        "projects",
        "services",
        "deployments",
        "databases",
        "retained_volumes",
        "environment",
        "domains",
        "events",
        "legacy_settings",
        "legacy_integrations",
      ].includes(row.collection) &&
      row.value.id !== row.id
    )
      fail(400, "Migration document ID mismatch");
    if (row.collection === "bindings" && row.value.service_id !== row.id)
      fail(400, "Binding document ID mismatch");
    const key = `${row.collection}:${row.id}`;
    if (keys.has(key)) fail(400, "Duplicate migration document");
    keys.add(key);
    if (!byCollection.has(row.collection))
      byCollection.set(row.collection, new Map());
    byCollection.get(row.collection)!.set(row.id, row.value);
  }
  const rows = (collection: string) => [
      ...(byCollection.get(collection)?.values() || []),
    ],
    has = (collection: string, id: unknown) =>
      typeof id === "string" && byCollection.get(collection)?.has(id);
  for (const m of rows("machines"))
    if (
      !uuid.test(m.id) ||
      !/^[a-f0-9]{64}$/.test(m.credential_hash) ||
      !m.report ||
      !Array.isArray(m.roles)
    )
      fail(400, "Invalid migrated machine credential");
  const nodes = rows("network_nodes");
  if (rows("machines").length && nodes.filter((n) => n.is_server).length !== 1)
    fail(400, "Preserve exactly one original fleet server");
  const slots = new Set<number>();
  for (const node of nodes) {
    if (
      !has("machines", node.machine_id) ||
      node.id !== node.machine_id ||
      !Number.isInteger(node.slot) ||
      node.slot < 2 ||
      node.slot > 65534 ||
      slots.has(node.slot) ||
      node.private_ip !== `10.77.${node.slot >> 8}.${node.slot % 256}`
    )
      fail(400, "Invalid or conflicting fleet address");
    slots.add(node.slot);
  }
  for (const s of rows("services"))
    if (
      !has("projects", s.project_id) ||
      s.status === "deleting" ||
      s.promotion_deployment_id ||
      s.promotion_address ||
      (s.current_deployment_id && !has("deployments", s.current_deployment_id))
    )
      fail(400, "Unsupported service state or foreign reference");
  for (const d of rows("deployments")) {
    if (
      !has("services", d.service_id) ||
      !["healthy", "failed", "rolled_back"].includes(d.status) ||
      d.phase !== "done" ||
      d.imported_from !== "self-hosted"
    )
      fail(400, "Drain active deployments before migration");
    if (d.secrets_encrypted)
      await open(
        env.ENCRYPTION_KEY,
        `${input.workspace.id}:deployment:${d.id}:secrets`,
        d.secrets_encrypted,
      );
  }
  for (const d of rows("databases")) {
    if (
      !has("projects", d.project_id) ||
      !has("machines", d.machine_id) ||
      !d.volume_name ||
      !d.nomad_node_id ||
      !d.job_id ||
      !["ready", "failed"].includes(d.phase)
    )
      fail(
        400,
        "Database migration requires explicit original volume/node/job ownership",
      );
    await open(
      env.ENCRYPTION_KEY,
      `${input.workspace.id}:database:${d.id}`,
      d.connection_encrypted,
    );
  }
  for (const d of rows("retained_volumes")) {
    const ownerPresent = has("machines", d.machine_id);
    if (
      !uuid.test(d.machine_id) ||
      typeof d.volume_name !== "string" ||
      !d.volume_name ||
      typeof d.nomad_node_id !== "string" ||
      !d.nomad_node_id ||
      d.status !== "retained" ||
      d.recovery_requires_original_machine !== true ||
      d.owner_inventory_status !== (ownerPresent ? "present" : "missing")
    )
      fail(
        400,
        "Retained volume must preserve its recorded original owner and recovery restriction",
      );
    await open(
      env.ENCRYPTION_KEY,
      `${input.workspace.id}:database:${d.id}`,
      d.connection_encrypted,
    );
  }
  for (const b of rows("bindings"))
    if (!has("services", b.service_id) || !has("databases", b.database_id))
      fail(400, "Database binding target missing");
  for (const e of rows("environment")) {
    if (!has("projects", e.project_id))
      fail(400, "Environment project missing");
    await open(
      env.ENCRYPTION_KEY,
      `${input.workspace.id}:env:${e.project_id}:${e.key}`,
      e.value_encrypted,
    );
  }
  for (const d of rows("domains"))
    if (
      !has("services", d.service_id) ||
      !d.legacy ||
      !d.tunnel_id ||
      !d.dns_id ||
      !d.account_id ||
      !d.zone_id ||
      typeof d.hostname !== "string"
    )
      fail(
        400,
        "Domain migration must preserve existing tunnel, DNS and account ownership",
      );
  const settings = byCollection.get("settings");
  for (const [name, value] of settings || []) {
    if (!["runtime", "legacy-runtime", "legacy-cloudflare"].includes(name))
      fail(400, "Unsupported migrated runtime setting");
    if (name === "runtime") {
      if (
        typeof value.nomad_url !== "string" ||
        !nodes.some(
          (n) => n.is_server && `agent://${n.machine_id}` === value.nomad_url,
        ) ||
        value.nomad_token ||
        value.registry_password
      )
        fail(
          400,
          "Runtime must use the preserved server agent without plaintext credentials",
        );
    } else
      await open(
        env.ENCRYPTION_KEY,
        `${input.workspace.id}:${name}`,
        value.encrypted,
      );
  }
  for (const name of ["legacy_settings", "legacy_integrations"])
    for (const row of rows(name))
      await open(
        env.ENCRYPTION_KEY,
        `${input.workspace.id}:${name === "legacy_settings" ? "legacy-setting" : "legacy-integration"}:${row.id}`,
        row.encrypted,
      );
  for (const i of input.installations)
    if (
      !Number.isSafeInteger(i.id) ||
      i.id < 1 ||
      typeof i.account_login !== "string" ||
      !["User", "Organization"].includes(i.account_type) ||
      !["all", "selected"].includes(i.repository_selection)
    )
      fail(400, "Invalid legacy installation");
  return input as Bundle;
}
export async function handleWorkspaceMigration(
  request: Request,
  ctx: WorkspaceContext,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/internal/migration/")) return null;
  if (request.method !== "POST") fail(405, "Method not allowed");
  const input = await readJson(request),
    marker = ctx.store.get("meta", "migration");
  if (path === "/internal/migration/status")
    return json({
      migration: marker || null,
      empty: emptyCollections.every((c) => ctx.store.list(c).length === 0),
    });
  if (path === "/internal/migration/activate") {
    if (!marker || marker.digest !== input.digest)
      fail(409, "Migration staging does not match this bundle");
    ctx.store.put("meta", "migration", {
      ...marker,
      status: "active",
      activated_at: new Date().toISOString(),
    });
    await ctx.schedule(1000);
    ctx.broadcast();
    return json({ ok: true, status: "active" });
  }
  if (path !== "/internal/migration/stage")
    fail(404, "Migration operation not found");
  const bundle = await validateBundle(input.bundle, ctx.env),
    digest = await sha256(JSON.stringify(bundle));
  if (input.digest !== digest || bundle.workspace.id !== ctx.workspaceId)
    fail(400, "Migration workspace or digest mismatch");
  if (marker) {
    if (marker.digest !== digest)
      fail(409, "A different bundle already owns this migration");
    return json({ ok: true, status: marker.status, digest });
  }
  ctx.store.transaction(() => {
    if (emptyCollections.some((c) => ctx.store.list(c).length))
      fail(
        409,
        "Target workspace must be empty; existing cloud data will not be overwritten",
      );
    for (const row of bundle.documents)
      ctx.store.put(row.collection, row.id, row.value);
    ctx.store.put("meta", "migration", {
      digest,
      status: "staged",
      source: "self-hosted",
      created_at: new Date().toISOString(),
    });
  });
  return json({ ok: true, status: "staged", digest });
}
export async function handleMigration(
  request: Request,
  env: MigrationEnv,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/operator/import") return null;
  if (!env.MIGRATION_TOKEN || env.MIGRATION_TOKEN.length < 32)
    return json({ error: "Not found" }, 404);
  const supplied =
    request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
  if (!equal(await sha256(supplied), await sha256(env.MIGRATION_TOKEN)))
    fail(401, "Operator migration authorization required");
  if (request.method !== "POST") fail(405, "Method not allowed");
  const bundle = await validateBundle(await readJson(request), env),
    workspaceId = bundle.workspace.id,
    digest = await sha256(JSON.stringify(bundle)),
    stub = env.WORKSPACES.getByName(workspaceId);
  const call = (action: string, value: unknown) =>
    stub.fetch(`https://workspace.internal/internal/migration/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pc-workspace-id": workspaceId,
      },
      body: JSON.stringify(value),
    });
  const currentUser = await env.DIRECTORY.prepare(
    "SELECT id,github_id FROM users WHERE id=? OR github_id=?",
  )
    .bind(bundle.user.id, bundle.user.github_id)
    .all<{ id: string; github_id: number }>();
  if (
    currentUser.results.some(
      (u) => u.id !== bundle.user.id || u.github_id !== bundle.user.github_id,
    )
  )
    fail(
      409,
      "Target GitHub identity already has another ID; re-export with that hosted user ID",
    );
  const workspace = await env.DIRECTORY.prepare(
    "SELECT id FROM workspaces WHERE id=?",
  )
    .bind(workspaceId)
    .first();
  if (workspace) {
    const members = await env.DIRECTORY.prepare(
      "SELECT user_id,role FROM memberships WHERE workspace_id=?",
    )
      .bind(workspaceId)
      .all<{ user_id: string; role: string }>();
    if (
      members.results.length !== 1 ||
      members.results[0].user_id !== bundle.user.id ||
      members.results[0].role !== "owner"
    )
      fail(409, "Target workspace ownership does not match the imported owner");
  }
  const stateResponse = await call("status", {});
  if (!stateResponse.ok) fail(503, "Could not inspect target workspace");
  const state = (await stateResponse.json()) as Doc;
  if (state.migration && state.migration.digest !== digest)
    fail(409, "Target contains a different migration");
  if (!state.migration && !state.empty)
    fail(409, "Target workspace is not empty");
  if (state.migration?.status === "active")
    return json({
      ok: true,
      workspace_id: workspaceId,
      digest,
      status: "already_imported",
    });
  const machineDocs = bundle.documents.filter(
      (d) => d.collection === "machines",
    ),
    domainDocs = bundle.documents.filter((d) => d.collection === "domains");
  for (const machine of machineDocs) {
    const route = await env.DIRECTORY.prepare(
      "SELECT workspace_id FROM machine_routes WHERE id=?",
    )
      .bind(machine.id)
      .first<{ workspace_id: string }>();
    if (route && route.workspace_id !== workspaceId)
      fail(409, "A machine identity already belongs to another cloud");
  }
  for (const domain of domainDocs) {
    const route = await env.DIRECTORY.prepare(
      "SELECT workspace_id,domain_id FROM domain_routes WHERE hostname=? OR domain_id=?",
    )
      .bind(domain.value.hostname, domain.id)
      .all<{ workspace_id: string; domain_id: string }>();
    if (
      route.results.some(
        (r) => r.workspace_id !== workspaceId || r.domain_id !== domain.id,
      )
    )
      fail(409, "A domain already belongs to another cloud");
  }
  const staged = await call("stage", { bundle, digest });
  if (!staged.ok)
    fail(
      409,
      "Target refused the staged migration; no directory routes were changed",
    );
  const stamp = Date.now(),
    statements = [
      env.DIRECTORY.prepare(
        "INSERT INTO users (id,github_id,login,avatar_url,created_at,github_token) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET github_token=coalesce(users.github_token,excluded.github_token)",
      ).bind(
        bundle.user.id,
        bundle.user.github_id,
        bundle.user.login,
        bundle.user.avatar_url,
        stamp,
        bundle.user.github_token,
      ),
      env.DIRECTORY.prepare(
        "INSERT OR IGNORE INTO workspaces (id,name,created_at) VALUES (?,?,?)",
      ).bind(workspaceId, bundle.workspace.name, stamp),
      env.DIRECTORY.prepare(
        "INSERT OR IGNORE INTO memberships (workspace_id,user_id,role,created_at) VALUES (?,?,'owner',?)",
      ).bind(workspaceId, bundle.user.id, stamp),
    ];
  for (const d of machineDocs)
    statements.push(
      env.DIRECTORY.prepare(
        "INSERT INTO machine_routes(id,workspace_id) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET workspace_id=CASE WHEN machine_routes.workspace_id=excluded.workspace_id THEN excluded.workspace_id ELSE NULL END",
      ).bind(d.id, workspaceId),
    );
  for (const d of domainDocs)
    statements.push(
      env.DIRECTORY.prepare(
        "INSERT INTO domain_routes(hostname,workspace_id,domain_id) VALUES (?,?,?) ON CONFLICT(hostname) DO UPDATE SET domain_id=CASE WHEN domain_routes.workspace_id=excluded.workspace_id AND domain_routes.domain_id=excluded.domain_id THEN excluded.domain_id ELSE NULL END",
      ).bind(d.value.hostname, workspaceId, d.id),
    );
  for (const i of bundle.installations)
    statements.push(
      env.DIRECTORY.prepare(
        "INSERT INTO github_installations (workspace_id,installation_id,user_id,account_login,account_type,repository_selection,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,installation_id,user_id) DO NOTHING",
      ).bind(
        workspaceId,
        i.id,
        bundle.user.id,
        i.account_login,
        i.account_type,
        i.repository_selection,
        stamp,
      ),
    );
  // D1 batch is atomic. If it fails, the DO remains staged and inaccessible until an exact retry.
  await env.DIRECTORY.batch(statements);
  const activated = await call("activate", { digest });
  if (!activated.ok)
    fail(
      503,
      "Directory imported; workspace remains paused. Retry this exact bundle to activate",
    );
  return json({
    ok: true,
    workspace_id: workspaceId,
    digest,
    status: "imported",
    documents: bundle.documents.length,
    machines: machineDocs.length,
    domains: domainDocs.length,
  });
}
