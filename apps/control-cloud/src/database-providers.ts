import { observeConvexRuntime } from "./convex-runtime";
/** Account-wide discovery; only selected resource credentials cross into app bindings. */
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
const accounts = "database_accounts",
  links = "database_links",
  bindings = "provider_bindings";
const segment = (v: unknown) => encodeURIComponent(text(String(v ?? ""), 200));
function get(ctx: WorkspaceContext, collection: string, key: string): Doc {
  return (
    ctx.store.get(collection, key) ??
    fail(404, "Resource not found in this workspace")
  );
}
export function publicAccount(a: Doc): Doc {
  const { credential_encrypted, ...safe } = a;
  return safe;
}
export function publicLink(a: Doc): Doc {
  const { connection_encrypted, admin_encrypted, ...safe } = a;
  return safe;
}
export function databaseProviderSnapshot(ctx: WorkspaceContext): Doc {
  return {
    accounts: ctx.store.list(accounts).map(publicAccount),
    resources: ctx.store.list(links).map(publicLink),
    bindings: ctx.store.list(bindings),
  };
}
async function request(
  url: string,
  key: string,
  prefix = "Bearer",
): Promise<Doc> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `${prefix} ${key}`,
        Accept: "application/json",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return fail(
      502,
      "Provider could not be reached. Check the connection and retry.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    fail(
      response.status === 401 || response.status === 403 ? 403 : 502,
      `Provider returned HTTP ${response.status}. Check account access and permissions.`,
    );
  }
  try {
    return (await response.json()) as Doc;
  } catch {
    return fail(502, "Provider returned an invalid response");
  }
}
async function provider(
  ctx: WorkspaceContext,
  a: Doc,
  path: string,
): Promise<Doc> {
  const key = await ctx.open(
    `database-account:${a.id}`,
    a.credential_encrypted,
  );
  return request(
    (a.provider === "neon"
      ? "https://console.neon.tech/api/v2"
      : "https://api.convex.dev/v1") + path,
    key,
  );
}
function rows(value: unknown): Doc[] {
  if (!Array.isArray(value)) fail(502, "Provider omitted its resource list");
  return value;
}
async function projectPage(
  ctx: WorkspaceContext,
  a: Doc,
  cursor?: string,
): Promise<Doc> {
  const q = new URLSearchParams({ limit: "100" });
  if (cursor) q.set("cursor", text(cursor, 2048));
  if (a.provider === "neon") q.set("org_id", a.scope_id);
  const result = await provider(
    ctx,
    a,
    a.provider === "neon"
      ? `/projects?${q}`
      : `/teams/${segment(a.scope_id)}/projects?${q}`,
  );
  const projects = rows(
    a.provider === "neon" ? result.projects : result.items,
  ).map((p) => ({
    id: String(p.id),
    name: String(p.name),
    region: p.region_id ?? null,
  }));
  const next =
    a.provider === "neon"
      ? result.pagination?.cursor
      : result.pagination?.nextCursor;
  return { items: projects, next_cursor: next || null };
}
async function scopedProject(
  ctx: WorkspaceContext,
  a: Doc,
  project: string,
): Promise<Doc> {
  const p = await provider(ctx, a, `/projects/${segment(project)}`);
  const record = a.provider === "neon" ? p.project : p;
  if (
    String(a.provider === "neon" ? record?.org_id : record?.teamId) !==
    a.scope_id
  )
    fail(403, "Project belongs to another organization");
  return record;
}
function httpsOrigin(value: unknown, cloud = false): string {
  let u: URL;
  try {
    u = new URL(text(value, 2048));
  } catch {
    return fail(400, "Enter an HTTPS backend URL");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    u.port ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(u.hostname) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(u.hostname)
  )
    fail(
      400,
      "Use a public HTTPS backend origin without a path, port or credentials",
    );
  if (cloud && !u.hostname.endsWith(".convex.cloud"))
    fail(502, "Provider returned an unexpected deployment URL");
  return u.origin;
}
function dashboardOrigin(value: unknown): string {
  // Local dashboards are intentionally reachable only through the owner's tunnel.
  const raw = text(value, 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(400, "Enter a dashboard URL");
  }
  if (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash
  )
    return url.origin;
  return httpsOrigin(raw);
}
async function resourceOptions(
  ctx: WorkspaceContext,
  a: Doc,
  project: string,
  branch?: string,
  cursor?: string,
): Promise<Doc> {
  await scopedProject(ctx, a, project);
  if (a.provider === "convex") {
    const result = await provider(
      ctx,
      a,
      `/projects/${segment(project)}/list_deployments`,
    );
    return {
      items: rows(result)
        .filter((d) => d.kind === "cloud")
        .map((d) => ({
          id: String(d.name),
          name: String(d.name),
          environment: d.deploymentType,
          url: httpsOrigin(d.deploymentUrl, true),
        })),
    };
  }
  if (!branch) {
    const q = new URLSearchParams({ limit: "100" });
    if (cursor) q.set("cursor", text(cursor, 2048));
    const result = await provider(
      ctx,
      a,
      `/projects/${segment(project)}/branches?${q}`,
    );
    return {
      items: rows(result.branches).map((b) => ({
        id: String(b.id),
        name: String(b.name),
        is_default: b.default === true,
      })),
      next_cursor: result.pagination?.next ?? null,
    };
  }
  const base = `/projects/${segment(project)}/branches/${segment(branch)}`;
  const [dbs, roles] = await Promise.all([
    provider(ctx, a, `${base}/databases`),
    provider(ctx, a, `${base}/roles`),
  ]);
  return {
    items: rows(dbs.databases).map((d) => ({
      id: String(d.name),
      name: String(d.name),
    })),
    roles: rows(roles.roles)
      .filter((r) => !r.protected)
      .map((r) => ({ name: String(r.name) })),
  };
}
function projectReady(ctx: WorkspaceContext, project: string): void {
  if (get(ctx, "projects", project).status === "deleting")
    fail(409, "Project is being removed");
}
function noActiveDeployment(ctx: WorkspaceContext, serviceId: string): void {
  if (
    ctx.store
      .list("deployments")
      .some(
        (d) =>
          d.service_id === serviceId &&
          ["queued", "building", "deploying"].includes(d.status),
      )
  )
    fail(409, "Wait for the active deployment before changing its connection");
}
function bind(ctx: WorkspaceContext, link: Doc, input: Doc): void {
  link = get(ctx, links, link.id);
  projectReady(ctx, link.project_id);
  const service = get(ctx, "services", text(input.service_id, 100));
  if (service.status === "deleting") fail(409, "Service is being removed");
  if (service.project_id !== link.project_id)
    fail(400, "Choose a service in the same Dinghy project");
  noActiveDeployment(ctx, service.id);
  const variable =
    link.provider === "neon"
      ? "DATABASE_URL"
      : text(input.variable ?? "CONVEX_URL", 100);
  if (
    link.provider !== "neon" &&
    ![
      "CONVEX_URL",
      "CONVEX_SITE_URL",
      "NEXT_PUBLIC_CONVEX_URL",
      "VITE_CONVEX_URL",
      "PUBLIC_CONVEX_URL",
    ].includes(variable)
  )
    fail(400, "Choose a supported Convex URL variable");
  if (variable === "CONVEX_SITE_URL" && !link.site_url)
    fail(409, "Add the HTTP actions URL before attaching this worker");
  if (link.provider === "neon" && ctx.store.get("bindings", service.id))
    fail(409, "Detach the fleet database before attaching Neon");
  const family = link.provider === "neon" ? "postgres" : "convex";
  const existing = ctx.store.get(bindings, `${service.id}:${family}`);
  if (existing && existing.resource_id !== link.id)
    fail(409, "Detach the current provider resource first");
  ctx.store.put(bindings, `${service.id}:${family}`, {
    id: `${service.id}:${family}`,
    service_id: service.id,
    resource_id: link.id,
    variable,
  });
}
export async function providerEnvironment(
  ctx: WorkspaceContext,
  service: string,
): Promise<Doc> {
  const env: Doc = {};
  for (const b of ctx.store
    .list(bindings)
    .filter((b) => b.service_id === service)) {
    const link = get(ctx, links, b.resource_id);
    if (link.provider === "neon")
      env.DATABASE_URL = await ctx.open(
        `database-link:${link.id}`,
        link.connection_encrypted,
      );
    else {
      env.CONVEX_URL = link.url;
      env[b.variable] =
        b.variable === "CONVEX_SITE_URL" ? link.site_url : link.url;
    }
  }
  return env;
}
export async function handleDatabaseProviders(
  req: Request,
  ctx: WorkspaceContext,
): Promise<Response | null> {
  const u = new URL(req.url),
    path = u.pathname,
    method = req.method;
  if (!path.startsWith("/api/database-providers")) return null;
  requireUser(ctx);
  if (path === "/api/database-providers" && method === "GET")
    return json(databaseProviderSnapshot(ctx));
  if (path === "/api/database-providers/accounts" && method === "POST") {
    const input = await body(req);
    if (!["neon", "convex"].includes(input.provider))
      fail(400, "Choose Neon or Convex");
    const scope = text(input.scope_id, 100);
    if (!(input.provider === "neon" ? /^org-[a-z0-9-]+$/ : /^\d+$/).test(scope))
      fail(400, "Enter a Neon organization ID or Convex numeric team ID");
    if (
      ctx.store
        .list(accounts)
        .some((a) => a.provider === input.provider && a.scope_id === scope)
    )
      fail(409, "This organization is already connected");
    const a: Doc = {
      id: id(),
      provider: input.provider,
      scope_id: scope,
      name: text(input.name, 80),
      created_at: now(),
    };
    a.credential_encrypted = await ctx.seal(
      `database-account:${a.id}`,
      text(input.api_key, 8192),
    );
    await projectPage(ctx, a);
    if (
      ctx.store
        .list(accounts)
        .some((x) => x.provider === a.provider && x.scope_id === scope)
    )
      fail(409, "This organization is already connected");
    a.checked_at = now();
    ctx.store.put(accounts, a.id, a);
    ctx.broadcast();
    return json(publicAccount(a), 201);
  }
  let m =
    /^\/api\/database-providers\/accounts\/([^/]+)(?:\/(projects|resources|credential))?$/.exec(
      path,
    );
  if (m) {
    const a = get(ctx, accounts, m[1]!);
    if (m[2] === "credential" && method === "PUT") {
      const candidate: Doc = {
        ...a,
        credential_encrypted: await ctx.seal(
          `database-account:${a.id}`,
          text((await body(req)).api_key, 8192),
        ),
      };
      await projectPage(ctx, candidate);
      get(ctx, accounts, a.id);
      candidate.checked_at = now();
      ctx.store.put(accounts, a.id, candidate);
      ctx.broadcast();
      return json(publicAccount(candidate));
    }
    if (m[2] === "projects" && method === "GET")
      return json(
        await projectPage(ctx, a, u.searchParams.get("cursor") ?? undefined),
      );
    if (m[2] === "resources" && method === "GET")
      return json(
        await resourceOptions(
          ctx,
          a,
          text(u.searchParams.get("project_id"), 200),
          u.searchParams.get("branch_id") ?? undefined,
          u.searchParams.get("cursor") ?? undefined,
        ),
      );
    if (!m[2] && method === "DELETE") {
      if (ctx.store.list(links).some((l) => l.account_id === a.id))
        fail(
          409,
          "Unlink this account's resources before disconnecting. Remote data will remain intact.",
        );
      ctx.store.delete(accounts, a.id);
      ctx.broadcast();
      return json({ disconnected: true });
    }
  }
  if (path === "/api/database-providers/resources" && method === "POST") {
    const input = await body(req);
    projectReady(ctx, text(input.project_id, 100));
    const link: Doc = {
      id: id(),
      project_id: input.project_id,
      name: text(input.name, 80),
      created_at: now(),
      status: "linked",
    };
    if (input.provider === "convex_self_hosted") {
      link.provider = input.provider;
      link.url = httpsOrigin(input.url);
      link.site_url = input.site_url ? httpsOrigin(input.site_url) : null;
      link.dashboard_url = input.dashboard_url
        ? dashboardOrigin(input.dashboard_url)
        : null;
      const admin = text(input.admin_key, 8192);
      // This authenticated read validates access. Never persist or return environment values.
      await request(
        link.url + "/api/v1/list_environment_variables",
        admin,
        "Convex",
      );
      link.admin_encrypted = await ctx.seal(
        `database-link-admin:${link.id}`,
        admin,
      );
    } else {
      const a = get(ctx, accounts, text(input.account_id, 100));
      link.account_id = a.id;
      link.provider = a.provider;
      link.provider_project_id = text(input.provider_project_id, 200);
      await scopedProject(ctx, a, link.provider_project_id);
      if (a.provider === "convex") {
        const options = await resourceOptions(ctx, a, link.provider_project_id);
        const selected = options.items.find(
          (d: Doc) => d.id === input.deployment,
        );
        if (!selected) fail(400, "Choose a deployment from this project");
        link.deployment = selected.id;
        link.url = selected.url;
        link.environment = selected.environment;
      } else {
        link.branch_id = text(input.branch_id, 200);
        link.database_name = text(input.database_name, 200);
        link.role_name = text(input.role_name, 200);
        const options = await resourceOptions(
          ctx,
          a,
          link.provider_project_id,
          link.branch_id,
        );
        if (
          !options.items.some((d: Doc) => d.id === link.database_name) ||
          !options.roles.some((r: Doc) => r.name === link.role_name)
        )
          fail(400, "Choose a database and role from this branch");
        const q = new URLSearchParams({
          branch_id: link.branch_id,
          database_name: link.database_name,
          role_name: link.role_name,
          pooled: "true",
        });
        const result = await provider(
          ctx,
          a,
          `/projects/${segment(link.provider_project_id)}/connection_uri?${q}`,
        );
        let uri: URL;
        try {
          uri = new URL(result.uri);
        } catch {
          return fail(502, "Provider omitted its connection URI");
        }
        if (
          !["postgres:", "postgresql:"].includes(uri.protocol) ||
          !uri.hostname.endsWith(".neon.tech") ||
          !["require", "verify-full"].includes(
            uri.searchParams.get("sslmode") ?? "",
          )
        )
          fail(502, "Provider returned an unexpected PostgreSQL connection");
        link.address = uri.hostname;
        link.connection_encrypted = await ctx.seal(
          `database-link:${link.id}`,
          result.uri,
        );
      }
      // Recheck after provider I/O so a disconnect cannot leave an orphan connection.
      get(ctx, accounts, a.id);
    }
    projectReady(ctx, link.project_id);
    if (
      ctx.store
        .list(links)
        .some(
          (r) =>
            r.project_id === link.project_id &&
            r.provider === link.provider &&
            r.url &&
            r.url === link.url,
        )
    )
      fail(409, "This backend is already linked to this project");
    link.checked_at = now();
    ctx.store.put(links, link.id, link);
    ctx.broadcast();
    return json(publicLink(link), 201);
  }
  m =
    /^\/api\/database-providers\/resources\/([^/]+)(?:\/(attach|detach|connection|check|runtime))?$/.exec(
      path,
    );
  if (m) {
    const link = get(ctx, links, m[1]!);
    if (m[2] === "runtime" && method === "POST") {
      if (link.provider !== "convex_self_hosted")
        fail(400, "Only self-hosted Convex has a fleet runtime");
      const input = await body(req);
      const runtime = await observeConvexRuntime(ctx, input.job_id);
      const current = get(ctx, links, link.id);
      projectReady(ctx, current.project_id);
      if (current.runtime && current.runtime.job_id !== runtime.job_id)
        fail(
          409,
          "This database is pinned to its existing runtime; relocation requires a separate migration",
        );
      ctx.store.put(links, link.id, { ...current, runtime });
      ctx.broadcast();
      return json(runtime);
    }
    if (link.provider === "convex_self_hosted" && !m[2] && method === "PATCH") {
      const input = await body(req);
      const current = get(ctx, links, link.id);
      projectReady(ctx, current.project_id);
      const next = { ...current };
      if (input.site_url !== undefined) {
        next.site_url = input.site_url ? httpsOrigin(input.site_url) : null;
        if (
          next.site_url !== current.site_url &&
          ctx.store
            .list(bindings)
            .some(
              (b) =>
                b.resource_id === link.id && b.variable === "CONVEX_SITE_URL",
            )
        )
          fail(409, "Detach HTTP actions readers before changing their URL");
      }
      if (input.dashboard_url !== undefined)
        next.dashboard_url = input.dashboard_url
          ? dashboardOrigin(input.dashboard_url)
          : null;
      ctx.store.put(links, link.id, next);
      ctx.broadcast();
      return json(publicLink(next));
    }
    if (m[2] === "check" && method === "POST") {
      if (link.provider !== "convex_self_hosted")
        fail(400, "Connection checks are available for self-hosted Convex");
      let error: string | null = null;
      try {
        const key = await ctx.open(
          `database-link-admin:${link.id}`,
          link.admin_encrypted,
        );
        await request(
          link.url + "/api/v1/list_environment_variables",
          key,
          "Convex",
        );
      } catch {
        error =
          "Could not verify backend access. Check its availability and admin key.";
      }
      const current = get(ctx, links, link.id);
      ctx.store.put(links, link.id, {
        ...current,
        last_check_at: now(),
        check_error: error,
        ...(error ? {} : { checked_at: now() }),
      });
      ctx.broadcast();
      return json({ verified: !error, error });
    }
    if (m[2] === "connection" && method === "GET")
      return json(
        link.provider === "neon"
          ? {
              DATABASE_URL: await ctx.open(
                `database-link:${link.id}`,
                link.connection_encrypted,
              ),
            }
          : link.provider === "convex_self_hosted"
            ? {
                CONVEX_SELF_HOSTED_URL: link.url,
                CONVEX_SELF_HOSTED_ADMIN_KEY: await ctx.open(
                  `database-link-admin:${link.id}`,
                  link.admin_encrypted,
                ),
              }
            : { CONVEX_URL: link.url },
      );
    if (m[2] === "attach" && method === "POST") {
      bind(ctx, link, await body(req));
      ctx.broadcast();
      return json({ ok: true });
    }
    if (m[2] === "detach" && method === "POST") {
      const input = await body(req);
      noActiveDeployment(ctx, input.service_id);
      for (const b of ctx.store
        .list(bindings)
        .filter(
          (b) => b.resource_id === link.id && b.service_id === input.service_id,
        ))
        ctx.store.delete(bindings, b.id);
      ctx.broadcast();
      return json({ ok: true });
    }
    if (!m[2] && method === "DELETE") {
      if (ctx.store.list(bindings).some((b) => b.resource_id === link.id))
        fail(409, "Detach services before unlinking this resource");
      ctx.store.delete(links, link.id);
      ctx.broadcast();
      return json({ unlinked: true, remote_data_preserved: true });
    }
  }
  return json({ error: "Not found" }, 404);
}
