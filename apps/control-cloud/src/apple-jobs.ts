import { appleNode, appleNomadJob } from "./apple-nomad";
import { nodes } from "./runtime/common";
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
import { authenticateMachine } from "./fleet";
import { connected } from "./readiness";
import { sourceToken, githubRequest } from "./github";
import { token, equal } from "./crypto";
const ACTIVE = new Set(["queued", "running", "cancelling"]);
const ARTIFACT_MAX = 100 * 1024 * 1024;
export function appleReady(machine: Doc | undefined): boolean {
  return Boolean(
    machine &&
    connected(machine) &&
    machine.report?.apple?.enabled === true &&
    machine.report.apple.xcode &&
    machine.report.apple.simulators?.length,
  );
}
export function validateAppleJob(input: Doc): Doc {
  const scheme = text(input.scheme, 128),
    container = text(input.container, 512);
  if (scheme.startsWith("-") || /[\r\n\0]/.test(scheme))
    fail(400, "Invalid Xcode scheme");
  if (
    container.startsWith("/") ||
    container.split("/").some((p) => !p || p === "." || p === "..") ||
    !/\.(xcworkspace|xcodeproj)$/.test(container) ||
    /[\r\n\0]/.test(container)
  )
    fail(400, "Use a repository-relative .xcworkspace or .xcodeproj path");
  if (!/^[a-f0-9]{40}$/i.test(input.commit ?? ""))
    fail(400, "Use the full 40-character Git commit SHA");
  if (!["build", "test"].includes(input.action))
    fail(400, "Choose build or test");
  const timeout = input.timeout_seconds ?? 1800;
  if (!Number.isInteger(timeout) || timeout < 60 || timeout > 3600)
    fail(400, "Timeout must be 60–3600 seconds");
  return {
    scheme,
    container,
    commit: input.commit.toLowerCase(),
    action: input.action,
    timeout_seconds: timeout,
    simulator: text(input.simulator, 128),
  };
}
function visible(job: Doc) {
  const { attempt, artifact_key, nomad_spec, ...result } = job;
  return { ...result, has_artifact: Boolean(artifact_key) };
}
export async function handleAppleJobs(
  request: Request,
  ctx: WorkspaceContext,
): Promise<Response | null> {
  const path = new URL(request.url).pathname,
    method = request.method;
  const agent = path.match(
    /^\/api\/agent\/([^/]+)\/apple-jobs(?:\/([^/]+))?(?:\/(artifact|start))?$/,
  );
  const project = path.match(
    /^\/api\/projects\/([^/]+)\/apple-jobs(?:\/([^/]+))?(?:\/(artifact))?$/,
  );
  if (!agent && !project) return null;
  if (agent) {
    await authenticateMachine(request, ctx, agent[1]);

    if (!agent[2])
      fail(
        410,
        "Direct Apple claiming was removed; jobs are scheduled by Nomad",
      );
    const job = ctx.store.get("apple_jobs", agent[2]);
    if (!job || job.machine_id !== agent[1]) fail(404, "Apple job not found");
    const attempt = request.headers.get("x-apple-attempt") ?? "";
    if (!job.attempt || !equal(attempt, job.attempt))
      fail(403, "Wrong job attempt");
    if (method === "POST" && agent[3] === "start") {
      if (!job.nomad_job_id || !["queued", "running"].includes(job.status))
        fail(409, "Job is not runnable");
      const input = await body(request);
      if (!/^[a-f0-9-]{36}$/.test(input.allocation_id ?? ""))
        fail(400, "Nomad allocation required");
      const allocation = await ctx.requestNomad(
        "GET",
        `/v1/allocation/${input.allocation_id}`,
      );
      if (
        allocation.JobID !== job.nomad_job_id ||
        allocation.NodeID !== job.node_id ||
        allocation.DesiredStatus !== "run"
      )
        fail(403, "Allocation does not own this job");
      if (allocation.ClientStatus !== "running")
        fail(409, "Waiting for Nomad allocation to start");
      const current = ctx.store.get("apple_jobs", job.id)!;
      if (
        !["queued", "running"].includes(current.status) ||
        (current.allocation_id && current.allocation_id !== input.allocation_id)
      )
        fail(409, "Job changed during allocation validation");
      ctx.store.put("apple_jobs", job.id, {
        ...current,
        status: "running",
        allocation_id: input.allocation_id,
        started_at: current.started_at ?? now(),
      });
      const credential = await sourceToken(
        ctx.env,
        ctx.workspaceId,
        job.repository,
      );
      if (ctx.store.get("apple_jobs", job.id)?.status !== "running")
        fail(409, "Job was cancelled");
      return json({
        job: {
          ...visible(current),
          attempt: job.attempt,
          source_token: credential,
        },
      });
    }
    if (method === "GET" && !agent[3])
      return json({ cancel: job.status !== "running" });
    if (!["running", "cancelling"].includes(job.status))
      fail(409, "Job is already finished");
    if (method === "PUT" && agent[3] === "artifact") {
      const length = Number(request.headers.get("content-length"));
      if (!Number.isSafeInteger(length) || length <= 0 || length > ARTIFACT_MAX)
        fail(413, "Artifact must be at most 100 MiB");
      if (!request.body) fail(400, "Artifact body required");
      const stream = new FixedLengthStream(length);
      const key = `apple-jobs/${ctx.workspaceId}/${job.id}/${job.attempt}.zip`;
      await Promise.all([
        ctx.env.ARTIFACTS.put(key, stream.readable, {
          httpMetadata: { contentType: "application/zip" },
        }),
        request.body.pipeTo(stream.writable),
      ]);
      const current = ctx.store.get("apple_jobs", job.id)!;
      if (!["running", "cancelling"].includes(current.status)) {
        await ctx.env.ARTIFACTS.delete(key);
        fail(409, "Job finished during upload");
      }
      ctx.store.put("apple_jobs", job.id, { ...current, artifact_key: key });
      return json({ ok: true });
    }
    if (method === "POST" && !agent[3]) {
      const result = await body(request);
      if (
        !["succeeded", "failed", "cancelled", "timed_out"].includes(
          result.status,
        ) ||
        typeof result.log !== "string" ||
        result.log.length > 65536
      )
        fail(400, "Invalid Apple job result");
      const current = ctx.store.get("apple_jobs", job.id)!;
      if (
        !["running", "cancelling"].includes(current.status) ||
        current.result_status
      )
        fail(409, "Job already finished");
      ctx.store.put("apple_jobs", job.id, {
        ...current,
        result_status: result.status,
        log: result.log,
      });
      await ctx.schedule(1000);
      ctx.event("apple-job.finished", `Apple ${job.action}: ${job.scheme}`);
      ctx.broadcast();
      return json({ ok: true });
    }
    fail(405, "Method not allowed");
  }
  requireUser(ctx);

  const p = ctx.store.get("projects", project![1]);
  if (!p) fail(404, "Project not found");
  if (!project![2] && method === "GET")
    return json({
      jobs: ctx.store
        .list("apple_jobs")
        .filter((j) => j.project_id === p.id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 100)
        .map(visible),
    });
  if (!project![2] && method === "POST") {
    const input = await body(request),
      spec = validateAppleJob(input),
      machine = ctx.store.get("machines", input.machine_id);
    if (!appleReady(machine))
      fail(
        409,
        "Choose a connected Mac with Apple jobs enabled and an available simulator",
      );
    if (
      !machine!.report.apple.simulators.some(
        (s: Doc) => s.id === spec.simulator,
      )
    )
      fail(400, "Choose an available simulator");
    if (!p.repository) fail(409, "Link a GitHub repository first");
    const credential = await sourceToken(
      ctx.env,
      ctx.workspaceId,
      p.repository,
    );
    const commit = await githubRequest<Doc>(
      credential,
      `/repos/${p.repository}/commits/${spec.commit}`,
    );
    if (commit.sha !== spec.commit) fail(400, "Commit could not be verified");
    if (
      ctx.store.get("projects", p.id)?.repository !== p.repository ||
      !appleReady(ctx.store.get("machines", input.machine_id))
    )
      fail(409, "Project or Mac changed while checking access");
    if (
      ctx.store.list("apple_jobs").filter((j) => ACTIVE.has(j.status)).length >=
      20
    )
      fail(409, "Workspace Apple job queue is full");
    const node = (await nodes(ctx)).find(
      (n) => n.Meta?.pc_machine_id === machine!.id && appleNode(n),
    );
    if (!node)
      fail(
        409,
        "Mac must be an eligible Nomad client with raw_exec and Apple support",
      );
    const currentProject = ctx.store.get("projects", p.id);
    if (
      currentProject?.repository !== p.repository ||
      currentProject?.status === "deleting" ||
      !appleReady(ctx.store.get("machines", machine!.id))
    )
      fail(409, "Project or Mac changed during Nomad validation");
    const jobId = id();
    const job: Doc = {
      id: jobId,
      nomad_job_id: `pc-apple-${jobId}`,
      node_id: node.ID,
      attempt: token(),
      project_id: p.id,
      repository: p.repository,
      machine_id: machine!.id,
      ...spec,
      status: "queued",
      created_at: now(),
    };
    job.nomad_spec = appleNomadJob(job, node, ctx.env.PUBLIC_URL);
    ctx.store.put("apple_jobs", job.id, job);
    await ctx.schedule(1);
    ctx.broadcast();
    return json(visible(job), 201);
  }
  const job = ctx.store.get("apple_jobs", project![2]);
  if (!job || job.project_id !== p.id) fail(404, "Apple job not found");
  if (project![3] && method === "GET") {
    if (!job.artifact_key) fail(404, "No artifact uploaded");
    const object = await ctx.env.ARTIFACTS.get(job.artifact_key);
    if (!object) fail(404, "Artifact no longer available");
    return new Response(object.body, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="apple-${job.id}.zip"`,
        "Cache-Control": "private, no-store",
      },
    });
  }
  if (!project![3] && method === "DELETE") {
    if (ACTIVE.has(job.status))
      ctx.store.put("apple_jobs", job.id, {
        ...job,
        status: "cancelling",
      });
    await ctx.schedule(1);
    ctx.broadcast();
    return json({ ok: true });
  }
  fail(405, "Method not allowed");
}
