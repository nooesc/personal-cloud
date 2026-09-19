import { handleDatabaseProviders, databaseProviderSnapshot } from "./database-providers";
import { reconcileAppleJobs } from "./apple-nomad";
import { handleBackups, reconcileBackups } from "./runtime/backups";
import { handleAppleJobs } from "./apple-jobs";
import {
  createProject,
  updateProject,
  organization,
} from "./project-organization";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import {
  body,
  selectDocuments,
  fail,
  HttpError,
  id,
  json,
  NomadPending,
  now,
  requireUser,
  text,
  type Doc,
  type WorkspaceContext,
} from "./core";
import { SqlStore } from "./store";
import { CloudflareOverview } from "./cloudflare-overview";
import { observeReadiness, workspaceReadiness } from "./readiness";
import { open, seal, sha256, equal } from "./crypto";
import { handleFleet, publicMachine } from "./fleet";
import {
  handleRuntime,
  reconcileRuntime,
  publicDeployment,
  publicDatabase,
  validateService,
  observeService,
} from "./runtime";
import {
  handleIntegrations,
  integrationStatus,
  reconcileDomains,
} from "./integrations";
import { handleWorkspaceMigration } from "./migration";
export class Workspace extends DurableObject<Env> {
  private store: SqlStore;
  private reconciling = false;
  private cloudflareOverview = new CloudflareOverview();
  private readinessRefresh: Promise<void> | undefined;
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.store = new SqlStore(state.storage);
  }
  private context(
    userId: string | null = null,
    machineId: string | null = null,
  ): WorkspaceContext {
    const workspaceId = this.store.get<{ id: string }>("meta", "workspace")?.id;
    if (!workspaceId) fail(500, "Workspace is not initialized");
    return {
      store: this.store,
      env: this.env,
      workspaceId,
      userId,
      machineId,
      requestNomad: (method, path, body, machine) =>
        this.requestNomad(method, path, body, machine),
      schedule: async (delay = 1000) => {
        const current = await this.ctx.storage.getAlarm(),
          next = Date.now() + Math.max(1, delay);
        if (
          !current ||
          current > next ||
          (current <= Date.now() && !this.reconciling)
        )
          await this.ctx.storage.setAlarm(next);
      },
      broadcast: () => this.broadcast(),
      event: (kind, message) => {
        const eid = id();
        this.store.put("events", eid, {
          id: eid,
          kind,
          message,
          created_at: now(),
        });
      },
      seal: (purpose, value) =>
        seal(this.env.ENCRYPTION_KEY, `${workspaceId}:${purpose}`, value),
      open: (purpose, value) =>
        open(this.env.ENCRYPTION_KEY, `${workspaceId}:${purpose}`, value),
    };
  }
  private broadcast() {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const info = socket.deserializeAttachment() as Doc;
        if (!info.serviceId) socket.send(JSON.stringify({ type: "changed" }));
      } catch {
        socket.close(1011, "Reconnect");
      }
    }
  }
  private async snapshot(ctx: WorkspaceContext): Promise<Doc> {
    const integrations = await integrationStatus(ctx);
    const observation = this.store.get("observations", "readiness");
    if (
      this.store.get("settings", "runtime") &&
      !this.readinessRefresh &&
      (!observation ||
        Date.now() - Date.parse(observation.checked_at) > 10000 ||
        observation.runtime !==
          this.store.get("settings", "runtime")?.nomad_url)
    ) {
      this.readinessRefresh = observeReadiness(ctx)
        .catch(() => {
          console.error("readiness refresh failed");
        })
        .finally(() => {
          this.readinessRefresh = undefined;
        });
      this.ctx.waitUntil(this.readinessRefresh);
    }
    return {
      readiness: workspaceReadiness(
        ctx,
        integrations.github.status === "connected",
      ),
      enrollments: this.store
        .list("enrollments")
        .filter((e) => !e.revoked_at)
        .filter(
          (e) =>
            e.expires_at > Date.now() ||
            (e.used_at && Date.now() - Date.parse(e.used_at) < 3600000),
        )
        .sort((a, b) => b.expires_at - a.expires_at)
        .slice(0, 20)
        .map((e) => ({
          id: e.id,
          expires_at: new Date(e.expires_at).toISOString(),
          status: e.used_at ? "connected" : "waiting",
          machine_id: e.machine_id ?? null,
        })),
      machines: this.store.list("machines").map(publicMachine),
      projects: this.store.list("projects"),
      project_resources: organization(ctx).resources,
      capabilities: { project_organization: true, apple_jobs: true },
      services: this.store.list("services"),
      deployments: selectDocuments(this.store, "deployments", {
        limit: 200,
        reverse: true,
      }).map(publicDeployment),
      databases: this.store.list("databases").map(publicDatabase),
      database_providers: databaseProviderSnapshot(ctx),
      // Which service reads which database; credentials stay sealed.
      database_bindings: this.store
        .list("bindings")
        .map((b) => ({ service_id: b.service_id, database_id: b.database_id })),
      domains: this.store.list("domains").map(({ tunnel_token, ...d }) => d),
      activity: selectDocuments(this.store, "events", {
        limit: 30,
        reverse: true,
      }),
      integrations,
      generated_at: now(),
    };
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const workspaceId = request.headers.get("x-pc-workspace-id");
      if (!workspaceId || !/^[a-f0-9-]{36}$/.test(workspaceId))
        fail(403, "Internal workspace context required");
      const saved = this.store.get("meta", "workspace");
      if (saved && saved.id !== workspaceId)
        fail(403, "Workspace context mismatch");
      if (!saved) this.store.put("meta", "workspace", { id: workspaceId });
      const url = new URL(request.url),
        path = url.pathname,
        ctx = this.context(
          request.headers.get("x-pc-user-id"),
          request.headers.get("x-pc-machine-id"),
        );
      const migration = await handleWorkspaceMigration(request, ctx);
      if (migration) return migration;
      if (this.store.get("meta", "migration")?.status === "staged")
        fail(503, "Workspace migration is awaiting activation");
      if (path === "/internal/registry/authorize") {
        const input = await body(request),
          credential = this.store.get("settings", "registry-credential");
        if (!credential || !equal(credential.hash, String(input.hash)))
          fail(401, "Registry authentication required");
        return json({ ok: true });
      }
      if (path === "/internal/github/webhook") {
        const input = await body(request),
          delivery = String(input.delivery_id),
          payload = input.payload;
        if (this.store.get("webhooks", delivery))
          return json({ ok: true, duplicate: true });
        if (
          input.event === "push" &&
          !payload.deleted &&
          typeof payload.ref === "string" &&
          payload.ref.startsWith("refs/heads/")
        ) {
          const repo = payload.repository?.full_name,
            branch = payload.ref.slice(11),
            sha = payload.after;
          if (typeof repo === "string" && /^[a-f0-9]{40,64}$/.test(sha))
            for (const project of this.store
              .list("projects")
              .filter((p) => p.repository === repo && p.branch === branch))
              for (const service of this.store
                .list("services")
                .filter(
                  (s) => s.project_id === project.id && s.auto_deploy !== false,
                )) {
                this.store.put("push_requests", `${service.id}:${sha}`, {
                  id: `${service.id}:${sha}`,
                  service_id: service.id,
                  commit_sha: sha,
                  created_at: now(),
                });
              }
        }
        this.store.put("webhooks", delivery, {
          id: delivery,
          created_at: now(),
        });
        await ctx.schedule();
        return json({ ok: true });
      }
      if (path === "/internal/session/revoke") {
        const data = await body(request);
        for (const ws of this.ctx.getWebSockets()) {
          const a = ws.deserializeAttachment() as Doc;
          if (a.userId === data.userId) ws.close(1008, "Session ended");
        }
        return json({ ok: true });
      }
      const serviceEvents = path.match(/^\/api\/services\/([^/]+)\/events$/);
      if (
        (path === "/api/events" || serviceEvents) &&
        request.headers.get("Upgrade")?.toLowerCase() === "websocket"
      ) {
        requireUser(ctx);
        if (this.ctx.getWebSockets().length >= 100)
          fail(429, "Too many workspace connections");
        if (serviceEvents && !this.store.get("services", serviceEvents[1]))
          fail(404, "Service not found");
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].serializeAttachment({
          userId: ctx.userId,
          serviceId: serviceEvents?.[1] ?? null,
          sessionHash: request.headers.get("x-pc-session-hash"),
          expires: Date.now() + 12 * 3600000,
        });
        await ctx.schedule(serviceEvents ? 1 : 60000);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      const backup = await handleBackups(request, ctx);
      if (backup) return backup;
      const apple = await handleAppleJobs(request, ctx);
      if (apple) return apple;
      const fleet = await handleFleet(request, ctx);
      if (fleet) return fleet;
      requireUser(ctx);
      const cloudflareView = await this.cloudflareOverview.handle(request, ctx);
      if (cloudflareView) return cloudflareView;
      if (path === "/api/snapshot" && request.method === "GET")
        return json(await this.snapshot(ctx));
      if (path === "/api/projects" && request.method === "POST")
        return json(createProject(ctx, await body(request)), 201);
      const projectUpdate = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projectUpdate && request.method === "PATCH")
        return json(updateProject(ctx, projectUpdate[1], await body(request)));
      const projectServices = path.match(
        /^\/api\/projects\/([^/]+)\/services$/,
      );
      if (projectServices && request.method === "POST") {
        const input = await body(request);
        // Re-read after body I/O so repository edits or deletion cannot race this guard.
        const project = this.store.get("projects", projectServices[1]);
        if (!project) fail(404, "Project not found");
        if (!project.repository)
          fail(
            409,
            "Connect a GitHub repository before adding a machine service",
          );
        if (project.status === "deleting")
          fail(409, "Project is being removed");
        const name = text(input.name, 80),
          port = Number(input.port ?? 3000);
        if (!Number.isInteger(port) || port < 1 || port > 65535)
          fail(400, "Invalid port");
        if (
          this.store
            .list("services")
            .some((s) => s.project_id === project.id && s.name === name)
        )
          fail(409, "Service already exists");
        const placement = input.placement ?? { kind: "automatic" };
        if (!["automatic", "home", "vps", "machine"].includes(placement.kind))
          fail(400, "Invalid placement");
        if (
          placement.kind === "machine" &&
          !this.store.get("machines", placement.machine_id)
        )
          fail(404, "Machine not found");
        const root = input.root_directory ?? ".";
        if (
          typeof root !== "string" ||
          root.startsWith("/") ||
          root.split("/").includes("..")
        )
          fail(400, "Invalid source directory");
        const service = {
          id: id(),
          project_id: project.id,
          name,
          ...validateService({
            ...input,
            port,
            placement,
            root_directory: root,
          }),
          status: "not_deployed",
          created_at: now(),
        };
        this.store.put("services", service.id, service);
        ctx.broadcast();
        return json(service, 201);
      }
      return (
        (await handleDatabaseProviders(request, ctx)) ??
        (await handleRuntime(request, ctx)) ??
        (await handleIntegrations(request, ctx)) ??
        json({ error: "Not found" }, 404)
      );
    } catch (error) {
      return this.error(error);
    }
  }
  private error(error: unknown): Response {
    if (error instanceof NomadPending)
      return json({ error: error.message, pending: true }, 503);
    if (error instanceof HttpError)
      return json({ error: error.message }, error.status);
    console.error(
      "workspace request failed",
      error instanceof Error ? error.name : "unknown",
    );
    return json({ error: "Workspace operation failed" }, 500);
  }
  async requestNomad(
    method: string,
    path: string,
    payload?: unknown,
    requestedMachine?: string,
  ): Promise<Doc> {
    if (
      !["GET", "POST", "PUT", "DELETE"].includes(method) ||
      !path.startsWith("/v1/") ||
      path.includes("..")
    )
      fail(400, "Invalid runtime request");
    const runtime = this.store.get("settings", "runtime"),
      machineId =
        requestedMachine ?? runtime?.nomad_url?.replace(/^agent:\/\//, "");
    const machine = this.store.get("machines", machineId || "");
    if (!machine) fail(409, "Add and provision a fleet server first");
    if (Date.now() - Date.parse(machine.last_seen) > 60000)
      throw new NomadPending("Fleet server is offline");
    const key = await sha256(
      JSON.stringify([machineId, method, path, payload ?? null]),
    );
    let command = selectDocuments(this.store, "commands", {
      equal: { key },
    }).find(
      (c) =>
        c.key === key &&
        ((!c.completed_at && c.claimed_at && method !== "GET") ||
          (c.expires_at > Date.now() &&
            (!c.completed_at ||
              Date.now() - Date.parse(c.completed_at) <
                (method === "GET" ? 5000 : 60000)))),
    );
    if (
      command?.claimed_at &&
      !command.completed_at &&
      command.expires_at <= Date.now()
    )
      throw new NomadPending(
        "Runtime mutation outcome is unknown; waiting for reconciliation",
      );
    const context = this.context();
    if (!command) {
      const cid = id();
      command = {
        id: cid,
        key,
        method,
        machine_id: machineId,
        request: await context.seal(
          `command:${cid}`,
          JSON.stringify({ method, path, body: payload ?? null }),
        ),
        created_at: now(),
        expires_at: Date.now() + 120000,
      };
      this.store.put("commands", cid, command);
    }
    // Agent callbacks enter this object while this request is awaiting; no global lock.
    for (let i = 0; i < 40; i++) {
      const observed = this.store.get("commands", command.id)!;
      if (observed.completed_at) {
        const result = JSON.parse(
          await context.open(`result:${observed.id}`, observed.result),
        );
        if (result.status < 200 || result.status >= 300)
          fail(result.status, `Machine runtime returned HTTP ${result.status}`);
        if (path.includes("/fs/logs/")) return { raw: result.body };
        try {
          return JSON.parse(result.body);
        } catch {
          return { raw: result.body };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await context.schedule(1000);
    throw new NomadPending();
  }
  async alarm(): Promise<void> {
    if (this.store.get("meta", "migration")?.status === "staged") return;
    if (this.reconciling) {
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      return;
    }
    this.reconciling = true;
    const ctx = this.context("system");
    try {
      for (const pending of this.store.list("push_requests")) {
        try {
          const result = await handleRuntime(
            new Request(
              `https://internal/api/services/${pending.service_id}/deploy`,
              {
                method: "POST",
                body: JSON.stringify({ commit_sha: pending.commit_sha }),
                headers: { "Content-Type": "application/json" },
              },
            ),
            ctx,
          );
          if (result && result.ok)
            this.store.delete("push_requests", pending.id);
        } catch (error) {
          if (!(error instanceof NomadPending))
            console.error("push deployment pending", pending.service_id);
        }
      }
      await reconcileAppleJobs(ctx);
      await reconcileRuntime(ctx);
      await reconcileBackups(ctx);
      await reconcileDomains(ctx);
      const cleanup = this.store.get("meta", "cleanup");
      if (!cleanup || cleanup.next_at <= Date.now()) {
        for (const [collection, field, ttl] of [
          ["commands", "created_at", 3600000],
          ["samples", "sampled_at", 6 * 3600000],
          ["webhooks", "created_at", 7 * 86400000],
          ["events", "created_at", 30 * 86400000],
        ] as const)
          this.store.prune(
            collection,
            field,
            new Date(Date.now() - ttl).toISOString(),
          );
        this.store.put("meta", "cleanup", { next_at: Date.now() + 60000 });
      }
      const observations = new Map<string, Doc>();
      for (const ws of this.ctx.getWebSockets()) {
        const attachment = ws.deserializeAttachment() as Doc;
        const member = await this.env.DIRECTORY.prepare(
          "SELECT 1 FROM memberships m JOIN sessions s ON s.user_id=m.user_id AND s.workspace_id=m.workspace_id JOIN users u ON u.id=s.user_id WHERE m.workspace_id=? AND m.user_id=? AND s.token_hash=? AND s.expires_at>? AND s.auth_generation=u.auth_generation",
        )
          .bind(
            ctx.workspaceId,
            attachment.userId,
            attachment.sessionHash,
            Date.now(),
          )
          .first();
        if (!member || attachment.expires < Date.now()) {
          ws.close(1008, "Session expired");
          continue;
        }
        if (attachment.serviceId) {
          let observation = observations.get(attachment.serviceId);
          if (!observation) {
            const service = this.store.get("services", attachment.serviceId);
            try {
              observation = service
                ? await observeService(ctx, service)
                : { type: "unavailable", error: "Service was removed" };
            } catch {
              observation = {
                type: "unavailable",
                error: "Waiting for service runtime",
              };
            }
            observations.set(attachment.serviceId, observation);
          }
          ws.send(JSON.stringify(observation));
        }
      }
      this.broadcast();
    } catch (error) {
      if (!(error instanceof NomadPending))
        console.error(
          "workspace reconciliation failed",
          error instanceof Error ? error.name : "unknown",
        );
    } finally {
      this.reconciling = false;
      const active =
        this.store
          .list("apple_jobs")
          .some((j) =>
            ["queued", "running", "cancelling"].includes(j.status),
          ) ||
        this.store
          .list("runtime_operations")
          .some((o) => !["completed", "failed"].includes(o.status)) ||
        this.store
          .list("deployments")
          .some((d) =>
            ["queued", "building", "deploying"].includes(d.status),
          ) ||
        this.store.list("push_requests").length > 0;
      if (
        active ||
        this.ctx.getWebSockets().length ||
        this.store.list("domains").length
      )
        await ctx.schedule(
          active
            ? 2000
            : this.ctx
                  .getWebSockets()
                  .some((ws) => (ws.deserializeAttachment() as Doc).serviceId)
              ? 5000
              : 60000,
        );
    }
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong");
  }
  webSocketClose(ws: WebSocket, code: number) {
    ws.close(code, "Closed");
  }
  webSocketError(ws: WebSocket) {
    ws.close(1011, "Reconnect");
  }
}
