#!/usr/bin/env node
/** Read-only PostgreSQL -> encrypted hosted migration bundle. Never logs source rows or secrets. */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import { openSync, closeSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function demand(value, message) {
  if (!value) throw new Error(message);
}
function legacyOpen(key, context, value) {
  const raw = Buffer.from(value, "base64");
  demand(raw.length >= 28, `Invalid legacy ciphertext for ${context}`);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "hex"),
    raw.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(raw.subarray(-16));
  try {
    return Buffer.concat([
      decipher.update(raw.subarray(12, -16)),
      decipher.final(),
    ]).toString();
  } catch {
    throw new Error(`Cannot decrypt ${context}; verify PC_SECRET_KEY`);
  }
}
function hostedSeal(key, context, value, auth = false) {
  const iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      createHash("sha256").update(key).digest(),
      iv,
    );
  cipher.setAAD(Buffer.from(context));
  const bytes = Buffer.concat([
    cipher.update(value),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return auth
    ? `v1.${iv.toString("base64url")}.${bytes.toString("base64url")}`
    : `${iv.toString("base64")}.${bytes.toString("base64")}`;
}
export function transformLegacy(source, options) {
  const {
    legacyKey,
    targetKey,
    workspaceId = randomUUID(),
    userId = randomUUID(),
    workspaceName = "Personal Cloud",
    publicUrl,
  } = options;
  demand(
    /^[a-f0-9]{64}$/i.test(legacyKey || ""),
    "PC_SECRET_KEY must contain 64 hex characters",
  );
  demand(
    typeof targetKey === "string" && targetKey.length >= 32,
    "ENCRYPTION_KEY must contain at least 32 characters",
  );
  demand(
    uuid.test(workspaceId) && uuid.test(userId),
    "Workspace and user IDs must be UUIDs",
  );
  demand(
    typeof workspaceName === "string" &&
      workspaceName.trim().length > 0 &&
      workspaceName.length <= 80,
    "Workspace name must contain 1–80 characters",
  );
  demand(
    new URL(publicUrl).protocol === "https:",
    "Target PUBLIC_URL must use HTTPS",
  );
  const rows = (name) => source[name] || [],
    at = new Date().toISOString(),
    docs = [],
    put = (collection, id, value) =>
      docs.push({ collection, id: String(id), value }),
    seal = (context, value) =>
      hostedSeal(targetKey, `${workspaceId}:${context}`, value),
    open = (context, value) => legacyOpen(legacyKey, context, value);
  const machines = rows("machines"),
    projects = rows("projects"),
    services = rows("services"),
    deployments = rows("deployments"),
    databases = rows("databases");
  for (const name of [
    "machines",
    "projects",
    "services",
    "deployments",
    "databases",
    "settings",
    "fleet_network_nodes",
  ])
    demand(Array.isArray(source[name]), `Source table ${name} is required`);
  const owner = rows("github_owner")[0] || {
    user_id: Number(options.githubOwnerId),
    login: options.githubOwnerLogin,
    avatar_url: "",
  };
  demand(
    rows("github_owner").length <= 1 &&
      Number.isSafeInteger(owner.user_id) &&
      owner.user_id > 0 &&
      typeof owner.login === "string" &&
      owner.login.length > 0,
    "A verified GitHub owner is required; link GitHub first or explicitly provide --github-owner-id and --github-owner-login",
  );
  if (options.githubOwnerId)
    demand(
      Number(options.githubOwnerId) === owner.user_id,
      "Requested owner does not match linked GitHub identity",
    );
  demand(
    !deployments.some((d) =>
      ["queued", "building", "deploying"].includes(d.status),
    ),
    "Finish or cancel active deployments before export",
  );
  demand(
    !services.some(
      (s) =>
        s.status === "deleting" ||
        s.promotion_deployment_id ||
        s.promotion_address,
    ),
    "Finish service deletion/promotion before export",
  );
  demand(
    !databases.some((d) =>
      ["pending", "deleting", "provisioning"].includes(d.status),
    ),
    "Finish database provisioning/deletion before export",
  );
  demand(
    !rows("domains").some(
      (d) => d.status === "deleting" || !d.tunnel_id || !d.dns_record_id,
    ),
    "Finish domain creation/deletion before export",
  );
  demand(
    !rows("github_deploy_requests").some((d) => d.status === "pending"),
    "Drain queued GitHub deploy requests before export",
  );
  demand(
    !rows("deployment_environment").length,
    "This source has deployment_environment records with an unknown encryption contract; add explicit migration support before export",
  );
  for (const command of rows("fleet_commands").filter((c) => !c.completed_at)) {
    const request = JSON.parse(
      open(`fleet-command:${command.id}`, command.request),
    );
    demand(
      request.method === "GET",
      "Drain pending mutating fleet commands before export",
    );
  }
  const settings = new Map(rows("settings").map((s) => [s.key, s.value]));
  const network = settings.get("networking");
  demand(
    !network?.nomad_servers?.length && !network?.peers?.length,
    "Custom Nomad servers or unmanaged WireGuard peers require explicit hosted migration support",
  );
  const networkNodes = rows("fleet_network_nodes"),
    servers = networkNodes.filter((n) => n.is_server);
  demand(
    !machines.length || servers.length === 1,
    "Exactly one original fleet server must be preserved",
  );
  const runtime = settings.get("runtime");
  demand(
    !services.some((s) => s.current_deployment_id) || runtime,
    "Running services require legacy runtime settings",
  );
  if (runtime) {
    demand(
      typeof runtime.nomad_url === "string" &&
        runtime.nomad_url.startsWith("agent://"),
      "Direct Nomad URL cannot be migrated; switch the source to its enrolled agent relay first",
    );
    demand(
      servers.some((n) => `agent://${n.machine_id}` === runtime.nomad_url),
      "Runtime must point to the original fleet server",
    );
    demand(
      !runtime.nomad_token,
      "Nomad ACL-token installations require explicit hosted relay support",
    );
  }
  for (const machine of machines) {
    demand(
      uuid.test(machine.id) && /^[a-f0-9]{64}$/.test(machine.credential_hash),
      "Invalid source machine identity",
    );
    put("machines", machine.id, machine);
  }
  for (const n of networkNodes) {
    demand(
      machines.some((m) => m.id === n.machine_id) &&
        Number.isInteger(n.address_slot) &&
        n.address_slot >= 2 &&
        n.address_slot <= 65534,
      "Invalid source fleet address ownership",
    );
    put("network_nodes", n.machine_id, {
      id: n.machine_id,
      machine_id: n.machine_id,
      slot: n.address_slot,
      private_ip: `10.77.${n.address_slot >> 8}.${n.address_slot % 256}`,
      is_server: n.is_server,
      public_key: n.public_key,
      endpoint: n.endpoint,
    });
  }
  for (const p of projects) put("projects", p.id, p);
  for (const s of services) {
    demand(
      projects.some((p) => p.id === s.project_id),
      "Service references missing project",
    );
    demand(
      !s.current_deployment_id ||
        deployments.some(
          (d) =>
            d.id === s.current_deployment_id &&
            d.service_id === s.id &&
            d.job_id &&
            d.image_digest,
        ),
      "Current deployment lacks its preserved Nomad job or immutable image",
    );
    put("services", s.id, s);
  }
  const environment = new Map();
  for (const row of rows("environment_variables")) {
    demand(
      projects.some((p) => p.id === row.project_id),
      "Environment references missing project",
    );
    const value = open(`env:${row.project_id}:${row.key}`, row.value_encrypted);
    environment.set(`${row.project_id}:${row.key}`, value);
    put("environment", `${row.project_id}:${row.key}`, {
      ...row,
      id: `${row.project_id}:${row.key}`,
      value_encrypted: seal(`env:${row.project_id}:${row.key}`, value),
    });
  }
  const dbUris = new Map();
  for (const db of databases) {
    demand(
      projects.some((p) => p.id === db.project_id) &&
        machines.some((m) => m.id === db.machine_id),
      "Database references missing project or volume owner",
    );
    demand(
      db.nomad_node_id &&
        db.volume_name &&
        db.job_id &&
        db.connection_encrypted,
      "Database lacks explicit persistent-volume/job/credential ownership",
    );
    const uri = open(`database:${db.id}`, db.connection_encrypted);
    dbUris.set(db.id, uri);
    put("databases", db.id, {
      ...db,
      engine: "postgresql",
      version: "17",
      phase: db.status === "failed" ? "failed" : "ready",
      connection_encrypted: seal(`database:${db.id}`, uri),
      imported_from: "self-hosted",
      imported_at: at,
    });
  }
  for (const row of rows("retained_database_volumes")) {
    demand(
      uuid.test(row.database_id) &&
        uuid.test(row.machine_id) &&
        typeof row.nomad_node_id === "string" &&
        row.nomad_node_id.length > 0 &&
        typeof row.volume_name === "string" &&
        row.volume_name.length > 0,
      "Retained volume lacks recorded original machine/node/volume identity",
    );
    put("retained_volumes", row.database_id, {
      ...row,
      id: row.database_id,
      status: "retained",
      deleted_at: row.retained_at,
      owner_inventory_status: machines.some((m) => m.id === row.machine_id)
        ? "present"
        : "missing",
      recovery_requires_original_machine: true,
      connection_encrypted: seal(
        `database:${row.database_id}`,
        open(`database:${row.database_id}`, row.connection_encrypted),
      ),
    });
  }
  for (const b of rows("service_database_bindings")) {
    demand(
      services.some((s) => s.id === b.service_id) && dbUris.has(b.database_id),
      "Database binding references missing workload",
    );
    put("bindings", b.service_id, b);
  }
  for (const d of deployments) {
    demand(
      services.some((s) => s.id === d.service_id),
      "Deployment references missing service",
    );
    demand(
      ["healthy", "failed", "rolled_back"].includes(d.status),
      "Unsupported legacy deployment status",
    );
    const service = services.find((s) => s.id === d.service_id),
      secrets = {};
    for (const [key, value] of environment)
      if (key.startsWith(`${service.project_id}:`))
        secrets[key.slice(service.project_id.length + 1)] = value;
    const binding = rows("service_database_bindings").find(
      (b) => b.service_id === service.id,
    );
    if (binding) secrets.DATABASE_URL = dbUris.get(binding.database_id);
    put("deployments", d.id, {
      ...d,
      phase: "done",
      imported_from: "self-hosted",
      imported_at: at,
      steps: rows("deployment_steps").filter((s) => s.deployment_id === d.id),
      secrets_encrypted: seal(
        `deployment:${d.id}:secrets`,
        JSON.stringify(secrets),
      ),
      service_snapshot: service,
      project_snapshot: projects.find((p) => p.id === service.project_id),
    });
  }
  for (const domain of rows("domains")) {
    demand(
      services.some((s) => s.id === domain.service_id) &&
        domain.account_id &&
        domain.zone_id,
      "Domain lacks existing account/zone/service ownership",
    );
    put("domains", domain.id, {
      ...domain,
      dns_id: domain.dns_record_id,
      legacy: true,
      imported_from: "self-hosted",
    });
  }
  for (const event of rows("events"))
    put("events", String(event.id), { ...event, id: String(event.id) });
  for (const s of rows("settings")) {
    if (s.key === "runtime" || s.key === "networking") continue;
    put("legacy_settings", s.key, {
      id: s.key,
      encrypted: seal(`legacy-setting:${s.key}`, JSON.stringify(s.value)),
    });
  }
  let legacyRuntime;
  if (runtime) {
    legacyRuntime = { ...runtime };
    if (runtime.registry_password)
      legacyRuntime.registry_password = open(
        "runtime:registry",
        runtime.registry_password,
      );
    put("settings", "legacy-runtime", {
      encrypted: seal("legacy-runtime", JSON.stringify(legacyRuntime)),
    });
    put("settings", "runtime", {
      nomad_url: runtime.nomad_url,
      registry_url: new URL(publicUrl).origin,
      buildkit_address: runtime.buildkit_address || "tcp://127.0.0.1:1234",
      builder_image:
        runtime.builder_image || "ghcr.io/nooesc/personal-cloud-builder:v0.2.0",
      allow_insecure_registry: false,
      require_cloudflare: true,
    });
  }
  const secrets = new Map();
  for (const row of rows("integration_secrets")) {
    const value = open(`integration:${row.key}`, row.ciphertext);
    secrets.set(row.key, value);
    put("legacy_integrations", row.key, {
      id: row.key,
      encrypted: seal(`legacy-integration:${row.key}`, value),
    });
  }
  const cf = rows("integrations").find(
    (i) => i.provider === "cloudflare",
  )?.metadata;
  if (secrets.has("cloudflare.token")) {
    demand(
      cf?.account_id && cf?.zone_id,
      "Legacy Cloudflare token lacks its account/zone metadata",
    );
    put("settings", "legacy-cloudflare", {
      encrypted: seal(
        "legacy-cloudflare",
        JSON.stringify({
          token: secrets.get("cloudflare.token"),
          account_id: cf.account_id,
          zone_id: cf.zone_id,
          zone_name: cf.zone_name,
        }),
      ),
    });
  }
  demand(
    !rows("domains").length || secrets.has("cloudflare.token"),
    "Existing domains require their legacy Cloudflare token for continued management",
  );
  const app = secrets.has("github.app")
      ? JSON.parse(secrets.get("github.app"))
      : null,
    userTokens = secrets.has("github.user")
      ? JSON.parse(secrets.get("github.user"))
      : null;
  if (userTokens?.expires_at) userTokens.expires_at *= 1000;
  for (const d of deployments.filter((d) => d.image_digest)) {
    demand(
      legacyRuntime?.registry_url &&
        d.image_digest.startsWith(
          new URL(legacyRuntime.registry_url).host + "/",
        ),
      "A legacy immutable image belongs to a different registry; preserve or migrate that registry explicitly before export",
    );
  }
  const requirements = [];
  if (rows("domains").length) requirements.push("legacy-domain-tunnels");
  if (deployments.some((d) => d.image_digest)) {
    demand(
      legacyRuntime?.registry_url,
      "Immutable images require their original registry connection",
    );
    requirements.push("legacy-registry-pull");
  }
  const bundle = {
    format: "personal-cloud-hosted-v1",
    created_at: at,
    workspace: { id: workspaceId, name: workspaceName.trim() },
    user: {
      id: userId,
      github_id: owner.user_id,
      login: owner.login,
      avatar_url: owner.avatar_url || "",
      github_token: userTokens
        ? hostedSeal(
            targetKey,
            `github-user:${userId}`,
            JSON.stringify(userTokens),
            true,
          )
        : null,
    },
    github_app: app ? { id: app.id, client_id: app.client_id } : null,
    installations: rows("github_installations"),
    requirements,
    documents: docs,
    verification: seal("migration-verification", "personal-cloud-hosted-v1"),
    source_counts: Object.fromEntries(
      Object.entries(source).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.length : 0,
      ]),
    ),
    not_migrated: [
      "owner browser sessions",
      "OAuth flows",
      "unused enrollment tokens",
      "historical fleet command results",
      "machine metric samples",
      "legacy webhook receipt deduplication",
    ],
  };
  demand(
    docs.length <= 10000,
    "Export exceeds 10,000 documents; split migration support is required",
  );
  return bundle;
}
const tables = [
  "machines",
  "projects",
  "services",
  "deployments",
  "deployment_steps",
  "databases",
  "retained_database_volumes",
  "domains",
  "events",
  "settings",
  "environment_variables",
  "service_database_bindings",
  "fleet_network_nodes",
  "fleet_commands",
  "github_owner",
  "github_installations",
  "integrations",
  "integration_secrets",
  "github_deploy_requests",
  "deployment_environment",
];
function readSource(options) {
  const viaDocker = options["docker-container"];
  demand(
    Boolean(viaDocker) !== Boolean(options["database-url"]),
    "Choose exactly one --database-url or --docker-container",
  );
  let command = "psql",
    args = ["-X", "-q", "-A", "-t", "--set", "ON_ERROR_STOP=1"],
    env = { ...process.env };
  if (viaDocker) {
    command = "docker";
    args = [
      "exec",
      "-i",
      viaDocker,
      "psql",
      "-U",
      options["database-user"] || "personal_cloud",
      "-d",
      options["database-name"] || "personal_cloud",
      ...args,
    ];
  } else {
    const url = new URL(options["database-url"]);
    demand(
      ["postgres:", "postgresql:"].includes(url.protocol),
      "Invalid PostgreSQL URL",
    );
    env = {
      ...env,
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: url.pathname.slice(1),
    };
    if (url.searchParams.has("sslmode"))
      env.PGSSLMODE = url.searchParams.get("sslmode");
  }
  function query(sql) {
    const result = spawnSync(command, args, {
      input: sql,
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0)
      throw new Error(
        "Read-only PostgreSQL export failed; verify connection, psql availability, and source schema (provider output suppressed to protect secrets)",
      );
    return JSON.parse(result.stdout.trim());
  }
  const available = query(
    "SELECT coalesce(json_agg(tablename),'[]') FROM pg_tables WHERE schemaname='public';",
  );
  const selected = tables.filter((t) => available.includes(t));
  const members = selected.flatMap((t) => [
    `'${t}'`,
    `(SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) FROM ${t} r)`,
  ]);
  return query(
    `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT jsonb_build_object(${members.join(",")}); COMMIT;`,
  );
}
function main() {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i];
    demand(
      flag.startsWith("--") && process.argv[i + 1],
      `Expected --option value for ${flag}`,
    );
    options[flag.slice(2)] = process.argv[i + 1];
  }
  demand(options.output, "--output is required (a new private file)");
  const bundle = transformLegacy(readSource(options), {
    legacyKey: process.env.PC_SECRET_KEY,
    targetKey: process.env.ENCRYPTION_KEY,
    workspaceId: options["workspace-id"],
    userId: options["user-id"],
    workspaceName: options["workspace-name"],
    publicUrl: options["public-url"] || process.env.PUBLIC_URL,
    githubOwnerId: options["github-owner-id"],
    githubOwnerLogin: options["github-owner-login"],
  });
  const serialized = JSON.stringify(bundle);
  demand(
    Buffer.byteLength(serialized) <= 16 * 1024 * 1024,
    "Encrypted bundle exceeds 16 MiB import limit",
  );
  const filename = resolve(options.output),
    fd = openSync(filename, "wx", 0o600);
  try {
    writeFileSync(fd, serialized + "\n");
  } finally {
    closeSync(fd);
  }
  console.log(
    `Encrypted migration bundle written: ${filename}\nDocuments: ${bundle.documents.length}. Required compatibility: ${bundle.requirements.join(", ") || "none"}. No source or hosted data was changed.`,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(`Migration export refused: ${error.message}`);
    process.exitCode = 1;
  }
}
