import { fail, id, now, text, type Doc, type WorkspaceContext } from "../core";
import {
  allocations,
  code,
  endpoint,
  ensureJob,
  get,
  healthy,
  logs,
  nodes,
  pending,
  publicDatabase,
  safeError,
  save,
  stopJob,
} from "./common";
import { databaseJob, databaseProbe, privateAddress, ready } from "./jobs";

function bind(ctx: WorkspaceContext, db: Doc, serviceId: string): void {
  if (
    db.restore_id &&
    ctx.store.get("database_backups", db.restore_id)?.status !== "succeeded"
  )
    fail(409, "Wait for a successful restore before attaching this database");
  const service = get(ctx, "services", serviceId);
  if (service.project_id !== db.project_id)
    fail(400, "Attach services from this database project");
  if (ctx.store.get("provider_bindings", `${serviceId}:postgres`)) fail(409, "Detach Neon before attaching a fleet database");
  const existing = ctx.store.get("bindings", serviceId);
  if (existing && existing.database_id !== db.id)
    fail(409, "Service already has a database attached");
  if (db.status === "deleting") fail(409, "Database is being removed");
  ctx.store.put("bindings", serviceId, {
    service_id: serviceId,
    database_id: db.id,
  });
}
export async function createDatabase(
  ctx: WorkspaceContext,
  input: Doc,
  reservedId?: string,
  restoreId?: string,
): Promise<Doc> {
  if (reservedId && ctx.store.get("databases", reservedId))
    return publicDatabase(get(ctx, "databases", reservedId));
  get(ctx, "projects", input.project_id);
  const name = text(input.name, 80),
    services = input.service_ids ?? [];
  if (!Array.isArray(services) || services.length > 100)
    fail(400, "Attach at most 100 services");
  const inventory = await nodes(ctx),
    target = inventory.find(
      (n) =>
        ready(n, "database") &&
        (!input.machine_id || n.Meta.pc_machine_id === input.machine_id),
    );
  if (!target)
    fail(
      409,
      "Choose an online database-role machine with a ready Docker scheduler node",
    );
  const databaseId = reservedId ?? id(),
    user = `pc_${databaseId.replaceAll("-", "")}`;
  const password = Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
  const uri = `postgresql://${user}:${password}@pending.invalid:5432/${user}?sslmode=disable`;
  const db: Doc = {
    id: databaseId,
    ...(restoreId ? { restore_id: restoreId } : {}),
    project_id: input.project_id,
    name,
    engine: "postgresql",
    version: "17",
    machine_id: target.Meta.pc_machine_id,
    nomad_node_id: target.ID,
    datacenter: target.Datacenter ?? "dc1",
    volume_name: `pc-postgres-${databaseId}`,
    job_id: `pc-db-${databaseId}`,
    probe_job_id: `pc-db-probe-${databaseId}-${id()}`,
    status: "pending",
    phase: "submit",
    created_at: now(),
    operation_started_at: now(),
    connection_encrypted: await ctx.seal(`database:${databaseId}`, uri),
  };
  db.job_encrypted = await ctx.seal(
    `database:${db.id}:job`,
    JSON.stringify(databaseJob(db, uri)),
  );
  ctx.store.transaction(() => {
    for (const service of services) bind(ctx, db, service);
    save(ctx, "databases", db);
  });
  ctx.event(
    "database.queued",
    "PostgreSQL provisioning queued on its selected machine",
  );
  await ctx.schedule(1);
  return publicDatabase(db);
}
export async function attachDatabase(
  ctx: WorkspaceContext,
  dbId: string,
  service: string,
): Promise<void> {
  const db = get(ctx, "databases", dbId);
  bind(ctx, db, service);
  ctx.broadcast();
}
export async function retryDatabase(
  ctx: WorkspaceContext,
  dbId: string,
): Promise<void> {
  const db = get(ctx, "databases", dbId);
  if (db.status === "deleting") fail(409, "Database is being removed");
  if (!["failed", "degraded", "unavailable"].includes(db.status))
    fail(409, "Only failed or degraded databases can be retried");
  const inventory = await nodes(ctx),
    node = inventory.find(
      (n) =>
        n.ID === db.nomad_node_id &&
        n.Meta.pc_machine_id === db.machine_id &&
        ready(n, "database"),
    );
  if (!node)
    fail(
      409,
      "The original database machine must be healthy before retrying; volumes never relocate automatically",
    );
  const uri = await ctx.open(`database:${db.id}`, db.connection_encrypted);
  db.job_encrypted = await ctx.seal(
    `database:${db.id}:job`,
    JSON.stringify(databaseJob(db, uri)),
  );
  db.status = "pending";
  db.phase = "retry";
  db.operation_started_at = now();
  db.probe_job_id = `pc-db-probe-${db.id}-${id()}`;
  db.error = null;
  save(ctx, "databases", db);
  await ctx.schedule(1);
}
export async function removeDatabase(
  ctx: WorkspaceContext,
  dbId: string,
): Promise<Doc> {
  const db = get(ctx, "databases", dbId);
  if (
    ctx.store
      .list("database_backups")
      .some(
        (b) =>
          ["queued", "provisioning", "running"].includes(b.status) &&
          (b.database_id === dbId || b.target_database_id === dbId),
      )
  )
    fail(
      409,
      "Wait for the database backup or restore to finish before removing it",
    );
  if (
    ctx.store
      .list("database_backups")
      .some(
        (b) =>
          b.database_id === dbId &&
          b.kind === "backup" &&
          ["succeeded", "expiring"].includes(b.status),
      )
  )
    fail(409, "Delete retained backup copies before removing this database");
  // Detached workloads may still be using these credentials; explicit removal preserves all disk data.
  db.status = "deleting";
  db.phase = "delete";
  save(ctx, "databases", db);
  await ctx.schedule(1);
  return { id: db.id, status: "deleting", volume_preserved: true };
}
async function observeDatabase(ctx: WorkspaceContext, db: Doc): Promise<void> {
  const allocation = await healthy(ctx, db.job_id, "postgres");
  if (!allocation) return;
  if (allocation.NodeID !== db.nomad_node_id)
    fail(409, "Database allocation moved away from its pinned volume owner");
  const svc = await endpoint(ctx, db.job_id, allocation.ID);
  if (!privateAddress(svc.Address) || svc.Port < 1 || svc.Port > 65535)
    fail(409, "Database address must stay on the private fleet network");
  const uri = new URL(
    await ctx.open(`database:${db.id}`, db.connection_encrypted),
  );
  uri.hostname = svc.Address.includes(":") ? `[${svc.Address}]` : svc.Address;
  uri.port = String(svc.Port);
  db.connection_encrypted = await ctx.seal(`database:${db.id}`, uri.toString());
  db.port = svc.Port;
  db.address = svc.Address;
  db.allocation_id = allocation.ID;
  db.job_encrypted = await ctx.seal(
    `database:${db.id}:job`,
    JSON.stringify(databaseProbe(db, uri.toString())),
  );
  db.phase = "probe_submit";
}
async function observeProbe(ctx: WorkspaceContext, db: Doc): Promise<void> {
  const list = await allocations(ctx, db.probe_job_id),
    allocation = list[0];
  if (!allocation) return;
  if (["failed", "lost"].includes(allocation.ClientStatus))
    fail(409, "PostgreSQL did not accept an authenticated query");
  if (allocation.ClientStatus !== "complete") return;
  const detail = await ctx.requestNomad(
    "GET",
    `/v1/allocation/${allocation.ID}`,
  );
  if (detail.TaskStates?.probe?.Failed === true)
    fail(409, "PostgreSQL authentication probe failed");
  const log = await logs(ctx, allocation.ID, "probe", "stdout");
  if (!log.split("\n").some((line) => line.trim() === "1"))
    fail(
      409,
      "PostgreSQL did not return the expected authenticated query result",
    );
  db.status = "healthy";
  db.phase = "probe_cleanup";
  db.error = null;
  db.last_verified_at = now();
  ctx.event(
    "database.healthy",
    `${db.name} accepted an authenticated database query`,
  );
}
async function remove(ctx: WorkspaceContext, db: Doc): Promise<void> {
  await stopJob(ctx, db.job_id);
  if (db.probe_job_id) await stopJob(ctx, db.probe_job_id);
  ctx.store.transaction(() => {
    // Preserve the encrypted credentials and exact disk/node ownership for explicit recovery.
    ctx.store.put("retained_volumes", db.id, {
      ...db,
      status: "retained",
      phase: undefined,
      job_encrypted: undefined,
      deleted_at: now(),
    });
    for (const binding of ctx.store
      .list("bindings")
      .filter((b) => b.database_id === db.id))
      ctx.store.delete("bindings", binding.service_id);
    ctx.store.delete("backup_policies", db.id);
    ctx.store.delete("databases", db.id);
    ctx.event(
      "database.removed",
      `${db.name} stopped; volume ${db.volume_name} retained on its original machine`,
    );
  });
  ctx.broadcast();
}
export async function reconcileDatabase(
  ctx: WorkspaceContext,
  db: Doc,
): Promise<void> {
  try {
    if (
      db.status === "pending" &&
      Date.now() - Date.parse(db.operation_started_at) > 300000
    )
      fail(
        409,
        "Database health verification exceeded its deadline; volume preserved",
      );
    switch (db.phase) {
      case "submit":
        await ensureJob(
          ctx,
          JSON.parse(await ctx.open(`database:${db.id}:job`, db.job_encrypted)),
        );
        db.phase = "observe";
        break;
      case "retry":
        await ensureJob(
          ctx,
          JSON.parse(await ctx.open(`database:${db.id}:job`, db.job_encrypted)),
        );
        await ctx.requestNomad("POST", `/v1/job/${db.job_id}/evaluate`, {
          JobID: db.job_id,
          EvalOptions: { ForceReschedule: true },
        });
        db.phase = "observe";
        break;
      case "observe":
        await observeDatabase(ctx, db);
        break;
      case "probe_submit":
        await ensureJob(
          ctx,
          JSON.parse(await ctx.open(`database:${db.id}:job`, db.job_encrypted)),
        );
        db.phase = "probe_observe";
        break;
      case "probe_observe":
        await observeProbe(ctx, db);
        break;
      case "probe_cleanup":
        await stopJob(ctx, db.probe_job_id);
        delete db.job_encrypted;
        db.phase = "ready";
        break;
      case "delete":
        await remove(ctx, db);
        return;
      case "ready": {
        const allocation = await healthy(ctx, db.job_id, "postgres");
        if (!allocation || allocation.NodeID !== db.nomad_node_id) {
          db.status = "degraded";
          db.error =
            "Database is unavailable on its original machine; persistent volume preserved";
        } else if (
          db.status !== "healthy" ||
          allocation.ID !== db.allocation_id
        ) {
          db.status = "pending";
          db.phase = "observe";
          db.operation_started_at = now();
          db.probe_job_id = `pc-db-probe-${db.id}-${id()}`;
        }
        break;
      }
    }
    if (
      !ctx.store.get("databases", db.id) ||
      (ctx.store.get("databases", db.id)?.phase === "delete" &&
        db.phase !== "delete")
    )
      return;
    save(ctx, "databases", db);
  } catch (error) {
    if (pending(error)) return;
    if (
      !ctx.store.get("databases", db.id) ||
      (ctx.store.get("databases", db.id)?.phase === "delete" &&
        db.phase !== "delete")
    )
      return;
    if (db.phase === "delete" || db.phase === "probe_cleanup") {
      db.error = safeError(error);
      save(ctx, "databases", db);
      return;
    }
    if (
      code(error) >= 500 &&
      Date.now() - Date.parse(db.operation_started_at) < 300000
    )
      return;
    db.status = db.phase === "ready" ? "degraded" : "failed";
    db.error = safeError(error);
    if (db.status === "failed") db.phase = "failed";
    save(ctx, "databases", db);
  }
}
