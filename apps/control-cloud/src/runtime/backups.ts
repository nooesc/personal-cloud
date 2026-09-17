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
} from "../core";
import { equal, sha256, token } from "../crypto";
import { allocations, ensureJob, get, pending, save, stopJob } from "./common";
import { createDatabase } from "./database";
import { BACKUP_MAX, backupJob } from "./backup-jobs";
const ACTIVE = new Set(["queued", "provisioning", "running"]);
function visible(b: Doc): Doc {
  const { token_hash, job_encrypted, object_key, ...safe } = b;
  return safe;
}
function busy(ctx: WorkspaceContext, database: string): boolean {
  return ctx.store
    .list("database_backups")
    .some((b) => b.database_id === database && ACTIVE.has(b.status));
}
export function backupPolicy(input: Doc): Doc {
  if (
    typeof input.enabled !== "boolean" ||
    !Number.isInteger(input.keep) ||
    input.keep < 1 ||
    input.keep > 30
  )
    fail(
      400,
      "Choose daily backups and retain between 1 and 30 successful copies",
    );
  return { enabled: input.enabled, keep: input.keep };
}
async function queue(ctx: WorkspaceContext, db: Doc): Promise<Doc> {
  if (
    db.restore_id &&
    ctx.store.get("database_backups", db.restore_id)?.status !== "succeeded"
  )
    fail(409, "Restore must succeed before backing up this database");
  if (db.status !== "healthy" || db.phase !== "ready")
    fail(409, "Database must be healthy before backing up");
  if (busy(ctx, db.id))
    fail(409, "A database backup or restore is already active");
  const b: Doc = {
    id: id(),
    kind: "backup",
    database_id: db.id,
    project_id: db.project_id,
    machine_id: db.machine_id,
    status: "queued",
    created_at: now(),
    deadline: Date.now() + 1800000,
  };
  // Reserve synchronously before any credential or scheduler I/O.
  save(ctx, "database_backups", b);
  await ctx.schedule(1);
  return visible(b);
}
export async function handleBackups(
  request: Request,
  ctx: WorkspaceContext,
): Promise<Response | null> {
  const path = new URL(request.url).pathname,
    method = request.method;
  const transfer = path.match(
    /^\/api\/agent\/([^/]+)\/database-backups\/([^/]+)\/data$/,
  );
  if (transfer) {
    const b = get(ctx, "database_backups", transfer[2]);
    if (
      b.machine_id !== transfer[1] ||
      !b.token_hash ||
      !equal(
        b.token_hash,
        await sha256(
          request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "",
        ),
      )
    )
      fail(403, "Invalid backup transfer credential");
    if (b.deadline < Date.now() || b.status !== "running")
      fail(409, "Backup transfer has expired");
    if (b.kind === "backup" && method === "PUT") {
      const size = Number(request.headers.get("Content-Length")),
        digest = request.headers.get("x-backup-sha256") ?? "";
      if (
        !Number.isInteger(size) ||
        size < 1 ||
        size > BACKUP_MAX ||
        !request.body
      )
        fail(413, "Backups currently support dumps up to 100 MiB");
      if (!/^[a-f0-9]{64}$/.test(digest))
        fail(400, "A SHA-256 checksum is required");
      if (b.checksum) {
        if (b.checksum !== digest || b.size !== size)
          fail(409, "Backup data is immutable");
        return json({ ok: true });
      }
      // R2 verifies the supplied digest before acknowledging the object.
      const stream = new FixedLengthStream(size);
      const [object] = await Promise.all([
        ctx.env.ARTIFACTS.put(b.object_key, stream.readable, {
          sha256: digest,
          onlyIf: { etagDoesNotMatch: "*" },
          customMetadata: {
            workspace: ctx.workspaceId,
            database: b.database_id,
          },
        }),
        request.body.pipeTo(stream.writable),
      ]);
      const persisted = object ?? (await ctx.env.ARTIFACTS.head(b.object_key));
      if (
        !persisted?.checksums.sha256 ||
        persisted.size !== size ||
        [...new Uint8Array(persisted.checksums.sha256)]
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("") !== digest
      )
        fail(409, "Backup object does not match this upload");
      const current = get(ctx, "database_backups", b.id);
      if (current.status !== "running") {
        if (current.status === "succeeded" && current.checksum === digest)
          return json({ ok: true });
        save(ctx, "database_backups", { ...current, cleanup_pending: true });
        await ctx.schedule(1);
        fail(409, "Backup is no longer running");
      }
      save(ctx, "database_backups", {
        ...current,
        checksum: digest,
        size: persisted.size,
      });
      return json({ ok: true });
    }
    if (b.kind === "restore" && method === "GET") {
      const object = await ctx.env.ARTIFACTS.get(b.object_key);
      if (!object) fail(404, "Backup object is missing");
      return new Response(object.body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
          "Content-Length": String(object.size),
        },
      });
    }
    fail(405, "Transfer method is not allowed");
  }
  const route = path.match(
    /^\/api\/databases\/([^/]+)\/backups(?:\/(policy|[^/]+)(?:\/(restore))?)?$/,
  );
  if (!route) return null;
  requireUser(ctx);
  const db =
    ctx.store.get("databases", route[1]) ??
    ctx.store.get("retained_volumes", route[1]) ??
    fail(404, "Database not found");
  if (!route[2] && method === "GET")
    return json({
      policy: ctx.store.get("backup_policies", db.id) ?? {
        enabled: false,
        keep: 7,
      },
      backups: ctx.store
        .list("database_backups")
        .filter((b) => b.database_id === db.id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(visible),
    });
  if (!route[2] && method === "POST") return json(await queue(ctx, db), 202);
  if (route[2] === "policy" && method === "PUT") {
    const policy = backupPolicy(await body(request));
    ctx.store.put("backup_policies", db.id, {
      id: db.id,
      ...policy,
      next_at: Date.now(),
      updated_at: now(),
    });
    await ctx.schedule(1);
    return json({ ok: true });
  }
  if (route[2] && route[2] !== "policy" && !route[3] && method === "DELETE") {
    const source = get(ctx, "database_backups", route[2]);
    if (
      source.database_id !== db.id ||
      source.kind !== "backup" ||
      ACTIVE.has(source.status)
    )
      fail(409, "Choose a completed backup");
    if (
      ctx.store
        .list("database_backups")
        .some((b) => b.source_backup_id === source.id && ACTIVE.has(b.status))
    )
      fail(409, "Backup is being restored");
    save(ctx, "database_backups", { ...source, status: "expiring" });
    await ctx.schedule(1);
    return json({ ok: true }, 202);
  }
  if (route[3] === "restore" && method === "POST") {
    const input = await body(request),
      source = get(ctx, "database_backups", route[2]);
    if (
      source.database_id !== db.id ||
      source.kind !== "backup" ||
      source.status !== "succeeded"
    )
      fail(409, "Choose a successful backup of this database");
    if (busy(ctx, db.id)) fail(409, "A backup or restore is already active");
    const b: Doc = {
      id: id(),
      kind: "restore",
      database_id: db.id,
      project_id: db.project_id,
      source_backup_id: source.id,
      object_key: source.object_key,
      checksum: source.checksum,
      target_database_id: id(),
      target_name: text(input.name, 80),
      machine_id: input.machine_id ? text(input.machine_id, 80) : db.machine_id,
      status: "provisioning",
      created_at: now(),
      deadline: Date.now() + 1800000,
    };
    save(ctx, "database_backups", b);
    await ctx.schedule(1);
    return json(visible(b), 202);
  }
  fail(405, "Unsupported backup action");
}
export async function reconcileBackups(ctx: WorkspaceContext): Promise<void> {
  for (const policy of ctx.store.list("backup_policies")) {
    if (!policy.enabled || policy.next_at > Date.now()) continue;
    const db = ctx.store.get("databases", policy.id);
    if (!db) continue;
    if (busy(ctx, db.id)) continue;
    try {
      await queue(ctx, db);
      ctx.store.put("backup_policies", policy.id, {
        ...get(ctx, "backup_policies", policy.id),
        next_at: Date.now() + 86400000,
        error: null,
      });
    } catch (error) {
      ctx.store.put("backup_policies", policy.id, {
        ...get(ctx, "backup_policies", policy.id),
        next_at: Date.now() + 3600000,
        error: "Scheduled backup could not start; database must be healthy",
      });
    }
  }
  for (let b of ctx.store
    .list("database_backups")
    .filter((b) => ACTIVE.has(b.status) || b.cleanup_pending)) {
    try {
      if (b.cleanup_pending) {
        const revision = b.updated_at;
        await stopJob(ctx, b.job_id);
        if (
          b.kind === "backup" &&
          ["failed", "expired", "expiring"].includes(b.status) &&
          b.object_key
        )
          await ctx.env.ARTIFACTS.delete(b.object_key);
        b = get(ctx, "database_backups", b.id);
        if (b.updated_at !== revision) continue;
        delete b.job_encrypted;
        delete b.token_hash;
        b.cleanup_pending = false;
        save(ctx, "database_backups", b);
        continue;
      }
      if (Date.now() > b.deadline)
        fail(409, "Backup operation exceeded its 30-minute deadline");
      if (
        b.status === "provisioning" &&
        !ctx.store.get("databases", b.target_database_id)
      ) {
        await createDatabase(
          ctx,
          {
            project_id: b.project_id,
            name: b.target_name,
            machine_id: b.machine_id,
          },
          b.target_database_id,
          b.id,
        );
        continue;
      }
      const db = get(
        ctx,
        "databases",
        b.kind === "restore" ? b.target_database_id : b.database_id,
      );
      if (b.status === "provisioning") {
        // Destination is isolated and never attached to a service automatically.
        if (db.status === "failed")
          fail(409, "Restore destination failed to become healthy");
        if (db.status !== "healthy" || db.phase !== "ready") continue;
        b.status = "queued";
      }
      if (b.status === "queued") {
        if (db.status !== "healthy" || db.phase !== "ready")
          fail(409, "Database is no longer healthy");
        const credential = token();
        b.job_id = `pc-backup-${b.id}`;
        b.object_key ??= `database-backups/${ctx.workspaceId}/${b.database_id}/${b.id}.dump`;
        b.machine_id = db.machine_id;
        const endpoint = `${ctx.env.PUBLIC_URL}/api/agent/${b.machine_id}/database-backups/${b.id}/data`;
        b.token_hash = await sha256(credential);
        b.job_encrypted = await ctx.seal(
          `backup:${b.id}`,
          JSON.stringify(
            backupJob(
              db,
              b,
              await ctx.open(`database:${db.id}`, db.connection_encrypted),
              endpoint,
              credential,
            ),
          ),
        );
        b.status = "running";
        save(ctx, "database_backups", b);
      }
      await ensureJob(
        ctx,
        JSON.parse(await ctx.open(`backup:${b.id}`, b.job_encrypted)),
      );
      const allocation = (await allocations(ctx, b.job_id))[0];
      if (!allocation) continue;
      if (allocation.NodeID !== db.nomad_node_id)
        fail(409, "Backup task did not run on its selected machine");
      if (["failed", "lost"].includes(allocation.ClientStatus))
        fail(
          409,
          "Database backup task failed; source database was not changed",
        );
      if (allocation.ClientStatus !== "complete") continue;
      const detail = await ctx.requestNomad(
        "GET",
        `/v1/allocation/${allocation.ID}`,
      );
      if (
        !["postgres", "transfer"].every(
          (name) =>
            detail.TaskStates?.[name]?.State === "dead" &&
            detail.TaskStates[name].Failed === false,
        )
      )
        fail(409, "Backup tasks did not finish successfully");
      b = get(ctx, "database_backups", b.id); // transfer may have persisted checksum during scheduler I/O
      const object = await ctx.env.ARTIFACTS.head(b.object_key);
      if (!object || !object.checksums.sha256)
        fail(409, "Backup object or verified checksum is missing");
      const digest = [...new Uint8Array(object.checksums.sha256)]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("");
      if (b.checksum && digest !== b.checksum)
        fail(409, "Backup checksum does not match");
      b.checksum = digest;
      b.size = object.size;
      if (b.kind === "restore")
        save(ctx, "databases", {
          ...get(ctx, "databases", b.target_database_id),
          restore_status: "succeeded",
          restore_error: null,
        });
      b.status = "succeeded";
      b.finished_at = now();
      b.cleanup_pending = true;
      save(ctx, "database_backups", b);
      ctx.event(
        `database.${b.kind}.succeeded`,
        b.kind === "restore"
          ? "Backup restored successfully into a separate database"
          : "PostgreSQL backup stored and verified in private R2 storage",
      );
    } catch (error) {
      if (pending(error)) continue;
      if (b.cleanup_pending) continue; // Cleanup failure must not downgrade a completed restore.
      b = {
        ...get(ctx, "database_backups", b.id),
        status: "failed",
        finished_at: now(),
        error:
          error instanceof Error && (error as Doc).status === 409
            ? error.message
            : "Backup operation failed; check machine and storage connectivity",
        cleanup_pending: Boolean(b.job_id),
      };
      if (
        b.kind === "restore" &&
        ctx.store.get("databases", b.target_database_id)
      )
        save(ctx, "databases", {
          ...get(ctx, "databases", b.target_database_id),
          restore_status: "failed",
          restore_error: b.error,
        });
      save(ctx, "database_backups", b);
    }
  }
  // Retention never deletes a backup in use by an active restore.
  for (const policy of ctx.store.list("backup_policies")) {
    const copies = ctx.store
      .list("database_backups")
      .filter(
        (b) =>
          b.database_id === policy.id &&
          b.kind === "backup" &&
          b.status === "succeeded",
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    for (const old of copies.slice(policy.keep)) {
      if (
        ctx.store
          .list("database_backups")
          .some((b) => b.source_backup_id === old.id && ACTIVE.has(b.status))
      )
        continue;
      save(ctx, "database_backups", { ...old, status: "expiring" });
    }
  }
  for (const old of ctx.store
    .list("database_backups")
    .filter((b) => b.status === "expiring")) {
    try {
      await ctx.env.ARTIFACTS.delete(old.object_key);
      save(ctx, "database_backups", { ...old, status: "expired" });
    } catch {
      /* Retry deletion on the next alarm. */
    }
  }
  if (
    ctx.store
      .list("database_backups")
      .some(
        (b) =>
          ACTIVE.has(b.status) || b.cleanup_pending || b.status === "expiring",
      ) ||
    ctx.store.list("backup_policies").some((p) => p.enabled)
  )
    await ctx.schedule(15000);
}
