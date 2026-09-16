import {
  body,
  fail,
  json,
  now,
  requireUser,
  text,
  type Doc,
  type WorkspaceContext,
} from "./core";
import { registryCredentials } from "./integrations";
import {
  ACTIVE,
  code,
  environment,
  get,
  nodes,
  pending,
  publicDatabase,
  publicDeployment,
  save,
  stopJob,
} from "./runtime/common";
import {
  createDatabase,
  attachDatabase,
  reconcileDatabase,
  removeDatabase,
  retryDatabase,
} from "./runtime/database";
import {
  observeService,
  queueDeployment,
  reconcileDeployment,
  reconcileServiceHealth,
} from "./runtime/deploy";
import { validateService } from "./runtime/jobs";
export {
  queueDeployment,
  observeService,
  publicDatabase,
  publicDeployment,
  validateService,
};

export async function runtimeStatus(ctx: WorkspaceContext): Promise<Doc> {
  const cfg = ctx.store.get("settings", "runtime");
  if (!cfg) return { status: "not_configured", nodes: [] };
  const safe = {
    nomad_url: cfg.nomad_url,
    registry_url: cfg.registry_url,
    buildkit_address: cfg.buildkit_address ?? "tcp://127.0.0.1:1234",
    builder_image:
      cfg.builder_image ?? "ghcr.io/nooesc/personal-cloud-builder:latest",
    allow_insecure_registry: false,
  };
  try {
    return {
      ...safe,
      status: "connected",
      nodes: (await nodes(ctx)).map((n) => ({
        ID: n.ID,
        Name: n.Name,
        Status: n.Status,
        SchedulingEligibility: n.SchedulingEligibility,
        Attributes: n.Attributes,
        Meta: n.Meta,
        NodeResources: n.NodeResources,
        Resources: n.Resources,
        Drivers: n.Drivers,
        HTTPAddr: n.HTTPAddr,
      })),
    };
  } catch (error) {
    if (pending(error)) return { ...safe, status: "connecting", nodes: [] };
    return {
      ...safe,
      status: "unreachable",
      nodes: [],
      error: "Fleet scheduler is unavailable",
    };
  }
}
function validateRuntime(ctx: WorkspaceContext, input: Doc): Doc {
  // Hosted Workers never accept a browser-supplied arbitrary scheduler URL or token.
  if (
    typeof input.nomad_url !== "string" ||
    !input.nomad_url.startsWith("agent://") ||
    !ctx.store.get("machines", input.nomad_url.slice(8))
  )
    fail(400, "Select an enrolled fleet server");
  const builder =
    input.builder_image ?? "ghcr.io/nooesc/personal-cloud-builder:latest";
  if (
    typeof builder !== "string" ||
    builder.length > 250 ||
    !/^[\w./:@-]+$/.test(builder)
  )
    fail(400, "Invalid builder image");
  const buildkit = input.buildkit_address ?? "tcp://127.0.0.1:1234";
  if (
    typeof buildkit !== "string" ||
    buildkit.length > 250 ||
    !/^tcp:\/\/[\w.:[\]-]+:\d+$/.test(buildkit)
  )
    fail(400, "Use a valid BuildKit TCP endpoint");
  return {
    nomad_url: input.nomad_url,
    builder_image: builder,
    buildkit_address: buildkit,
    allow_insecure_registry: false,
    require_cloudflare: true,
  };
}
async function bootstrap(ctx: WorkspaceContext): Promise<Response> {
  const cfg = ctx.store.get("settings", "runtime");
  if (!cfg) fail(409, "Add a fleet server before setting up image storage");
  const registry = await registryCredentials(ctx);
  // This requests the actual managed OCI endpoint; credentials remain in the encrypted provider store.
  const response = await fetch(
    `${registry.registry_url.replace(/\/$/, "")}/v2/`,
    {
      headers: {
        Authorization: `Basic ${btoa(`${registry.registry_username}:${registry.registry_password}`)}`,
      },
    },
  );
  if (!response.ok)
    fail(502, "Managed image registry did not respond successfully");
  ctx.store.put("settings", "runtime", {
    ...cfg,
    registry_url: registry.registry_url,
    repository_prefix: registry.repository_prefix,
    registry_status: "connected",
    registry_checked_at: now(),
  });
  ctx.broadcast();
  return json({
    ok: true,
    status: "connected",
    registry_url: registry.registry_url,
  });
}
function environmentKey(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)
  )
    fail(400, "Invalid environment variable name");
  return value;
}
async function removeService(
  ctx: WorkspaceContext,
  serviceId: string,
): Promise<void> {
  const s = get(ctx, "services", serviceId);
  if (ctx.store.list("domains").some((d) => d.service_id === serviceId))
    fail(409, "Remove this service domains first");
  if (
    ctx.store
      .list("deployments")
      .some((d) => d.service_id === serviceId && ACTIVE.includes(d.status))
  )
    fail(409, "Wait for the active deployment to finish");
  s.status = "deleting";
  save(ctx, "services", s);
  await ctx.schedule(1);
}
async function deleteServiceJobs(ctx: WorkspaceContext, s: Doc): Promise<void> {
  for (const d of ctx.store
    .list("deployments")
    .filter((d) => d.service_id === s.id)) {
    if (d.job_id) await stopJob(ctx, d.job_id);
    if (d.build_job_id) await stopJob(ctx, d.build_job_id);
  }
  ctx.store.transaction(() => {
    for (const d of ctx.store
      .list("deployments")
      .filter((d) => d.service_id === s.id))
      ctx.store.delete("deployments", d.id);
    ctx.store.delete("bindings", s.id);
    ctx.store.delete("services", s.id);
  });
  ctx.broadcast();
}
async function removeProject(
  ctx: WorkspaceContext,
  projectId: string,
): Promise<Response> {
  const p = get(ctx, "projects", projectId);
  if (ctx.store.list("databases").some((d) => d.project_id === projectId))
    fail(
      409,
      "Remove project databases first; persistent volumes are preserved",
    );
  const services = ctx.store
    .list("services")
    .filter((s) => s.project_id === projectId);
  if (
    services.some((s) =>
      ctx.store.list("domains").some((d) => d.service_id === s.id),
    )
  )
    fail(409, "Remove project domains first");
  if (
    services.some((s) =>
      ctx.store
        .list("deployments")
        .some((d) => d.service_id === s.id && ACTIVE.includes(d.status)),
    )
  )
    fail(409, "Wait for active deployments to finish");
  ctx.store.transaction(() => {
    for (const s of services) {
      s.status = "deleting";
      save(ctx, "services", s);
    }
    p.status = "deleting";
    save(ctx, "projects", p);
  });
  await ctx.schedule(1);
  return json({ ok: true, status: "deleting" }, 202);
}
export async function handleRuntime(
  request: Request,
  ctx: WorkspaceContext,
): Promise<Response | null> {
  const path = new URL(request.url).pathname,
    method = request.method;
  if (
    !/^\/api\/(runtime|services\/[^/]+(?:\/|$)|deployments\/|projects\/[^/]+(?:\/environment|$)|databases)/.test(
      path,
    )
  )
    return null;
  requireUser(ctx);
  if (path === "/api/runtime") {
    if (method === "GET") return json(await runtimeStatus(ctx));
    if (method === "PUT") {
      const cfg = validateRuntime(ctx, await body(request));
      ctx.store.put("settings", "runtime", {
        ...ctx.store.get<Doc>("settings", "runtime"),
        ...cfg,
      });
      ctx.broadcast();
      await ctx.schedule(1);
      return json(await runtimeStatus(ctx));
    }
  }
  if (path === "/api/runtime/bootstrap-registry" && method === "POST")
    return bootstrap(ctx);
  if (path === "/api/databases" && method === "POST")
    return json(await createDatabase(ctx, await body(request)), 202);
  let m =
    /^\/api\/databases\/([^/]+)(?:\/(connection|attach|retry|detach))?$/.exec(
      path,
    );
  if (m) {
    const db = get(ctx, "databases", m[1]!);
    if (m[2] === "connection" && method === "GET")
      return json({
        connection_string: await ctx.open(
          `database:${db.id}`,
          db.connection_encrypted,
        ),
      });
    if (m[2] === "attach" && method === "POST") {
      await attachDatabase(ctx, db.id, (await body(request)).service_id);
      return json({ ok: true });
    }
    if (m[2] === "detach" && method === "POST") {
      const service = (await body(request)).service_id,
        binding = ctx.store.get("bindings", service);
      if (binding?.database_id === db.id) ctx.store.delete("bindings", service);
      ctx.broadcast();
      return json({ ok: true });
    }
    if (m[2] === "retry" && method === "POST") {
      await retryDatabase(ctx, db.id);
      return json({ ok: true, status: "pending" }, 202);
    }
    if (!m[2] && method === "DELETE")
      return json(await removeDatabase(ctx, db.id), 202);
  }
  m = /^\/api\/deployments\/([^/]+)$/.exec(path);
  if (m && method === "GET")
    return json(publicDeployment(get(ctx, "deployments", m[1]!)));
  m =
    /^\/api\/services\/([^/]+)(?:\/(deploy|rollback|logs|metrics|events))?$/.exec(
      path,
    );
  if (m) {
    const s = get(ctx, "services", m[1]!);
    if (!m[2] && method === "PUT") {
      const input = await body(request);
      Object.assign(s, validateService({ ...s, ...input }), {
        name: text(input.name ?? s.name, 80),
      });
      save(ctx, "services", s);
      return json({ ok: true });
    }
    if (!m[2] && method === "DELETE") {
      await removeService(ctx, s.id);
      return json({ ok: true, status: "deleting" }, 202);
    }
    if (m[2] === "deploy" && method === "POST")
      return json(await queueDeployment(ctx, s.id, await body(request)), 202);
    if (m[2] === "rollback" && method === "POST") {
      const input = await body(request),
        previous = get(ctx, "deployments", input.deployment_id);
      if (
        previous.service_id !== s.id ||
        !["healthy", "rolled_back"].includes(previous.status) ||
        !previous.image_digest
      )
        fail(400, "Choose a previously healthy deployment of this service");
      return json(
        await queueDeployment(ctx, s.id, {
          image: previous.image_digest,
          commit_sha: previous.commit_sha,
          rollback_of: previous.id,
        }),
        202,
      );
    }
    if (
      ["logs", "metrics", "events"].includes(m[2] ?? "") &&
      method === "GET"
    ) {
      const observation = await observeService(ctx, s);
      if (m[2] === "metrics") return json(observation.metrics);
      if (m[2] === "logs")
        return json({
          lines: observation.lines,
          allocation_id: observation.allocation_id,
        });
      return json(observation);
    }
  }
  m =
    /^\/api\/projects\/([^/]+)\/environment(?:\/([^/]+)(?:\/(reveal))?)?$/.exec(
      path,
    );
  if (m) {
    const p = get(ctx, "projects", m[1]!);
    const key = m[2] ? environmentKey(decodeURIComponent(m[2])) : null;
    if (!key && method === "GET")
      return json({
        variables: ctx.store
          .list("environment")
          .filter((v) => v.project_id === p.id)
          .map((v) => ({ key: v.key, updated_at: v.updated_at }))
          .sort((a, b) => a.key.localeCompare(b.key)),
      });
    if (!key && method === "PUT") {
      const input = await body(request),
        name = environmentKey(input.key);
      if (
        typeof input.value !== "string" ||
        input.value.length > 16384 ||
        input.value.includes("\0")
      )
        fail(400, "Use an environment value under 16 KiB");
      const existingVariables = ctx.store
        .list("environment")
        .filter((v) => v.project_id === p.id && v.key !== name);
      if (
        existingVariables.length >= 128 ||
        existingVariables.reduce(
          (total, v) => total + (v.value_size ?? v.value_encrypted.length),
          0,
        ) +
          input.value.length >
          131072
      )
        fail(
          400,
          "Project environment is limited to 128 variables and 128 KiB",
        );
      ctx.store.put("environment", `${p.id}:${name}`, {
        id: `${p.id}:${name}`,
        project_id: p.id,
        key: name,
        value_size: input.value.length,
        value_encrypted: await ctx.seal(`env:${p.id}:${name}`, input.value),
        updated_at: now(),
      });
      ctx.broadcast();
      return json({ ok: true });
    }
    if (key && !m[3] && method === "DELETE") {
      ctx.store.delete("environment", `${p.id}:${key}`);
      ctx.broadcast();
      return json({ ok: true });
    }
    if (key && m[3] && method === "GET") {
      const row = get(ctx, "environment", `${p.id}:${key}`);
      return json({
        key,
        value: await ctx.open(`env:${p.id}:${key}`, row.value_encrypted),
      });
    }
  }
  m = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (m && method === "DELETE") return removeProject(ctx, m[1]!);
  return null;
}
export async function reconcileRuntime(ctx: WorkspaceContext): Promise<void> {
  // Each document advances one persisted phase per alarm. No background promise owns progress.
  const work = ctx.store
    .list("deployments")
    .filter((d) => d.phase && d.phase !== "done");
  work.sort(
    (a, b) =>
      Date.parse(a.last_reconciled_at ?? a.created_at) -
      Date.parse(b.last_reconciled_at ?? b.created_at),
  );
  for (const d of work.slice(0, 8)) {
    await reconcileDeployment(ctx, d);
    const current = ctx.store.get("deployments", d.id);
    if (current)
      ctx.store.put("deployments", d.id, {
        ...current,
        last_reconciled_at: now(),
      });
  }
  for (const db of ctx.store.list("databases"))
    await reconcileDatabase(ctx, db);
  for (const s of ctx.store.list("services")) {
    try {
      if (s.status === "deleting") await deleteServiceJobs(ctx, s);
      else if (!work.some((d) => d.service_id === s.id))
        await reconcileServiceHealth(ctx, s);
    } catch (error) {
      if (!pending(error) && s.status !== "deleting") {
        s.status = "degraded";
        save(ctx, "services", s);
      }
    }
  }
  for (const p of ctx.store
    .list("projects")
    .filter((p) => p.status === "deleting")) {
    if (!ctx.store.list("services").some((s) => s.project_id === p.id))
      ctx.store.transaction(() => {
        for (const row of ctx.store
          .list("environment")
          .filter((v) => v.project_id === p.id))
          ctx.store.delete("environment", row.id);
        ctx.store.delete("projects", p.id);
      });
  }
  if (
    ctx.store.list("deployments").some((d) => d.phase && d.phase !== "done") ||
    ctx.store.list("databases").length ||
    ctx.store
      .list("services")
      .some((s) => s.current_deployment_id || s.status === "deleting")
  )
    await ctx.schedule(work.length ? 2000 : 15000);
}
