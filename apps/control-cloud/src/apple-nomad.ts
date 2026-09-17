import { type Doc, type WorkspaceContext, now, fail } from "./core";
import { allocations, ensureJob, pending, stopJob } from "./runtime/common";
export function appleNode(node: Doc): boolean {
  return (
    node.Status === "ready" &&
    node.SchedulingEligibility === "eligible" &&
    !node.Drain &&
    node.Attributes?.["kernel.name"] === "darwin" &&
    node.Drivers?.raw_exec?.Healthy === true &&
    node.Meta?.pc_apple === "true"
  );
}
export function appleNomadJob(job: Doc, node: Doc, api: string): Doc {
  const meta = node.Meta;
  for (const k of ["pc_apple_agent", "pc_apple_state", "pc_apple_work"])
    if (
      typeof meta?.[k] !== "string" ||
      !meta[k].startsWith("/") ||
      /[\r\n\0]/.test(meta[k])
    )
      fail(409, "Mac Nomad helper is not configured");
  return {
    Job: {
      ID: job.nomad_job_id,
      Name: job.nomad_job_id,
      Type: "batch",
      Datacenters: [node.Datacenter || "dc1"],
      Meta: { pc_managed: "true", pc_apple_job: job.id },
      Constraints: [
        { LTarget: "${node.unique.id}", Operand: "=", RTarget: node.ID },
        { LTarget: "${attr.kernel.name}", Operand: "=", RTarget: "darwin" },
      ],
      TaskGroups: [
        {
          Name: "apple",
          Count: 1,
          RestartPolicy: { Attempts: 0, Mode: "fail" },
          ReschedulePolicy: { Attempts: 0, Unlimited: false },
          Networks: [
            {
              Mode: "host",
              ReservedPorts: [{ Label: "apple_slot", Value: 49999 }],
            },
          ],
          Tasks: [
            {
              Name: "apple",
              Driver: "raw_exec",
              Config: {
                command: meta.pc_apple_agent,
                args: [
                  "--api",
                  api,
                  "--state",
                  meta.pc_apple_state,
                  "--apple-work-dir",
                  meta.pc_apple_work,
                  "--apple-run",
                  job.id,
                  "--apple-attempt",
                  job.attempt,
                ],
              },
              Resources: { CPU: 2000, MemoryMB: 4096 },
              KillTimeout: 30000000000,
              LogConfig: { MaxFiles: 2, MaxFileSizeMB: 5 },
            },
          ],
        },
      ],
    },
  };
}
export async function reconcileAppleJobs(ctx: WorkspaceContext) {
  for (const original of ctx.store.list("apple_jobs")) {
    if (!["queued", "running", "cancelling"].includes(original.status))
      continue;
    try {
      if (!original.nomad_job_id) {
        ctx.store.put("apple_jobs", original.id, {
          ...original,
          status: "interrupted",
          finished_at: now(),
          error: "Legacy direct worker retired. Submit this job through Nomad.",
        });
        continue;
      }
      if (original.status === "cancelling") {
        await stopJob(ctx, original.nomad_job_id);
        const current = ctx.store.get("apple_jobs", original.id)!;
        ctx.store.put("apple_jobs", original.id, {
          ...current,
          status: "cancelled",
          finished_at: now(),
        });
        continue;
      }
      if (original.status === "queued") {
        await ensureJob(ctx, original.nomad_spec);
      }
      const list = await allocations(ctx, original.nomad_job_id);
      const alloc = list[0];
      if (!alloc) continue;
      const current = ctx.store.get("apple_jobs", original.id)!;
      if (!["queued", "running"].includes(current.status)) continue;
      if (["failed", "lost", "complete"].includes(alloc.ClientStatus)) {
        const result = current.result_status;
        ctx.store.put("apple_jobs", original.id, {
          ...current,
          allocation_id: alloc.ID,
          status:
            alloc.ClientStatus === "complete" && result
              ? result
              : alloc.ClientStatus === "failed"
                ? ["failed", "timed_out", "cancelled"].includes(result)
                  ? result
                  : "failed"
                : "interrupted",
          finished_at: now(),
          ...(!result
            ? {
                error:
                  "Nomad allocation ended without a complete result. Inspect the Mac and allocation logs.",
              }
            : {}),
        });
      } else if (alloc.ClientStatus === "running")
        ctx.store.put("apple_jobs", original.id, {
          ...current,
          allocation_id: alloc.ID,
          status: "running",
          started_at: current.started_at ?? now(),
        });
    } catch (e) {
      if (!pending(e))
        console.error("Apple Nomad reconciliation pending", original.id);
    }
  }
}
