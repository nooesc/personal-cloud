import { providerEnvironment } from "../database-providers";
import { fail, now, type Doc, type WorkspaceContext } from "../core";
import { redact } from "./jobs";
export const ACTIVE = ["queued", "building", "deploying"];
export function get(
  ctx: WorkspaceContext,
  collection: string,
  id: string,
): Doc {
  return (
    ctx.store.get(collection, id) ??
    fail(404, `${collection.replace(/s$/, "")} not found`)
  );
}
export function save(
  ctx: WorkspaceContext,
  collection: string,
  value: Doc,
): void {
  ctx.store.put(collection, value.id, { ...value, updated_at: now() });
  ctx.broadcast();
}
export function pending(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "pending" in error && error.pending,
  );
}
export function code(error: unknown): number {
  return Number((error as { status?: number })?.status ?? 500);
}
export function safeError(error: unknown): string {
  // Upstream bodies can contain env values. Only our deliberate validation errors reach activity.
  if (code(error) >= 400 && code(error) < 500)
    return String((error as Error).message).slice(0, 400);
  return "Runtime request failed; verify the selected machine and scheduler connection";
}
export async function nodes(ctx: WorkspaceContext): Promise<Doc[]> {
  const stubs = await ctx.requestNomad("GET", "/v1/nodes");
  if (!Array.isArray(stubs)) fail(502, "Invalid scheduler node inventory");
  // Fan out node details so a fleet check does not wait for one agent polling
  // round-trip per node. All requests remain workspace-scoped by requestNomad.
  if (stubs.length > 1000)
    fail(502, "Scheduler node inventory exceeds the supported limit");
  const result: Doc[] = new Array(stubs.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, stubs.length) }, async () => {
      while (cursor < stubs.length) {
        const index = cursor++,
          stub = stubs[index];
        if (typeof stub.ID !== "string")
          fail(502, "Invalid scheduler node identity");
        result[index] = await ctx.requestNomad(
          "GET",
          `/v1/node/${encodeURIComponent(stub.ID)}`,
        );
      }
    }),
  );
  return result.filter((node) =>
    ctx.store.get("machines", node.Meta?.pc_machine_id),
  );
}
export async function allocations(
  ctx: WorkspaceContext,
  job: string,
): Promise<Doc[]> {
  const response = await ctx.requestNomad(
    "GET",
    `/v1/job/${encodeURIComponent(job)}/allocations`,
  );
  return Array.isArray(response)
    ? response.sort((a, b) => (b.CreateIndex ?? 0) - (a.CreateIndex ?? 0))
    : [];
}
export async function ensureJob(
  ctx: WorkspaceContext,
  job: Doc,
): Promise<void> {
  try {
    const existing = await ctx.requestNomad(
      "GET",
      `/v1/job/${encodeURIComponent(job.Job.ID)}`,
    );
    if (existing.ID === job.Job.ID && !existing.Stop) return;
  } catch (error) {
    if (code(error) !== 404) throw error;
  }
  await ctx.requestNomad("POST", "/v1/jobs", job);
}
export async function stopJob(
  ctx: WorkspaceContext,
  job: string,
): Promise<void> {
  let operation = ctx.store.get("runtime_stops", job);
  if (!operation) {
    let list: Doc[] = [];
    try {
      list = await allocations(ctx, job);
    } catch (error) {
      if (code(error) !== 404) throw error;
    }
    operation = { id: job, allocations: list.map((a) => a.ID), phase: "stop" };
    ctx.store.put("runtime_stops", job, operation);
  }
  if (operation.phase === "done") return;
  if (operation.phase === "stop") {
    try {
      await ctx.requestNomad(
        "DELETE",
        `/v1/job/${encodeURIComponent(job)}?purge=true`,
      );
    } catch (error) {
      if (code(error) !== 404) throw error;
    }
    operation.phase = "observe";
    ctx.store.put("runtime_stops", job, operation);
  }
  // Purging a job registration is not proof its Docker tasks have exited. Observe the
  // allocations captured before deletion even if Nomad no longer lists the job.
  for (const allocation of operation.allocations) {
    try {
      const detail = await ctx.requestNomad(
        "GET",
        `/v1/allocation/${allocation}`,
      );
      if (["running", "pending"].includes(detail.ClientStatus)) {
        const error = new Error("Waiting for workload shutdown") as Error & {
          pending: boolean;
        };
        error.pending = true;
        throw error;
      }
    } catch (error) {
      if (code(error) !== 404) throw error;
    }
  }
  operation.phase = "done";
  ctx.store.put("runtime_stops", job, operation);
}
export async function healthy(
  ctx: WorkspaceContext,
  job: string,
  task: string,
): Promise<Doc | undefined> {
  for (const allocation of await allocations(ctx, job)) {
    if (
      allocation.DesiredStatus === "stop" ||
      allocation.ClientStatus !== "running"
    )
      continue;
    const detail = await ctx.requestNomad(
      "GET",
      `/v1/allocation/${allocation.ID}`,
    );
    if (detail.TaskStates?.[task]?.State !== "running") continue;
    const checks = await ctx.requestNomad(
      "GET",
      `/v1/client/allocation/${allocation.ID}/checks`,
    );
    const values = Object.values(checks) as Doc[];
    if (values.length && values.every((c) => c.Status === "success"))
      return detail;
  }
  return undefined;
}
export async function endpoint(
  ctx: WorkspaceContext,
  job: string,
  allocation: string,
): Promise<Doc> {
  const list = await ctx.requestNomad("GET", `/v1/job/${job}/services`);
  const service = Array.isArray(list)
    ? list.find((s) => s.AllocID === allocation)
    : undefined;
  if (!service || !service.Address || !Number.isInteger(service.Port))
    fail(409, "Healthy allocation has no registered address");
  return service;
}
export async function logs(
  ctx: WorkspaceContext,
  allocation: string,
  task: string,
  stream: string,
): Promise<string> {
  const result = await ctx.requestNomad(
    "GET",
    `/v1/client/fs/logs/${allocation}?task=${task}&type=${stream}&plain=true&origin=end&offset=65536`,
  );
  return typeof result.raw === "string" ? result.raw : "";
}
export async function environment(
  ctx: WorkspaceContext,
  project: string,
  service: string,
  requireHealthy = true,
): Promise<Doc> {
  const result: Doc = {};
  for (const row of ctx.store
    .list("environment")
    .filter((v) => v.project_id === project))
    result[row.key] = await ctx.open(
      `env:${project}:${row.key}`,
      row.value_encrypted,
    );
  const binding = ctx.store.get("bindings", service);
  if (binding) {
    const db = get(ctx, "databases", binding.database_id);
    if (requireHealthy && db.status !== "healthy")
      fail(
        409,
        "Attached database is not healthy; restore it before deploying",
      );
    result.DATABASE_URL = await ctx.open(
      `database:${db.id}`,
      db.connection_encrypted,
    );
  }
  const external = await providerEnvironment(ctx, service);
  for (const [key, value] of Object.entries(external)) {
    if (key in result && result[key] !== value) fail(409, `Remove the conflicting ${key} project variable or database binding before deploying`);
    result[key] = value;
  }
  return result;
}
export function step(
  ctx: WorkspaceContext,
  d: Doc,
  name: string,
  message: string,
): void {
  const values = d.steps ?? [];
  values.push({
    id: values.length + 1,
    deployment_id: d.id,
    step: name,
    message: message.slice(0, 2000),
    created_at: now(),
  });
  d.steps = values.slice(-250);
  d.step = name;
}
export async function secretValues(
  ctx: WorkspaceContext,
  d: Doc,
): Promise<string[]> {
  const value = d.secrets_encrypted
    ? JSON.parse(
        await ctx.open(`deployment:${d.id}:secrets`, d.secrets_encrypted),
      )
    : {};
  return Object.values(value).filter((v): v is string => typeof v === "string");
}
export async function redactBuildLogs(
  ctx: WorkspaceContext,
  d: Doc,
  stdout: string,
  stderr: string,
): Promise<void> {
  const secrets = await secretValues(ctx, d),
    seen = new Set<string>(d.log_seen ?? []);
  for (const line of `${stdout}\n${stderr}`.split("\n")) {
    if (
      !line ||
      line.startsWith("PC_IMAGE=") ||
      seen.has(line) ||
      seen.size >= 500
    )
      continue;
    // Store only redacted fingerprints, never raw lines which may contain source tokens.
    const clean = redact(line, secrets).slice(0, 2000);
    if (seen.has(clean)) continue;
    seen.add(clean);
    const match = /^PC_STEP=([^ ]+) (.*)/.exec(clean);
    step(ctx, d, match?.[1] ?? "log", match?.[2] ?? clean);
  }
  d.log_seen = [...seen];
}
export function publicDeployment(d: Doc): Doc {
  const {
    job_encrypted,
    secrets_encrypted,
    log_seen,
    config_encrypted,
    service_snapshot,
    project_snapshot,
    ...safe
  } = d;
  return safe;
}
export function publicDatabase(d: Doc): Doc {
  const { connection_encrypted, job_encrypted, ...safe } = d;
  return d.restore_id && d.restore_status !== "succeeded"
    ? {
        ...safe,
        status: d.restore_status === "failed" ? "restore_failed" : "restoring",
        error:
          d.restore_error ??
          "Restore destination is not available until restoration succeeds",
      }
    : safe;
}
