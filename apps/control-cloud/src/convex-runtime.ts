import { fail, now, text, type Doc, type WorkspaceContext } from "./core";

/** Observe an existing pinned backend without rewriting or restarting its job. */
export async function observeConvexRuntime(
  ctx: WorkspaceContext,
  jobId: unknown,
): Promise<Doc> {
  const id = text(jobId, 180);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id))
    fail(400, "Enter a valid fleet job ID");
  const job = await ctx.requestNomad(
    "GET",
    `/v1/job/${encodeURIComponent(id)}`,
  );
  const groups = job.TaskGroups ?? [];
  const candidates = groups.flatMap((group: Doc) =>
    (group.Tasks ?? [])
      .filter(
        (task: Doc) =>
          task.Driver === "docker" &&
          /^ghcr\.io\/get-convex\/convex-backend(?:[:@])/.test(
            task.Config?.image ?? "",
          ),
      )
      .map((task: Doc) => ({ group, task })),
  );
  if (candidates.length !== 1)
    fail(400, "Choose a job with one official Convex backend task");
  const { group, task } = candidates[0];
  const pins = [
    ...(job.Constraints ?? []),
    ...(group.Constraints ?? []),
    ...(task.Constraints ?? []),
  ].filter((c: Doc) => c.LTarget === "${node.unique.id}" && c.Operand === "=");
  if (
    pins.length !== 1 ||
    group.Count !== 1 ||
    group.ReschedulePolicy?.Attempts !== 0 ||
    group.ReschedulePolicy?.Unlimited !== false
  )
    fail(
      409,
      "The backend must have one instance pinned to one node with relocation disabled",
    );
  const node = await ctx.requestNomad(
    "GET",
    `/v1/node/${encodeURIComponent(pins[0].RTarget)}`,
  );
  const machine = ctx.store.get("machines", node.Meta?.pc_machine_id ?? "");
  if (!machine) fail(403, "The backend machine is not in this workspace");
  const mount = (task.Config?.volumes ?? []).find(
    (v: unknown) =>
      typeof v === "string" && /^\/[^:]+:\/convex\/data(?::rw)?$/.test(v),
  );
  if (!mount)
    fail(409, "Convex data must use an absolute persistent host path");
  const allocs = await ctx.requestNomad(
    "GET",
    `/v1/job/${encodeURIComponent(id)}/allocations`,
  );
  if (!Array.isArray(allocs)) fail(502, "Runtime omitted allocations");
  const current = allocs
    .filter((a: Doc) => a.NodeID === node.ID && a.DesiredStatus === "run")
    .sort((a: Doc, b: Doc) => (b.CreateIndex ?? 0) - (a.CreateIndex ?? 0))[0];
  return {
    job_id: id,
    machine_id: machine.id,
    node_id: node.ID,
    image: task.Config.image,
    data_path: mount.split(":")[0],
    status: job.Stop ? "stopped" : (current?.ClientStatus ?? "unavailable"),
    allocation_id: current?.ID ?? null,
    checked_at: now(),
  };
}
