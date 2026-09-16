import {
  body,
  fail,
  id,
  json,
  now,
  requireUser,
  text,
  type Doc,
  type WorkspaceContext,
} from "./core";
import { equal, sha256, token } from "./crypto";
export function validateReport(report: unknown): Doc {
  if (!report || typeof report !== "object" || Array.isArray(report))
    fail(400, "Invalid machine report");
  const r = report as Doc;
  for (const key of ["hostname", "os", "architecture"]) text(r[key], 256);
  if (!["amd64", "arm64", "x86_64", "aarch64"].includes(r.architecture))
    fail(400, "Unsupported architecture");
  for (const key of [
    "cpu_cores",
    "cpu_percent",
    "memory_total",
    "memory_used",
    "disk_total",
    "disk_used",
  ])
    if (typeof r[key] !== "number" || !Number.isFinite(r[key]) || r[key] < 0)
      fail(400, "Invalid machine metrics");
  if (
    r.cpu_percent > 100 ||
    r.cpu_cores < 1 ||
    r.cpu_cores > 65536 ||
    r.memory_used > r.memory_total ||
    r.disk_used > r.disk_total
  )
    fail(400, "Invalid machine capacity");
  if (typeof r.docker !== "boolean" || typeof r.nomad !== "boolean")
    fail(400, "Missing runtime status");
  if (
    r.wireguard_public_key &&
    !/^[A-Za-z0-9+/]{43}=$/.test(r.wireguard_public_key)
  )
    fail(400, "Invalid WireGuard key");
  if (
    r.wireguard_endpoint &&
    !/^[a-zA-Z0-9.:[\]-]+:[0-9]{1,5}$/.test(r.wireguard_endpoint)
  )
    fail(400, "Invalid WireGuard endpoint");
  return r;
}
function metadata(input: Doc): Doc {
  if (!["home", "vps", "dedicated"].includes(input.location))
    fail(400, "Choose a location");
  if (
    !Array.isArray(input.roles) ||
    !input.roles.length ||
    input.roles.length > 3 ||
    input.roles.some(
      (r: unknown) => !["compute", "builder", "database"].includes(String(r)),
    )
  )
    fail(400, "Choose valid machine roles");
  if (
    !Array.isArray(input.tags) ||
    input.tags.length > 10 ||
    input.tags.some(
      (t: unknown) => typeof t !== "string" || !/^[a-zA-Z0-9-]{1,30}$/.test(t),
    )
  )
    fail(400, "Invalid machine tags");
  return {
    location: input.location,
    roles: [...new Set(input.roles)],
    tags: [...new Set(input.tags)],
  };
}
export function publicMachine(machine: Doc): Doc {
  const { credential_hash, ...visible } = machine;
  return {
    ...visible,
    status:
      Date.now() - Date.parse(machine.last_seen) > 45000
        ? "offline"
        : machine.report.docker && machine.report.nomad
          ? "online"
          : "degraded",
  };
}
export async function authenticateMachine(
  request: Request,
  ctx: WorkspaceContext,
  machineId: string,
) {
  const credential =
    request.headers.get("Authorization")?.replace(/^Bearer /, "") || "";
  const machine = ctx.store.get("machines", machineId);
  if (!machine || !equal(await sha256(credential), machine.credential_hash))
    fail(401, "Machine authentication required");
  ctx.machineId = machineId;
}
function networkNode(ctx: WorkspaceContext, machine: Doc): Doc {
  const previous = ctx.store.get("network_nodes", machine.id);
  const nodes = ctx.store.list("network_nodes");
  const slot =
    previous?.slot ?? Math.max(1, ...nodes.map((n) => Number(n.slot))) + 1;
  if (slot > 65534) fail(409, "Fleet network full");
  const node = {
    id: machine.id,
    machine_id: machine.id,
    slot,
    private_ip: `10.77.${slot >> 8}.${slot % 256}`,
    is_server: previous?.is_server ?? !nodes.some((n) => n.is_server),
    public_key: machine.report.wireguard_public_key,
    endpoint: machine.report.wireguard_endpoint ?? null,
  };
  if (
    nodes.some((n) => n.id !== machine.id && n.public_key === node.public_key)
  )
    fail(409, "WireGuard key already registered");
  ctx.store.put("network_nodes", node.id, node);
  return node;
}
export async function handleFleet(
  request: Request,
  ctx: WorkspaceContext,
): Promise<Response | null> {
  const path = new URL(request.url).pathname,
    method = request.method;
  if (path === "/api/enrollment-tokens" && method === "POST") {
    requireUser(ctx);
    const data = metadata(await body(request));
    if (
      ctx.store.list("machines").length >=
      Number(ctx.env.MAX_MACHINES_PER_WORKSPACE)
    )
      fail(409, "Workspace machine limit reached");
    const raw = token(),
      hash = await sha256(raw),
      expires = Date.now() + 15 * 60000,
      enrollment = {
        id: id(),
        ...data,
        token_hash: hash,
        expires_at: expires,
        used_at: null,
      };
    await ctx.env.DIRECTORY.prepare(
      "INSERT INTO enrollment_routes(token_hash,workspace_id,expires_at) VALUES(?,?,?)",
    )
      .bind(hash, ctx.workspaceId, expires)
      .run();
    ctx.store.put("enrollments", hash, enrollment);
    return json(
      {
        ...data,
        id: enrollment.id,
        token: raw,
        expires_at: new Date(expires).toISOString(),
      },
      201,
    );
  }
  if (path === "/api/agent/enroll" && method === "POST") {
    const input = await body(request),
      hash = await sha256(text(input.token, 256)),
      report = validateReport(input.report),
      credential = token(),
      credentialHash = await sha256(credential);
    const machineId = id(),
      grant = ctx.store.get("enrollments", hash);
    if (!grant || grant.used_at || grant.expires_at <= Date.now())
      fail(401, "Enrollment token expired or already used");
    // Publish routing before consuming the grant. Directory failures leave it reusable.
    await ctx.env.DIRECTORY.prepare(
      "INSERT INTO machine_routes(id,workspace_id) VALUES(?,?)",
    )
      .bind(machineId, ctx.workspaceId)
      .run();
    let machine: Doc;
    try {
      machine = ctx.store.transaction(() => {
        const current = ctx.store.get("enrollments", hash);
        if (!current || current.used_at || current.expires_at <= Date.now())
          fail(401, "Enrollment token expired or already used");
        if (
          ctx.store.list("machines").length >=
          Number(ctx.env.MAX_MACHINES_PER_WORKSPACE)
        )
          fail(409, "Workspace machine limit reached");
        const m = {
          id: machineId,
          credential_hash: credentialHash,
          location: current.location,
          roles: current.roles,
          tags: current.tags,
          report,
          last_seen: now(),
          created_at: now(),
        };
        ctx.store.put("machines", m.id, m);
        ctx.store.put("enrollments", hash, { ...current, used_at: now() });
        return m;
      });
    } catch (error) {
      await ctx.env.DIRECTORY.prepare(
        "DELETE FROM machine_routes WHERE id=? AND workspace_id=?",
      )
        .bind(machineId, ctx.workspaceId)
        .run();
      throw error;
    }
    ctx.event("machine.enrolled", `${report.hostname} joined your cloud`);
    ctx.broadcast();
    return json({ id: machine.id, credential }, 201);
  }
  const agent = path.match(
    /^\/api\/agent\/([^/]+)\/(heartbeat|config|commands(?:\/[^/]+)?|runtime-ready)$/,
  );
  if (agent) {
    const [, machineId, action] = agent;
    await authenticateMachine(request, ctx, machineId);
    const machine = ctx.store.get("machines", machineId)!;
    if (action === "heartbeat" && method === "POST") {
      const report = validateReport(await body(request));
      ctx.store.put("machines", machineId, {
        ...machine,
        report,
        last_seen: now(),
      });
      const minute = Math.floor(Date.now() / 60000) * 60000,
        sampleId = `${machineId}:${minute}`;
      if (!ctx.store.get("samples", sampleId))
        ctx.store.put("samples", sampleId, {
          id: sampleId,
          machine_id: machineId,
          sampled_at: new Date(minute).toISOString(),
          cpu_percent: report.cpu_percent,
          memory_used: report.memory_used,
          memory_total: report.memory_total,
          disk_used: report.disk_used,
          disk_total: report.disk_total,
        });
      await ctx.schedule(60000);
      ctx.broadcast();
      return json({ ok: true });
    }
    if (action === "config" && method === "GET") {
      if (!machine.report.wireguard_public_key)
        fail(409, "Run the installer with provisioning enabled");
      const node = networkNode(ctx, machine),
        nodes = ctx.store.list("network_nodes"),
        server = nodes.find((n) => n.is_server);
      const peers = nodes
        .filter((n) => n.id !== machineId && (node.is_server || n.is_server))
        .map((n) => ({
          public_key: n.public_key,
          private_ip: n.private_ip,
          allowed_ips: node.is_server ? `${n.private_ip}/32` : "10.77.0.0/16",
          endpoint: n.endpoint,
        }));
      return json({
        machine_id: machineId,
        private_ip: node.private_ip,
        prefix_length: 16,
        listen_port: 51820,
        roles: machine.roles,
        tags: machine.tags,
        location: machine.location,
        peers,
        nomad: {
          server: node.is_server,
          servers: server ? [`${server.private_ip}:4647`] : [],
        },
      });
    }
    if (action === "runtime-ready" && method === "POST") {
      const node = ctx.store.get("network_nodes", machineId);
      if (!node?.is_server)
        fail(403, "Only the fleet server initializes the runtime");
      if (!ctx.store.get("settings", "runtime"))
        ctx.store.put("settings", "runtime", {
          nomad_url: `agent://${machineId}`,
          registry_url: ctx.env.PUBLIC_URL,
          buildkit_address: "tcp://127.0.0.1:1234",
          builder_image: "ghcr.io/nooesc/personal-cloud-builder:v0.2.0",
          allow_insecure_registry: false,
          require_cloudflare: true,
        });
      ctx.broadcast();
      return json({ ok: true });
    }
    if (action === "commands" && method === "GET") {
      const commands = ctx.store.transaction(() =>
        ctx.store
          .list("commands")
          .filter(
            (c) =>
              c.machine_id === machineId &&
              (!c.claimed_at ||
                (c.method === "GET" &&
                  Date.now() - Date.parse(c.claimed_at) > 60000)) &&
              !c.completed_at &&
              c.expires_at > Date.now(),
          )
          .slice(0, 1)
          .map((c) => {
            ctx.store.put("commands", c.id, { ...c, claimed_at: now() });
            return c;
          }),
      );
      return json({
        commands: await Promise.all(
          commands.map(async (c) => ({
            id: c.id,
            request: JSON.parse(await ctx.open(`command:${c.id}`, c.request)),
          })),
        ),
      });
    }
    if (action.startsWith("commands/") && method === "POST") {
      const cid = action.split("/")[1],
        command = ctx.store.get("commands", cid),
        result = await body(request);
      if (
        !command ||
        command.machine_id !== machineId ||
        !command.claimed_at ||
        command.completed_at
      )
        fail(409, "Command expired or already completed");
      if (
        !Number.isInteger(result.status) ||
        result.status < 100 ||
        result.status > 599 ||
        typeof result.body !== "string" ||
        result.body.length > 1048576
      )
        fail(400, "Invalid command result");
      ctx.store.put("commands", cid, {
        ...command,
        result: await ctx.seal(`result:${cid}`, JSON.stringify(result)),
        completed_at: now(),
      });
      await ctx.schedule(1);
      return json({ ok: true });
    }
    fail(405, "Method not allowed");
  }
  if (path === "/api/networking" && method === "GET") {
    requireUser(ctx);
    return json({
      settings: { nomad_servers: [], peers: [] },
      subnet: "10.77.0.0/16",
      nodes: ctx.store.list("network_nodes"),
    });
  }
  const check = path.match(/^\/api\/networking\/([^/]+)\/check$/);
  if (check && method === "GET") {
    requireUser(ctx);
    if (!ctx.store.get("machines", check[1])) fail(404, "Machine not found");
    const result = await ctx.requestNomad(
      "GET",
      "/v1/agent/health",
      undefined,
      check[1],
    );
    return json({
      machine_id: check[1],
      connected: true,
      status: 200,
      health: result,
    });
  }
  const m = path.match(/^\/api\/machines\/([^/]+)$/);
  if (m) {
    requireUser(ctx);
    const machine = ctx.store.get("machines", m[1]);
    if (!machine) fail(404, "Machine not found");
    if (method === "PUT") {
      const input = metadata(await body(request));
      if (
        machine.roles.includes("database") &&
        !input.roles.includes("database") &&
        ctx.store.list("databases").some((d) => d.machine_id === machine.id)
      )
        fail(409, "Move or remove owned databases before removing this role");
      ctx.store.put("machines", machine.id, { ...machine, ...input });
      ctx.broadcast();
      return json({ ok: true });
    }
    if (method === "DELETE") {
      if (
        ctx.store.get("network_nodes", machine.id)?.is_server ||
        ctx.store.list("databases").some((d) => d.machine_id === machine.id) ||
        ctx.store.list("services").some((s) => s.machine_id === machine.id) ||
        ctx.store
          .list("retained_volumes")
          .some((v) => v.machine_id === machine.id)
      )
        fail(409, "Machine owns fleet coordination or persistent workloads");
      await ctx.env.DIRECTORY.prepare(
        "DELETE FROM machine_routes WHERE id=? AND workspace_id=?",
      )
        .bind(machine.id, ctx.workspaceId)
        .run();
      ctx.store.delete("machines", machine.id);
      ctx.store.delete("network_nodes", machine.id);
      ctx.broadcast();
      return json({ ok: true });
    }
  }
  if (path === "/api/fleet/history" && method === "GET") {
    requireUser(ctx);
    const since = new Date(Date.now() - 3600000).toISOString(),
      machines: Record<string, Doc[]> = {};
    for (const s of ctx.store
      .list("samples")
      .filter((s) => s.sampled_at >= since)
      .sort((a, b) => a.sampled_at.localeCompare(b.sampled_at)))
      (machines[s.machine_id] ??= []).push({
        at: s.sampled_at,
        cpu: s.cpu_percent,
        mem: s.memory_used,
        disk: s.disk_used,
      });
    return json({ since, step_seconds: 60, machines });
  }
  return null;
}
