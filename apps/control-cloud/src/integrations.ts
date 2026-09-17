import {
  body,
  fail,
  id,
  json,
  NomadPending,
  now,
  requireUser,
  text,
  type Doc,
  type WorkspaceContext,
} from "./core";
import { sha256, token } from "./crypto";
export async function registryCredentials(
  ctx: WorkspaceContext,
): Promise<{
  registry_url: string;
  registry_username: string;
  registry_password: string;
  repository_prefix: string;
}> {
  let stored = ctx.store.get("settings", "registry-credential");
  if (!stored) {
    const secret = token(),
      candidate = {
        hash: await sha256(secret),
        encrypted: await ctx.seal("registry-password", secret),
      };
    stored = ctx.store.get("settings", "registry-credential") ?? candidate;
    ctx.store.put("settings", "registry-credential", stored);
  }
  return {
    registry_url: new URL(ctx.env.PUBLIC_URL).origin,
    registry_username: ctx.workspaceId,
    registry_password: await ctx.open("registry-password", stored.encrypted),
    repository_prefix: `personal-cloud/${ctx.workspaceId}`,
  };
}
export async function integrationStatus(ctx: WorkspaceContext): Promise<Doc> {
  const install = await ctx.env.DIRECTORY.prepare(
    "SELECT 1 FROM github_installations WHERE workspace_id=? LIMIT 1",
  )
    .bind(ctx.workspaceId)
    .first();
  return {
    github: {
      status: install ? "connected" : "not_connected",
      mode: "github_app",
    },
    cloudflare: {
      status:
        ctx.env.CF_API_TOKEN && ctx.env.CF_ACCOUNT_ID && ctx.env.CF_ZONE_ID
          ? "connected"
          : "not_connected",
      mode: "managed",
      zone_name: ctx.env.CF_ZONE_NAME ?? null,
      bucket: "managed",
    },
  };
}
async function cloudflare(
  ctx: WorkspaceContext,
  method: string,
  path: string,
  value?: unknown,
  allowMissing = false,
): Promise<Doc> {
  if (!ctx.env.CF_API_TOKEN || !ctx.env.CF_ACCOUNT_ID || !ctx.env.CF_ZONE_ID)
    fail(503, "Platform domain hosting has not been configured");
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: value === undefined ? undefined : JSON.stringify(value),
    signal: AbortSignal.timeout(25000),
  });
  if (response.status === 404 && allowMissing) return { _missing: true };
  if (response.status === 404 && method === "DELETE") return {};
  if (!response.ok) fail(502, `Cloudflare returned HTTP ${response.status}`);
  const result = (await response.json()) as Doc;
  if (result.success === false) fail(502, "Cloudflare rejected the operation");
  return result.result;
}
async function ensureTunnel(ctx: WorkspaceContext): Promise<Doc> {
  let tunnel = ctx.store.get("settings", "tunnel");
  if (tunnel) return tunnel;
  const name = `pc-${ctx.workspaceId}`;
  const matches = await cloudflare(
    ctx,
    "GET",
    `/accounts/${ctx.env.CF_ACCOUNT_ID}/cfd_tunnel?name=${name}&is_deleted=false`,
  );
  const found = Array.isArray(matches)
    ? matches.find((t) => t.name === name)
    : null;
  const value =
    found ??
    (await cloudflare(
      ctx,
      "POST",
      `/accounts/${ctx.env.CF_ACCOUNT_ID}/cfd_tunnel`,
      { name, config_src: "cloudflare" },
    ));
  const secret = await cloudflare(
    ctx,
    "GET",
    `/accounts/${ctx.env.CF_ACCOUNT_ID}/cfd_tunnel/${value.id}/token`,
  );
  tunnel = {
    id: value.id,
    name,
    token: await ctx.seal(`tunnel:${value.id}`, String(secret)),
    version: 0,
  };
  ctx.store.put("settings", "tunnel", tunnel);
  return tunnel;
}
async function configureTunnel(ctx: WorkspaceContext): Promise<Doc> {
  const tunnel = await ensureTunnel(ctx),
    domains = ctx.store
      .list("domains")
      .filter((d) => !d.legacy && d.status !== "deleting");
  const ingress = domains.map((domain) => {
    const service = ctx.store.get("services", domain.service_id);
    const address = service?.promotion_address ?? service?.address;
    if (!address || !/^http:\/\/10\.77\.\d{1,3}\.\d{1,3}:\d+$/.test(address))
      fail(409, "Deploy the service before exposing it");
    return { hostname: domain.hostname, service: address };
  });
  const signature = await sha256(JSON.stringify(ingress));
  if (tunnel.config_hash !== signature) {
    const updated = await cloudflare(
      ctx,
      "PUT",
      `/accounts/${ctx.env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnel.id}/configurations`,
      { config: { ingress: [...ingress, { service: "http_status:404" }] } },
    );
    if (!Number.isSafeInteger(updated.version) || updated.version < 0)
      fail(502, "Cloudflare omitted the tunnel configuration version");
    tunnel.version = updated.version;
    tunnel.config_hash = signature;
    ctx.store.put("settings", "tunnel", tunnel);
  }
  await ensureConnector(ctx, tunnel.id, () =>
    ctx.open(`tunnel:${tunnel.id}`, tunnel.token),
  );
  return tunnel;
}
async function ensureConnector(
  ctx: WorkspaceContext,
  tunnelId: string,
  getToken: () => Promise<string>,
): Promise<void> {
  const jobId = `pc-tunnel-${tunnelId}`;
  let existing: Doc | undefined;
  try {
    existing = await ctx.requestNomad("GET", `/v1/job/${jobId}`);
  } catch (error) {
    if (!(error instanceof Error && "status" in error && error.status === 404))
      throw error;
  }
  // Preserve imported live jobs, their placement and their current credentials.
  if (existing && !existing.Stop) return;
  const secret = await getToken();
  const job = {
    Job: {
      ID: jobId,
      Name: jobId,
      Type: "service",
      Datacenters: ["dc1"],
      Constraints: [
        { LTarget: "${meta.pc_compute}", Operand: "=", RTarget: "true" },
      ],
      TaskGroups: [
        {
          Name: "tunnel",
          Count: 1,
          Networks: [{ Mode: "host" }],
          Tasks: [
            {
              Name: "cloudflared",
              Driver: "docker",
              Config: {
                image: "cloudflare/cloudflared:2026.9.1",
                network_mode: "host",
                args: ["tunnel", "--no-autoupdate", "run"],
              },
              Env: { TUNNEL_TOKEN: secret },
              Resources: { CPU: 100, MemoryMB: 128 },
            },
          ],
        },
      ],
    },
  };
  await ctx.requestNomad("POST", "/v1/jobs", job);
}
type ConnectorAck = { connector?: string; version?: number };
export function parseConnectorAcknowledgement(
  raw: string,
  startedAt: string,
  saved: ConnectorAck = {},
): ConnectorAck {
  const start = Date.parse(startedAt),
    result = { ...saved };
  if (!Number.isFinite(start)) return {};
  for (const line of raw.split("\n")) {
    const timestamp = Date.parse(line.split(/\s+/)[0]);
    if (
      !Number.isFinite(timestamp) ||
      timestamp < Math.floor(start / 1000) * 1000
    )
      continue;
    const connector = line
      .match(/ INF Generated Connector ID: ([a-f0-9-]{36})\s*$/i)?.[1]
      ?.toLowerCase();
    if (connector) {
      if (result.connector !== connector) delete result.version;
      result.connector = connector;
      continue;
    }
    const version = line.includes(" INF Updated to new configuration config=")
      ? line.match(/ version=(\d+)\s*$/)?.[1]
      : undefined;
    if (result.connector && version !== undefined) {
      const parsed = Number(version);
      if (Number.isSafeInteger(parsed)) result.version = parsed;
    }
  }
  return result;
}
export function connectorsAcknowledged(
  connections: Doc[],
  version: number,
  observed: Map<string, number> = new Map(),
): boolean {
  const active = connections.filter(
    (c) =>
      Array.isArray(c.conns) &&
      c.conns.length > 0 &&
      c.is_pending_reconnect !== true,
  );
  return (
    active.length > 0 &&
    active.every((c) => {
      // Never override a stale version explicitly reported by the provider.
      const current =
        c.config_version === undefined || c.config_version === null
          ? observed.get(String(c.id).toLowerCase())
          : Number(c.config_version);
      return (
        typeof current === "number" &&
        Number.isFinite(current) &&
        current >= version
      );
    })
  );
}
async function tunnelReady(
  ctx: WorkspaceContext,
  tunnel: Doc,
): Promise<boolean> {
  const connections = await cloudflare(
    ctx,
    "GET",
    `/accounts/${ctx.env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnel.id}/connections`,
  );
  if (
    !Array.isArray(connections) ||
    !connections.length ||
    !Number.isSafeInteger(tunnel.version) ||
    tunnel.version < 0
  )
    return false;
  if (connectorsAcknowledged(connections, tunnel.version)) return true;
  const allocations = await ctx.requestNomad(
      "GET",
      `/v1/job/pc-tunnel-${tunnel.id}/allocations`,
    ),
    observed = new Map<string, number>();
  for (const allocation of Array.isArray(allocations) ? allocations : []) {
    const task = allocation.TaskStates?.cloudflared;
    if (
      allocation.ClientStatus !== "running" ||
      allocation.DesiredStatus !== "run" ||
      task?.State !== "running" ||
      !Number.isFinite(Date.parse(task.StartedAt))
    )
      continue;
    const key = `tunnel-ack:${tunnel.id}:${allocation.ID}`,
      stored = ctx.store.get("settings", key);
    const saved =
      stored?.started_at === task.StartedAt &&
      stored?.restarts === task.Restarts
        ? (stored ?? {})
        : {};
    let ack: ConnectorAck = {
      connector: saved.connector,
      version: saved.version,
    };
    const machine = ctx.store
      .list("machines")
      .find((m) => m.report.nomad_node_id === allocation.NodeID);
    if (machine) {
      try {
        const log = await ctx.requestNomad(
          "GET",
          `/v1/client/fs/logs/${allocation.ID}?task=cloudflared&type=stderr&origin=end&offset=65536&plain=true`,
          undefined,
          machine.id,
        );
        ack = parseConnectorAcknowledgement(
          typeof log.raw === "string" ? log.raw : JSON.stringify(log),
          task.StartedAt,
          ack,
        );
      } catch (error) {
        if (error instanceof NomadPending) throw error;
      }
    }
    if (ack.connector && ack.version !== undefined) {
      ctx.store.put("settings", key, {
        ...ack,
        started_at: task.StartedAt,
        restarts: task.Restarts,
      });
      observed.set(ack.connector, ack.version);
    }
  }
  return connectorsAcknowledged(connections, tunnel.version, observed);
}
async function legacyContext(
  ctx: WorkspaceContext,
  domain: Doc,
): Promise<WorkspaceContext> {
  const stored = ctx.store.get("settings", "legacy-cloudflare");
  if (!stored?.encrypted)
    fail(503, "Imported Cloudflare credentials are unavailable");
  const credentials = JSON.parse(
    await ctx.open("legacy-cloudflare", stored.encrypted),
  );
  if (
    !credentials.token ||
    domain.account_id !== credentials.account_id ||
    domain.zone_id !== credentials.zone_id
  )
    fail(409, "Imported domain does not match its Cloudflare account and zone");
  return {
    ...ctx,
    env: {
      ...ctx.env,
      CF_API_TOKEN: credentials.token,
      CF_ACCOUNT_ID: domain.account_id,
      CF_ZONE_ID: domain.zone_id,
      CF_ZONE_NAME: credentials.zone_name,
    },
  };
}
export function replaceLegacyIngress(
  configuration: Doc,
  hostname: string,
  address: string,
): Doc {
  if (!Array.isArray(configuration.ingress))
    fail(409, "Imported tunnel has no ingress configuration");
  let matched = false;
  const ingress = configuration.ingress.map((rule: Doc) => {
    if (rule.hostname !== hostname) return rule;
    matched = true;
    return { ...rule, service: address };
  });
  if (!matched)
    fail(
      409,
      "Imported tunnel hostname changed; refusing to replace its configuration",
    );
  return { ...configuration, ingress };
}
async function configureLegacyTunnel(
  ctx: WorkspaceContext,
  domain: Doc,
): Promise<{ ctx: WorkspaceContext; tunnel: Doc }> {
  const legacy = await legacyContext(ctx, domain),
    service = ctx.store.get("services", domain.service_id),
    address = service?.promotion_address ?? service?.address;
  if (
    !domain.tunnel_id ||
    !address ||
    !/^http:\/\/10\.77\.\d{1,3}\.\d{1,3}:\d+$/.test(address)
  )
    fail(409, "Imported service has no private deployment address");
  const base = `/accounts/${legacy.env.CF_ACCOUNT_ID}/cfd_tunnel/${domain.tunnel_id}`;
  const current = await cloudflare(legacy, "GET", `${base}/configurations`),
    config = replaceLegacyIngress(current.config, domain.hostname, address);
  let version = current.version;
  if (JSON.stringify(config) !== JSON.stringify(current.config)) {
    const changed = await cloudflare(legacy, "PUT", `${base}/configurations`, {
      config,
    });
    version = changed.version;
  }
  if (!Number.isSafeInteger(version) || version < 0)
    fail(502, "Cloudflare omitted the tunnel configuration version");
  const saved = ctx.store.get("domains", domain.id);
  if (!saved || saved.status === "deleting")
    throw new NomadPending("Domain is being removed");
  ctx.store.put("domains", domain.id, {
    ...saved,
    upstream: address,
    configuration_version: version,
    configuration_applied: false,
    updated_at: now(),
  });
  await ensureConnector(legacy, domain.tunnel_id, async () =>
    String(await cloudflare(legacy, "GET", `${base}/token`)),
  );
  return { ctx: legacy, tunnel: { id: domain.tunnel_id, version } };
}
export async function refreshServiceDomains(
  ctx: WorkspaceContext,
  serviceId: string,
): Promise<void> {
  const domains = ctx.store
    .list("domains")
    .filter((d) => d.service_id === serviceId && d.status !== "deleting");
  if (!domains.length) return;
  if (domains.some((d) => !d.legacy)) {
    const tunnel = await configureTunnel(ctx);
    if (!(await tunnelReady(ctx, tunnel)))
      throw new NomadPending(
        "Waiting for public tunnel configuration acknowledgement",
      );
  }
  for (const domain of domains.filter((d) => d.legacy)) {
    const configured = await configureLegacyTunnel(ctx, domain);
    if (!(await tunnelReady(configured.ctx, configured.tunnel)))
      throw new NomadPending(
        "Waiting for imported tunnel configuration acknowledgement",
      );
    const current = ctx.store.get("domains", domain.id);
    if (current)
      ctx.store.put("domains", domain.id, {
        ...current,
        configuration_applied: true,
      });
  }
}
async function deleteLegacyDomain(
  ctx: WorkspaceContext,
  domain: Doc,
): Promise<void> {
  const legacy = await legacyContext(ctx, domain),
    jobId = `pc-tunnel-${domain.tunnel_id}`;
  if (!domain.connector_stopped) {
    const resource = await cloudflare(
      legacy,
      "GET",
      `/accounts/${domain.account_id}/cfd_tunnel/${domain.tunnel_id}`,
      undefined,
      true,
    );
    if (!resource._missing) {
      if (resource.name !== `personal-cloud-${domain.id}`)
        fail(409, "Imported tunnel ownership changed; refusing deletion");
      const configuration = await cloudflare(
        legacy,
        "GET",
        `/accounts/${domain.account_id}/cfd_tunnel/${domain.tunnel_id}/configurations`,
      );
      if (
        !Array.isArray(configuration.config?.ingress) ||
        configuration.config.ingress.some(
          (rule: Doc) => rule.hostname && rule.hostname !== domain.hostname,
        )
      )
        fail(409, "Imported tunnel has other routes; refusing deletion");
    }
    try {
      await ctx.requestNomad("DELETE", `/v1/job/${jobId}`);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "status" in error &&
        error.status === 404
      ))
        throw error;
    }
    let allocations: Doc = [];
    try {
      allocations = await ctx.requestNomad(
        "GET",
        `/v1/job/${jobId}/allocations`,
      );
    } catch (error) {
      if (!(
        error instanceof Error &&
        "status" in error &&
        error.status === 404
      ))
        throw error;
    }
    if (
      Array.isArray(allocations) &&
      allocations.some((a) => !["complete", "failed"].includes(a.ClientStatus))
    )
      throw new NomadPending("Waiting for imported tunnel connector to stop");
    domain = { ...domain, connector_stopped: true };
    ctx.store.put("domains", domain.id, domain);
  }
  const dnsId = domain.dns_record_id ?? domain.dns_id;
  if (dnsId && !domain.dns_deleted) {
    const dnsPath = `/zones/${domain.zone_id}/dns_records/${dnsId}`,
      record = await cloudflare(legacy, "GET", dnsPath, undefined, true);
    if (!record._missing) {
      if (
        record.name !== domain.hostname ||
        record.comment !== `personal-cloud:${domain.id}` ||
        record.type !== "CNAME" ||
        record.content !== `${domain.tunnel_id}.cfargotunnel.com`
      )
        fail(409, "Imported DNS ownership changed; refusing deletion");
      await cloudflare(legacy, "DELETE", dnsPath);
    }
    domain = { ...domain, dns_deleted: true };
    ctx.store.put("domains", domain.id, domain);
  }
  if (domain.tunnel_id && !domain.tunnel_deleted) {
    await cloudflare(
      legacy,
      "DELETE",
      `/accounts/${domain.account_id}/cfd_tunnel/${domain.tunnel_id}`,
    );
    domain = { ...domain, tunnel_deleted: true };
    ctx.store.put("domains", domain.id, domain);
  }
  await ctx.env.DIRECTORY.prepare(
    "DELETE FROM domain_routes WHERE hostname=? AND workspace_id=?",
  )
    .bind(domain.hostname, ctx.workspaceId)
    .run();
  ctx.store.delete("domains", domain.id);
  ctx.broadcast();
}
async function reconcileDomain(
  ctx: WorkspaceContext,
  domain: Doc,
): Promise<void> {
  try {
    if (domain.status === "deleting") {
      if (domain.legacy) {
        await deleteLegacyDomain(ctx, domain);
        return;
      }
      await configureTunnel(ctx);
      if (domain.dns_id && !domain.dns_deleted) {
        await cloudflare(
          ctx,
          "DELETE",
          `/zones/${ctx.env.CF_ZONE_ID}/dns_records/${domain.dns_id}`,
        );
        domain = { ...domain, dns_deleted: true };
        ctx.store.put("domains", domain.id, domain);
      }
      await ctx.env.DIRECTORY.prepare(
        "DELETE FROM domain_routes WHERE hostname=? AND workspace_id=?",
      )
        .bind(domain.hostname, ctx.workspaceId)
        .run();
      ctx.store.delete("domains", domain.id);
      ctx.broadcast();
      return;
    }
    const configured = domain.legacy
      ? await configureLegacyTunnel(ctx, domain)
      : { ctx, tunnel: await configureTunnel(ctx) };
    const tunnel = configured.tunnel;
    if (!domain.legacy && !domain.dns_id) {
      const records = await cloudflare(
        ctx,
        "GET",
        `/zones/${ctx.env.CF_ZONE_ID}/dns_records?name=${encodeURIComponent(domain.hostname)}`,
      );
      let existing = Array.isArray(records)
        ? records.find((r) => r.name === domain.hostname)
        : null;
      if (existing && existing.content !== `${tunnel.id}.cfargotunnel.com`)
        fail(409, "Hostname already points to another application");
      existing ??= await cloudflare(
        ctx,
        "POST",
        `/zones/${ctx.env.CF_ZONE_ID}/dns_records`,
        {
          type: "CNAME",
          name: domain.hostname,
          content: `${tunnel.id}.cfargotunnel.com`,
          proxied: true,
          ttl: 1,
        },
      );
      domain = {
        ...domain,
        dns_id: existing.id,
        tunnel_id: tunnel.id,
        status: "pending",
        updated_at: now(),
      };
      ctx.store.put("domains", domain.id, domain);
    }
    if (!(await tunnelReady(configured.ctx, tunnel)))
      throw new NomadPending("Waiting for public tunnel");
    const service = ctx.store.get("services", domain.service_id)!;
    const probe = await fetch(
      `https://${domain.hostname}${service.health_path || "/"}`,
      { redirect: "manual", signal: AbortSignal.timeout(10000) },
    );
    if (!probe.ok)
      throw new NomadPending(
        `Public health check returned HTTP ${probe.status}`,
      );
    ctx.store.put("domains", domain.id, {
      ...(ctx.store.get<Doc>("domains", domain.id) ?? domain),
      configuration_applied: true,
      status: "healthy",
      error: null,
      updated_at: now(),
    });
    ctx.broadcast();
  } catch (error) {
    console.warn("Domain reconciliation pending", domain.id, error instanceof Error ? error.message : "Unknown error");
    ctx.store.put("domains", domain.id, {
      ...(ctx.store.get<Doc>("domains", domain.id) ?? domain),
      status: domain.status === "deleting" ? "deleting" : "pending",
      error:
        error instanceof Error ? error.message : "Domain reconciliation failed",
      updated_at: now(),
    });
    await ctx.schedule(15000);
  }
}
export async function reconcileDomains(ctx: WorkspaceContext): Promise<void> {
  for (const domain of ctx.store
    .list("domains")
    .filter((d) => d.status !== "healthy"))
    await reconcileDomain(ctx, domain);
}
export async function handleIntegrations(
  request: Request,
  ctx: WorkspaceContext,
): Promise<Response | null> {
  requireUser(ctx);
  const path = new URL(request.url).pathname;
  if (path === "/api/registry/credentials" && request.method === "POST")
    return json(await registryCredentials(ctx));
  if (path === "/api/integrations" && request.method === "GET")
    return json(await integrationStatus(ctx));
  if (
    path.startsWith("/api/integrations/cloudflare") ||
    path === "/api/integrations/github"
  )
    return json(
      {
        error:
          "Connections are managed by the hosted platform. Use GitHub repository access in Settings.",
      },
      409,
    );
  if (path === "/api/domains" && request.method === "POST") {
    const input = await body(request),
      service = ctx.store.get("services", text(input.service_id, 36));
    if (!service) fail(404, "Service not found");
    const hostname = text(input.hostname, 253).toLowerCase(),
      base = ctx.env.CF_ZONE_NAME;
    if (
      !base ||
      !hostname.endsWith(`.${base}`) ||
      !/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)
    )
      fail(400, "Choose an application hostname under the platform domain");
    // Reserve names globally; a workspace cannot capture another customer's hostname.
    const domain = {
      id: id(),
      service_id: service.id,
      hostname,
      status: "pending",
      created_at: now(),
    };
    try {
      await ctx.env.DIRECTORY.prepare(
        "INSERT INTO domain_routes(hostname,workspace_id,domain_id) VALUES(?,?,?)",
      )
        .bind(hostname, ctx.workspaceId, domain.id)
        .run();
    } catch {
      fail(409, "Hostname already in use");
    }
    ctx.store.put("domains", domain.id, domain);
    await ctx.schedule();
    ctx.broadcast();
    return json(domain, 202);
  }
  const match = path.match(/^\/api\/domains\/([^/]+)$/);
  if (match && request.method === "DELETE") {
    const domain = ctx.store.get("domains", match[1]);
    if (!domain) fail(404, "Domain not found");
    ctx.store.put("domains", domain.id, { ...domain, status: "deleting" });
    await ctx.schedule();
    return json({ ok: true, status: "deleting" }, 202);
  }
  return null;
}
